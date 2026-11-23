-- Hashes de-duplicate Meta's exact replays. Completed receipts keep only
-- their hash and timestamps. A worker can reclaim an interrupted lease.
CREATE TABLE public.whatsapp_webhook_receipts (
  delivery_key TEXT PRIMARY KEY CHECK (delivery_key ~ '^[a-f0-9]{64}$'),
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

CREATE INDEX whatsapp_webhook_receipts_ready
  ON public.whatsapp_webhook_receipts (retry_at, received_at)
  WHERE payload IS NOT NULL AND failed_at IS NULL;
CREATE INDEX whatsapp_webhook_receipts_completed
  ON public.whatsapp_webhook_receipts (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX whatsapp_webhook_receipts_failed
  ON public.whatsapp_webhook_receipts (failed_at) WHERE failed_at IS NOT NULL;

ALTER TABLE public.whatsapp_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_webhook_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_webhook_receipts TO service_role;

CREATE FUNCTION public.claim_whatsapp_webhook_receipt(p_delivery_key TEXT DEFAULT NULL)
RETURNS SETOF public.whatsapp_webhook_receipts
LANGUAGE sql
SET search_path = ''
AS $$
  WITH pending AS (
    SELECT r.delivery_key
    FROM public.whatsapp_webhook_receipts r
    WHERE (p_delivery_key IS NULL OR r.delivery_key = p_delivery_key)
      AND r.payload IS NOT NULL AND r.failed_at IS NULL
      AND r.retry_at <= now()
      AND (r.lease_until IS NULL OR r.lease_until <= now())
    ORDER BY r.retry_at, r.received_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_webhook_receipts r
  SET lease_id = gen_random_uuid(), lease_until = now() + interval '2 minutes',
      attempts = r.attempts + 1
  FROM pending
  WHERE r.delivery_key = pending.delivery_key
  RETURNING r.*;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_webhook_receipt(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_webhook_receipt(TEXT) TO service_role;

-- Persist unread state and the first-inbound marker in the same transaction
-- as the message. The dispatch row allows a retry to pick up the work if
-- the original worker stopped before starting downstream actions.
CREATE TABLE public.whatsapp_inbound_dispatches (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  first_inbound BOOLEAN NOT NULL,
  new_contact BOOLEAN NOT NULL,
  new_conversation BOOLEAN NOT NULL,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

ALTER TABLE public.whatsapp_inbound_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_inbound_dispatches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_inbound_dispatches TO service_role;

CREATE FUNCTION public.persist_whatsapp_inbound(
  p_account_id UUID,
  p_message JSONB,
  p_preview TEXT,
  p_new_contact BOOLEAN,
  p_new_conversation BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_conversation public.conversations%ROWTYPE;
  v_message_id UUID;
  v_received_at TIMESTAMPTZ := (p_message->>'created_at')::timestamptz;
  v_conversation_id UUID := (p_message->>'conversation_id')::uuid;
BEGIN
  SELECT * INTO STRICT v_conversation FROM public.conversations
  WHERE id = v_conversation_id AND account_id = p_account_id FOR UPDATE;

  INSERT INTO public.messages (
    conversation_id, sender_type, content_type, content_text, media_url, media_type,
    message_id, status, created_at, reply_to_message_id, interactive_reply_id
  ) VALUES (
    v_conversation_id, 'customer', p_message->>'content_type', p_message->>'content_text',
    p_message->>'media_url', p_message->>'media_type', p_message->>'message_id', 'delivered',
    v_received_at, (p_message->>'reply_to_message_id')::uuid, p_message->>'interactive_reply_id'
  ) ON CONFLICT (conversation_id, message_id) DO NOTHING RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    SELECT id INTO v_message_id FROM public.messages
    WHERE conversation_id = v_conversation_id AND message_id = p_message->>'message_id';
    RETURN v_message_id;
  END IF;

  UPDATE public.conversations
  SET unread_count = coalesce(unread_count, 0) + 1,
      first_inbound_at = coalesce(first_inbound_at, v_received_at),
      last_message_text = CASE WHEN last_message_at IS NULL OR last_message_at <= v_received_at
        THEN p_preview ELSE last_message_text END,
      last_message_at = greatest(last_message_at, v_received_at),
      status = CASE WHEN status = 'closed' AND (closed_at IS NULL OR closed_at <= v_received_at)
        THEN 'open' ELSE status END
  WHERE id = v_conversation_id;

  INSERT INTO public.whatsapp_inbound_dispatches (message_id, first_inbound, new_contact, new_conversation)
  VALUES (v_message_id, v_conversation.first_inbound_at IS NULL, p_new_contact, p_new_conversation);
  RETURN v_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_whatsapp_inbound(UUID, JSONB, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_whatsapp_inbound(UUID, JSONB, TEXT, BOOLEAN, BOOLEAN) TO service_role;
