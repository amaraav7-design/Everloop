ALTER TABLE public.broadcasts
  ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (delivery_mode IN ('legacy', 'queue')),
  ADD COLUMN launch_key TEXT,
  ADD COLUMN launch_fingerprint TEXT,
  ADD COLUMN delivery_template_fingerprint TEXT,
  ADD COLUMN sender_phone_id TEXT,
  ADD COLUMN delivery_template_id UUID REFERENCES public.message_templates(id) ON DELETE SET NULL,
  ADD COLUMN draft_payload JSONB,
  ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN excluded_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN uncertain_count INTEGER NOT NULL DEFAULT 0,
  DROP CONSTRAINT broadcasts_status_check,
  ADD CONSTRAINT broadcasts_status_check CHECK (status IN
    ('draft', 'scheduled', 'queued', 'sending', 'paused', 'sent', 'partial', 'failed', 'canceled'));

ALTER TABLE public.broadcast_recipients
  ADD COLUMN reply_attribution TEXT CHECK (reply_attribution IN ('direct', 'inferred')),
  DROP CONSTRAINT broadcast_recipients_status_check,
  ADD CONSTRAINT broadcast_recipients_status_check CHECK (status IN
    ('pending', 'sent', 'delivered', 'read', 'replied', 'failed', 'excluded', 'uncertain', 'canceled'));

CREATE UNIQUE INDEX campaigns_launch_key ON public.broadcasts(account_id, launch_key)
  WHERE launch_key IS NOT NULL;
CREATE INDEX campaigns_dispatch_due ON public.broadcasts (scheduled_at, id)
  WHERE delivery_mode = 'queue' AND status IN ('scheduled', 'queued', 'sending');
CREATE INDEX campaigns_by_sender ON public.broadcasts (sender_phone_id, id) WHERE sender_phone_id IS NOT NULL;
CREATE INDEX campaigns_recipient_replies ON public.broadcast_recipients (contact_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;

CREATE TABLE public.campaign_delivery_jobs (
  recipient_id UUID PRIMARY KEY REFERENCES public.broadcast_recipients(id) ON DELETE CASCADE,
  broadcast_id UUID NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination ~ '^[1-9][0-9]{7,14}$'),
  send_params JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'dispatching', 'done', 'uncertain')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX campaign_jobs_pending ON public.campaign_delivery_jobs (broadcast_id, available_at, recipient_id)
  WHERE state = 'pending';
CREATE INDEX campaign_jobs_open ON public.campaign_delivery_jobs (broadcast_id, state, lease_until)
  WHERE state IN ('pending', 'leased', 'dispatching');
CREATE INDEX campaign_jobs_expiring ON public.campaign_delivery_jobs (lease_until)
  WHERE state IN ('leased', 'dispatching');

ALTER TABLE public.campaign_delivery_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_delivery_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_delivery_jobs TO service_role;

-- Browser mutations remain available for drafts and legacy runs only.
DROP POLICY broadcasts_insert ON public.broadcasts;
DROP POLICY broadcasts_update ON public.broadcasts;
DROP POLICY broadcasts_delete ON public.broadcasts;
CREATE POLICY broadcasts_insert ON public.broadcasts FOR INSERT TO authenticated WITH CHECK
  (delivery_mode = 'legacy' AND launch_key IS NULL AND public.is_account_member(account_id, 'agent'));
CREATE POLICY broadcasts_update ON public.broadcasts FOR UPDATE TO authenticated USING
  (delivery_mode = 'legacy' AND public.is_account_member(account_id, 'agent')) WITH CHECK
  (delivery_mode = 'legacy' AND launch_key IS NULL AND public.is_account_member(account_id, 'agent'));
CREATE POLICY broadcasts_delete ON public.broadcasts FOR DELETE TO authenticated USING
  (delivery_mode = 'legacy' AND public.is_account_member(account_id, 'agent'));
DROP POLICY broadcast_recipients_modify ON public.broadcast_recipients;
CREATE POLICY broadcast_recipients_modify ON public.broadcast_recipients FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM public.broadcasts b WHERE b.id = broadcast_id
    AND b.delivery_mode = 'legacy' AND public.is_account_member(b.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.broadcasts b WHERE b.id = broadcast_id
    AND b.delivery_mode = 'legacy' AND public.is_account_member(b.account_id, 'agent'))
);

