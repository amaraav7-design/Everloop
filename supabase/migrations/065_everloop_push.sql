CREATE TABLE public.everloop_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX everloop_push_by_member ON public.everloop_push_subscriptions (user_id, account_id, updated_at DESC);
ALTER TABLE public.everloop_push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.everloop_push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.everloop_push_subscriptions TO service_role;

CREATE FUNCTION public.revoke_everloop_push_on_membership_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.account_role IS DISTINCT FROM NEW.account_role THEN
    DELETE FROM public.everloop_push_subscriptions WHERE user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_everloop_push_on_membership_change() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER revoke_everloop_push_on_membership_change
  AFTER UPDATE OF account_id, account_role OR DELETE ON public.profiles FOR EACH ROW
  EXECUTE FUNCTION public.revoke_everloop_push_on_membership_change();
