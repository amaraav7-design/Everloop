ALTER TABLE public.whatsapp_outbound_attempts ADD COLUMN callback_id UUID UNIQUE;

CREATE FUNCTION public.reconcile_outbound_callback(
  p_account UUID, p_callback UUID, p_wamid TEXT, p_status TEXT
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('sent','delivered','read','failed') THEN RETURN false; END IF;
  UPDATE public.whatsapp_outbound_attempts a SET
    provider_message_id = p_wamid,
    state = CASE
      WHEN a.state = 'saved' THEN 'saved'
      WHEN p_status = 'failed' AND a.state IN ('sending','uncertain') THEN 'rejected'
      WHEN p_status <> 'failed' THEN 'accepted'
      ELSE a.state
    END,
    updated_at = statement_timestamp()
  FROM public.conversations c
  WHERE a.callback_id = p_callback AND c.id = a.conversation_id AND c.account_id = p_account
    AND (a.provider_message_id IS NULL OR a.provider_message_id = p_wamid);
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_outbound_callback(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_outbound_callback(UUID, UUID, TEXT, TEXT) TO service_role;