CREATE FUNCTION public.campaign_consent_states(p_account UUID, p_keys TEXT[])
RETURNS TABLE(recipient_key TEXT, state TEXT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT input.key, latest.state
  FROM unnest(p_keys) AS input(key)
  LEFT JOIN LATERAL (
    SELECT c.state FROM public.whatsapp_marketing_consent_events c
    WHERE c.account_id = p_account AND c.recipient_key = input.key
    ORDER BY c.occurred_at DESC, c.state DESC, c.recorded_at DESC, c.id DESC LIMIT 1
  ) latest ON true;
$$;

CREATE FUNCTION public.enqueue_campaign(
  p_account UUID, p_user UUID, p_name TEXT, p_template UUID, p_template_fingerprint TEXT, p_when TIMESTAMPTZ,
  p_key TEXT, p_fingerprint TEXT, p_draft UUID, p_audience JSONB, p_variables JSONB,
  p_rejected INTEGER, p_recipients JSONB
) RETURNS public.broadcasts
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  campaign public.broadcasts%ROWTYPE;
  template public.message_templates%ROWTYPE;
  sender TEXT;
  total INTEGER := jsonb_array_length(p_recipients);
  run_at TIMESTAMPTZ := coalesce(p_when, statement_timestamp());
BEGIN
  IF p_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('campaign:' || p_account::text || ':' || p_key, 0));
    SELECT * INTO campaign FROM public.broadcasts WHERE account_id = p_account AND launch_key = p_key;
    IF FOUND THEN
      IF campaign.launch_fingerprint IS DISTINCT FROM p_fingerprint THEN
        RAISE EXCEPTION 'campaign_launch_conflict' USING ERRCODE = '23505';
      END IF;
      RETURN campaign;
    END IF;
  END IF;

  IF total IS NULL OR total NOT BETWEEN 1 AND 10000 OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_recipients) AS r(contact_id UUID)
    LEFT JOIN public.contacts c ON c.id = r.contact_id AND c.account_id = p_account
    WHERE c.id IS NULL
  ) THEN RAISE EXCEPTION 'invalid_campaign_recipients' USING ERRCODE = '22023'; END IF;

  SELECT * INTO template FROM public.message_templates
    WHERE id = p_template AND account_id = p_account AND status = 'APPROVED';
  SELECT phone_number_id INTO sender FROM public.whatsapp_config WHERE account_id = p_account;
  IF template.id IS NULL OR nullif(sender, '') IS NULL THEN
    RAISE EXCEPTION 'campaign_template_or_sender_unavailable' USING ERRCODE = '22023';
  END IF;

  IF p_draft IS NULL THEN
    INSERT INTO public.broadcasts(user_id, account_id, name, template_name, template_language,
      template_variables, audience_filter, status, scheduled_at, total_recipients, delivery_mode,
      sender_phone_id, delivery_template_id, delivery_template_fingerprint, launch_key, launch_fingerprint, rejected_count)
    VALUES (p_user, p_account, p_name, template.name, template.language,
      p_variables, p_audience, CASE WHEN p_when IS NULL THEN 'queued' ELSE 'scheduled' END, run_at,
      total, 'queue', sender, template.id, p_template_fingerprint, p_key, p_fingerprint, p_rejected)
    RETURNING * INTO campaign;
  ELSE
    UPDATE public.broadcasts SET name = p_name, template_name = template.name, template_language = template.language,
      template_variables = p_variables, audience_filter = p_audience,
      status = CASE WHEN p_when IS NULL THEN 'queued' ELSE 'scheduled' END, scheduled_at = run_at,
      total_recipients = total, delivery_mode = 'queue', sender_phone_id = sender,
      delivery_template_id = template.id, delivery_template_fingerprint = p_template_fingerprint, launch_key = p_key, launch_fingerprint = p_fingerprint,
      rejected_count = p_rejected, draft_payload = NULL
    WHERE id = p_draft AND account_id = p_account AND status = 'draft' AND delivery_mode = 'legacy'
      AND NOT EXISTS (SELECT 1 FROM public.broadcast_recipients WHERE broadcast_id = p_draft)
    RETURNING * INTO campaign;
    IF NOT FOUND THEN RAISE EXCEPTION 'campaign_draft_conflict' USING ERRCODE = '23505'; END IF;
  END IF;

  WITH input AS MATERIALIZED (
    SELECT gen_random_uuid() AS id, r.* FROM jsonb_to_recordset(p_recipients)
      AS r(contact_id UUID, destination TEXT, params JSONB, exclusion TEXT)
  ), recipients AS (
    INSERT INTO public.broadcast_recipients(id, broadcast_id, contact_id, status, template_params, error_message)
    SELECT id, campaign.id, contact_id, CASE WHEN exclusion IS NULL THEN 'pending' ELSE 'excluded' END,
      params, exclusion FROM input RETURNING id
  )
  INSERT INTO public.campaign_delivery_jobs(recipient_id, broadcast_id, destination, send_params)
  SELECT input.id, campaign.id, input.destination, input.params
  FROM input JOIN recipients USING (id) WHERE input.exclusion IS NULL;

  IF NOT FOUND THEN
    UPDATE public.broadcasts SET status = 'failed' WHERE id = campaign.id;
  END IF;
  SELECT * INTO campaign FROM public.broadcasts WHERE id = campaign.id;
  RETURN campaign;
