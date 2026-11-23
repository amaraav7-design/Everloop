ALTER TABLE public.ai_configs DROP CONSTRAINT ai_configs_provider_check,
  ADD CONSTRAINT ai_configs_provider_check CHECK (provider IN
    ('openai', 'anthropic', 'openai_compatible', 'openrouter', 'google_ai_studio'));
ALTER TABLE public.ai_usage_log DROP CONSTRAINT ai_usage_log_provider_check,
  ADD CONSTRAINT ai_usage_log_provider_check CHECK (provider IN
    ('openai', 'anthropic', 'openai_compatible', 'openrouter', 'google_ai_studio'));

CREATE TABLE public.ai_provider_connections (
  account_id UUID REFERENCES public.ai_configs(account_id) ON DELETE CASCADE,
  provider TEXT CHECK (provider IN ('openrouter', 'google_ai_studio')),
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  free_only BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(account_id, provider)
);
ALTER TABLE public.ai_provider_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_provider_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_provider_connections TO service_role;

-- Offer known existing keys in the provider picker without changing the
-- running custom integration or reclassifying its billing or privacy.
INSERT INTO public.ai_provider_connections(account_id, provider, api_key, model, free_only)
SELECT account_id,
  CASE WHEN base_url ~* '^https://openrouter[.]ai/' THEN 'openrouter' ELSE 'google_ai_studio' END,
  api_key, model, base_url !~* '^https://openrouter[.]ai/' OR model = 'openrouter/free' OR model LIKE '%:free'
FROM public.ai_configs
WHERE provider = 'openai_compatible' AND api_key <> '' AND
  lower(rtrim(base_url, '/')) IN (
    'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  );

CREATE FUNCTION public.save_ai_provider_connection(
  p_account UUID, p_user UUID, p_provider TEXT, p_model TEXT, p_key TEXT, p_free_only BOOLEAN, p_config JSONB
) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.ai_configs(account_id, created_by, provider, model, api_key,
    system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation,
    handoff_agent_id, embeddings_api_key)
  VALUES (p_account, p_user, p_provider, p_model, '', p_config->>'system_prompt',
    (p_config->>'is_active')::boolean AND p_provider <> 'google_ai_studio',
    (p_config->>'auto_reply_enabled')::boolean AND p_provider <> 'google_ai_studio',
    (p_config->>'auto_reply_max_per_conversation')::integer,
    (p_config->>'handoff_agent_id')::UUID, p_config->>'embeddings_api_key')
  ON CONFLICT(account_id) DO UPDATE SET
    provider = EXCLUDED.provider, model = EXCLUDED.model, base_url = NULL,
    system_prompt = EXCLUDED.system_prompt, is_active = EXCLUDED.is_active,
    auto_reply_enabled = EXCLUDED.auto_reply_enabled,
    auto_reply_max_per_conversation = EXCLUDED.auto_reply_max_per_conversation,
    handoff_agent_id = CASE WHEN p_config ? 'handoff_agent_id' THEN EXCLUDED.handoff_agent_id ELSE ai_configs.handoff_agent_id END,
    embeddings_api_key = CASE WHEN p_config ? 'embeddings_api_key' THEN EXCLUDED.embeddings_api_key ELSE ai_configs.embeddings_api_key END;

  IF p_key IS NOT NULL THEN
    INSERT INTO public.ai_provider_connections(account_id, provider, api_key, model, free_only)
    VALUES (p_account, p_provider, p_key, p_model, p_free_only)
    ON CONFLICT(account_id, provider) DO UPDATE SET api_key = EXCLUDED.api_key,
      model = EXCLUDED.model, free_only = EXCLUDED.free_only, updated_at = statement_timestamp();
  ELSE
    UPDATE public.ai_provider_connections SET model = p_model, free_only = p_free_only, updated_at = statement_timestamp()
      WHERE account_id = p_account AND provider = p_provider;
    IF NOT FOUND THEN RAISE EXCEPTION 'AI connection key is required' USING ERRCODE = '22023'; END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.save_ai_provider_connection(UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_ai_provider_connection(UUID, UUID, TEXT, TEXT, TEXT, BOOLEAN, JSONB) TO service_role;

ALTER TABLE public.ai_usage_log ADD COLUMN outcome TEXT NOT NULL DEFAULT 'generated'
  CHECK (outcome IN ('generated', 'rate_limited', 'provider_error'));

ALTER TABLE public.conversations ADD COLUMN ai_last_reply_to TEXT;
CREATE FUNCTION public.claim_managed_ai_reply(
  p_account UUID, p_conversation UUID, p_inbound TEXT, p_max INTEGER
) RETURNS boolean LANGUAGE sql SET search_path = public AS $$
  WITH latest AS (
    SELECT m.message_id, m.created_at FROM public.messages m
    WHERE m.conversation_id = p_conversation AND m.sender_type = 'customer'
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  ), claimed AS (
    UPDATE public.conversations c SET ai_reply_count = ai_reply_count + 1, ai_last_reply_to = p_inbound
    FROM latest l WHERE c.account_id = p_account AND c.id = p_conversation AND l.message_id = p_inbound
      AND c.ai_reply_count < p_max AND c.ai_last_reply_to IS DISTINCT FROM p_inbound
      AND c.last_inbound_at > statement_timestamp() - interval '24 hours'
      AND NOT c.ai_autoreply_disabled AND c.assigned_agent_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = c.id
        AND m.sender_type = 'agent' AND m.created_at >= l.created_at)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
REVOKE ALL ON FUNCTION public.claim_managed_ai_reply(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_managed_ai_reply(UUID, UUID, TEXT, INTEGER) TO service_role;
