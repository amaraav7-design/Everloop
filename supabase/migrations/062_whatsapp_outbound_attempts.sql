CREATE TABLE public.whatsapp_outbound_attempts (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('sending', 'rejected', 'uncertain', 'accepted', 'saved')),
  provider_message_id TEXT,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, request_key)
);

ALTER TABLE public.whatsapp_outbound_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_outbound_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_outbound_attempts TO service_role;