END;
$$;

CREATE FUNCTION public.settle_campaign(p_id UUID)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  UPDATE public.broadcasts b SET status = CASE
    WHEN b.uncertain_count > 0 OR (b.sent_count > 0 AND b.failed_count + b.excluded_count > 0) THEN 'partial'
    WHEN b.sent_count > 0 THEN 'sent' ELSE 'failed' END
  WHERE b.id = p_id AND b.delivery_mode = 'queue'
    AND b.status IN ('scheduled', 'queued', 'sending', 'partial', 'sent', 'failed')
    AND NOT EXISTS (SELECT 1 FROM public.campaign_delivery_jobs j
      WHERE j.broadcast_id = b.id AND j.state IN ('pending', 'leased', 'dispatching'));
$$;

-- The lease is acquired before any external I/O. An expired lease that
-- crossed the dispatch boundary needs provider confirmation, never a replay.
CREATE FUNCTION public.claim_campaign_job(p_accounts UUID[] DEFAULT NULL)
RETURNS TABLE (recipient_id UUID, broadcast_id UUID, account_id UUID, sender_phone_id TEXT,
  template_id UUID, template_name TEXT, template_language TEXT, template_fingerprint TEXT, destination TEXT, send_params JSONB,
  lease_id UUID, attempts INTEGER)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  campaign public.broadcasts%ROWTYPE;
  stale RECORD;
  claimed public.campaign_delivery_jobs%ROWTYPE;
BEGIN
  FOR stale IN
    SELECT b.id FROM public.broadcasts b
    WHERE b.delivery_mode = 'queue' AND EXISTS (
      SELECT 1 FROM public.campaign_delivery_jobs j WHERE j.broadcast_id = b.id
        AND j.state IN ('leased', 'dispatching') AND j.lease_until < statement_timestamp()
    ) AND (p_accounts IS NULL OR b.account_id = ANY(p_accounts))
    LIMIT 20 FOR UPDATE OF b SKIP LOCKED
  LOOP
    WITH expired AS (
      UPDATE public.campaign_delivery_jobs j SET
        state = CASE WHEN j.state = 'dispatching' THEN 'uncertain' ELSE 'pending' END,
        lease_id = NULL, lease_until = NULL
      WHERE j.broadcast_id = stale.id AND j.state IN ('leased', 'dispatching')
        AND j.lease_until < statement_timestamp() RETURNING j.recipient_id, j.state
    )
    UPDATE public.broadcast_recipients r SET status = 'uncertain', error_message = 'delivery_uncertain'
    FROM expired e WHERE r.id = e.recipient_id AND e.state = 'uncertain' AND r.status = 'pending';
    PERFORM public.settle_campaign(stale.id);
  END LOOP;

  FOR campaign IN
    SELECT b.* FROM public.broadcasts b
    WHERE b.delivery_mode = 'queue' AND b.status IN ('scheduled', 'queued', 'sending')
      AND b.scheduled_at <= statement_timestamp() AND (p_accounts IS NULL OR b.account_id = ANY(p_accounts))
      AND EXISTS (SELECT 1 FROM public.campaign_delivery_jobs j WHERE j.broadcast_id = b.id
        AND j.state = 'pending' AND j.available_at <= statement_timestamp())
    ORDER BY b.scheduled_at, b.id LIMIT 30 FOR UPDATE OF b SKIP LOCKED
  LOOP
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('campaign-sender:' || campaign.sender_phone_id, 0));
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.campaign_delivery_jobs j JOIN public.broadcasts b ON b.id = j.broadcast_id
      WHERE b.sender_phone_id = campaign.sender_phone_id AND
        (j.state IN ('leased', 'dispatching') OR
         (j.state = 'pending' AND j.attempts > 0 AND j.available_at > statement_timestamp()))
    );
    UPDATE public.campaign_delivery_jobs j SET state = 'leased', lease_id = gen_random_uuid(),
      lease_until = statement_timestamp() + interval '90 seconds'
    WHERE j.recipient_id = (
      SELECT q.recipient_id FROM public.campaign_delivery_jobs q WHERE q.broadcast_id = campaign.id
        AND q.state = 'pending' AND q.available_at <= statement_timestamp()
      ORDER BY q.available_at, q.recipient_id LIMIT 1
    ) RETURNING * INTO claimed;
    IF FOUND THEN
      UPDATE public.broadcasts SET status = 'sending' WHERE id = campaign.id AND status <> 'sending';
      RETURN QUERY SELECT claimed.recipient_id, campaign.id, campaign.account_id, campaign.sender_phone_id,
        campaign.delivery_template_id, campaign.template_name, campaign.template_language, campaign.delivery_template_fingerprint, claimed.destination,
        claimed.send_params, claimed.lease_id, claimed.attempts;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.begin_campaign_dispatch(p_recipient UUID, p_lease UUID)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE campaign public.broadcasts%ROWTYPE;
BEGIN
  SELECT b.* INTO campaign FROM public.broadcasts b JOIN public.campaign_delivery_jobs j ON j.broadcast_id = b.id
    WHERE j.recipient_id = p_recipient FOR UPDATE OF b;
  IF NOT FOUND THEN RETURN false; END IF;
  IF campaign.status = 'paused' THEN
    UPDATE public.campaign_delivery_jobs SET state = 'pending', lease_id = NULL, lease_until = NULL
      WHERE recipient_id = p_recipient AND lease_id = p_lease AND state = 'leased';
    RETURN false;
  END IF;
  IF campaign.status <> 'sending' THEN RETURN false; END IF;
  UPDATE public.campaign_delivery_jobs SET state = 'dispatching', attempts = attempts + 1
    WHERE recipient_id = p_recipient AND lease_id = p_lease AND state = 'leased'
      AND lease_until > statement_timestamp();
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.finish_campaign_job(
  p_recipient UUID, p_lease UUID, p_result TEXT, p_reason TEXT, p_wamid TEXT DEFAULT NULL, p_retry_seconds INTEGER DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE campaign public.broadcasts%ROWTYPE;
BEGIN
  SELECT b.* INTO campaign FROM public.broadcasts b JOIN public.campaign_delivery_jobs j ON j.broadcast_id = b.id
    WHERE j.recipient_id = p_recipient FOR UPDATE OF b;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_result = 'retry' AND campaign.status = 'canceled' THEN
    p_result := 'canceled';
  END IF;
  UPDATE public.campaign_delivery_jobs SET
    state = CASE p_result WHEN 'retry' THEN 'pending' WHEN 'uncertain' THEN 'uncertain' ELSE 'done' END,
    lease_id = NULL, lease_until = NULL,
    available_at = statement_timestamp() + make_interval(secs => coalesce(p_retry_seconds, 0))
  WHERE recipient_id = p_recipient AND lease_id = p_lease AND state IN ('leased', 'dispatching');
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_result <> 'retry' THEN
    UPDATE public.broadcast_recipients SET status = p_result, error_message = p_reason,
      sent_at = CASE WHEN p_result = 'sent' THEN coalesce(sent_at, statement_timestamp()) ELSE sent_at END,
      whatsapp_message_id = coalesce(whatsapp_message_id, p_wamid)
    WHERE id = p_recipient AND status = 'pending';
    PERFORM public.settle_campaign(campaign.id);
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.control_campaign(p_account UUID, p_id UUID, p_action TEXT)
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE next_status TEXT;
BEGIN
  UPDATE public.broadcasts SET status = CASE p_action
    WHEN 'pause' THEN 'paused'
    WHEN 'cancel' THEN 'canceled'
    WHEN 'resume' THEN CASE WHEN scheduled_at > statement_timestamp() THEN 'scheduled' ELSE 'queued' END
  END
  WHERE account_id = p_account AND id = p_id AND delivery_mode = 'queue' AND (
    (p_action = 'pause' AND status IN ('queued', 'scheduled', 'sending')) OR
    (p_action = 'resume' AND status = 'paused') OR
    (p_action = 'cancel' AND status IN ('queued', 'scheduled', 'sending', 'paused'))
  ) RETURNING status INTO next_status;
  IF next_status = 'canceled' THEN
    WITH canceled AS (
      UPDATE public.campaign_delivery_jobs SET state = 'done', lease_id = NULL, lease_until = NULL
      WHERE broadcast_id = p_id AND state IN ('pending', 'leased') RETURNING recipient_id
    )
    UPDATE public.broadcast_recipients r SET status = 'canceled'
    FROM canceled c WHERE r.id = c.recipient_id AND r.status = 'pending';
  ELSIF p_action = 'resume' AND next_status IS NOT NULL THEN
    PERFORM public.settle_campaign(p_id);
    SELECT status INTO next_status FROM public.broadcasts WHERE id = p_id;
  END IF;
  RETURN next_status;
END;
$$;

-- Replies and read receipts are independent, including out-of-order receipts.
CREATE FUNCTION public.campaign_recipient_counts(r public.broadcast_recipients)
RETURNS integer[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT ARRAY[
    (r.sent_at IS NOT NULL OR r.delivered_at IS NOT NULL OR r.read_at IS NOT NULL
      OR r.status IN ('sent', 'delivered', 'read', 'replied'))::int,
    (r.delivered_at IS NOT NULL OR r.read_at IS NOT NULL OR r.status IN ('delivered', 'read'))::int,
    (r.read_at IS NOT NULL OR r.status = 'read')::int,
    (r.replied_at IS NOT NULL OR r.status = 'replied')::int,
    (r.status = 'failed')::int,
    (r.status = 'excluded')::int,
    (r.status = 'uncertain')::int
  ];
$$;

CREATE OR REPLACE FUNCTION public.broadcast_recipient_aggregate_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  before_count INTEGER[] := ARRAY[0,0,0,0,0,0,0];
  after_count INTEGER[] := ARRAY[0,0,0,0,0,0,0];
  parent UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.broadcast_id ELSE NEW.broadcast_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.broadcast_id <> NEW.broadcast_id THEN
    RAISE EXCEPTION 'A campaign recipient cannot be moved';
  END IF;
  IF TG_OP <> 'INSERT' THEN before_count := public.campaign_recipient_counts(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_count := public.campaign_recipient_counts(NEW); END IF;
  IF before_count <> after_count THEN
    UPDATE public.broadcasts SET
      sent_count = greatest(0, coalesce(sent_count, 0) + after_count[1] - before_count[1]),
      delivered_count = greatest(0, coalesce(delivered_count, 0) + after_count[2] - before_count[2]),
      read_count = greatest(0, coalesce(read_count, 0) + after_count[3] - before_count[3]),
      replied_count = greatest(0, coalesce(replied_count, 0) + after_count[4] - before_count[4]),
      failed_count = greatest(0, coalesce(failed_count, 0) + after_count[5] - before_count[5]),
      excluded_count = greatest(0, excluded_count + after_count[6] - before_count[6]),
      uncertain_count = greatest(0, uncertain_count + after_count[7] - before_count[7])
    WHERE id = parent;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_broadcast_counts(bid UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.broadcasts b SET
    sent_count = coalesce(a.sent, 0), delivered_count = coalesce(a.delivered, 0),
    read_count = coalesce(a.read, 0), replied_count = coalesce(a.replied, 0),
    failed_count = coalesce(a.failed, 0), excluded_count = coalesce(a.excluded, 0),
    uncertain_count = coalesce(a.uncertain, 0)
  FROM (SELECT sum(n[1]) AS sent, sum(n[2]) AS delivered, sum(n[3]) AS read, sum(n[4]) AS replied,
    sum(n[5]) AS failed, sum(n[6]) AS excluded, sum(n[7]) AS uncertain
    FROM (SELECT public.campaign_recipient_counts(r) AS n FROM public.broadcast_recipients r
      WHERE r.broadcast_id = bid) counts) a
  WHERE b.id = bid;
$$;
SELECT public.recompute_broadcast_counts(id) FROM public.broadcasts WHERE replied_count > 0;

-- A status callback can settle a timed out send using Meta's echoed opaque ID.
CREATE FUNCTION public.reconcile_campaign_callback(
  p_account UUID, p_recipient UUID, p_wamid TEXT, p_status TEXT, p_at TIMESTAMPTZ, p_error TEXT
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE campaign public.broadcasts%ROWTYPE;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN RETURN false; END IF;
  SELECT b.* INTO campaign FROM public.broadcasts b JOIN public.campaign_delivery_jobs j ON j.broadcast_id = b.id
    WHERE j.recipient_id = p_recipient AND b.account_id = p_account FOR UPDATE OF b;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.campaign_delivery_jobs j WHERE j.recipient_id = p_recipient
      AND j.state IN ('dispatching', 'done', 'uncertain') AND j.attempts > 0) THEN RETURN false; END IF;

  UPDATE public.broadcast_recipients r SET
    whatsapp_message_id = p_wamid,
    sent_at = CASE WHEN p_status <> 'failed' THEN coalesce(r.sent_at, p_at) ELSE r.sent_at END,
    delivered_at = CASE WHEN p_status IN ('delivered', 'read') THEN coalesce(r.delivered_at, p_at) ELSE r.delivered_at END,
    read_at = CASE WHEN p_status = 'read' THEN coalesce(r.read_at, p_at) ELSE r.read_at END,
    status = CASE
      WHEN r.status = 'read' OR p_status = 'read' THEN 'read'
      WHEN r.status = 'delivered' OR p_status = 'delivered' THEN 'delivered'
      WHEN p_status = 'failed' OR r.status = 'failed' THEN 'failed'
      ELSE 'sent'
    END,
    error_message = CASE WHEN p_status = 'failed' AND r.status NOT IN ('delivered', 'read') THEN p_error
      WHEN p_status = 'sent' AND r.status = 'failed' THEN r.error_message ELSE NULL END
  WHERE r.id = p_recipient AND (r.whatsapp_message_id IS NULL OR r.whatsapp_message_id = p_wamid);
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.campaign_delivery_jobs SET state = 'done', lease_id = NULL, lease_until = NULL
    WHERE recipient_id = p_recipient AND state <> 'done';
  PERFORM public.settle_campaign(campaign.id);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.campaign_consent_states(UUID, TEXT[]),
  public.enqueue_campaign(UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, JSONB, JSONB, INTEGER, JSONB),
  public.settle_campaign(UUID), public.claim_campaign_job(UUID[]), public.begin_campaign_dispatch(UUID, UUID),
  public.finish_campaign_job(UUID, UUID, TEXT, TEXT, TEXT, INTEGER), public.control_campaign(UUID, UUID, TEXT),
  public.reconcile_campaign_callback(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_consent_states(UUID, TEXT[]),
  public.enqueue_campaign(UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, JSONB, JSONB, INTEGER, JSONB),
  public.claim_campaign_job(UUID[]), public.begin_campaign_dispatch(UUID, UUID),
  public.finish_campaign_job(UUID, UUID, TEXT, TEXT, TEXT, INTEGER), public.control_campaign(UUID, UUID, TEXT),
  public.reconcile_campaign_callback(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_campaign(UUID) TO service_role;

CREATE FUNCTION public.record_campaign_reply(
  p_account UUID, p_contact UUID, p_at TIMESTAMPTZ, p_context TEXT
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  target UUID;
  parent UUID;
BEGIN
  SELECT r.id, b.id INTO target, parent
  FROM public.broadcast_recipients r JOIN public.broadcasts b ON b.id = r.broadcast_id
  WHERE b.account_id = p_account AND r.contact_id = p_contact
    AND ((p_context IS NOT NULL AND r.whatsapp_message_id = p_context AND r.status IN ('sent','delivered','read','replied'))
      OR (p_context IS NULL AND r.status IN ('sent','delivered','read','replied')
        AND r.sent_at BETWEEN p_at - interval '7 days' AND p_at))
  ORDER BY r.sent_at DESC NULLS LAST, r.id LIMIT 1;
  IF target IS NULL THEN RETURN false; END IF;

  PERFORM 1 FROM public.broadcasts WHERE id = parent FOR UPDATE;
  UPDATE public.broadcast_recipients SET replied_at = coalesce(replied_at, p_at),
    reply_attribution = CASE WHEN p_context IS NOT NULL THEN 'direct' ELSE 'inferred' END
  WHERE id = target AND (replied_at IS NULL OR (p_context IS NOT NULL AND reply_attribution IS DISTINCT FROM 'direct'));
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.record_campaign_reply(UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_campaign_reply(UUID, UUID, TIMESTAMPTZ, TEXT) TO service_role;
