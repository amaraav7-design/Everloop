CREATE INDEX IF NOT EXISTS inbox_recent_conversations
  ON public.conversations (account_id, (coalesce(last_message_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS inbox_unread_conversations
  ON public.conversations (account_id, (coalesce(last_message_at, created_at)) DESC, id DESC)
  WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS inbox_contacts_company ON public.contacts (account_id, (btrim(company)))
  WHERE company IS NOT NULL AND btrim(company) <> '';

-- Security invoker retains the caller's conversation, contact and tag
-- policies. The explicit account predicate supplies the index prefix.
CREATE FUNCTION public.inbox_conversation_page(
  p_account UUID, p_filter TEXT, p_search TEXT, p_tags UUID[], p_company TEXT,
  p_cursor_at TIMESTAMPTZ, p_cursor_id UUID
) RETURNS TABLE(conversation JSONB, cursor_at TIMESTAMPTZ)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH input AS (
    SELECT p_filter IN ('waiting', 'expiring') AS oldest_first,
      '%' || replace(replace(replace(left(btrim(coalesce(p_search, '')), 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
  ), chosen AS MATERIALIZED (
    SELECT c.*, ordering.sort_at, f.oldest_first
    FROM public.conversations c
    JOIN public.contacts contact ON contact.id = c.contact_id AND contact.account_id = c.account_id
    CROSS JOIN input f
    CROSS JOIN LATERAL (SELECT CASE WHEN f.oldest_first THEN c.last_inbound_at ELSE coalesce(c.last_message_at, c.created_at) END AS sort_at) ordering
    WHERE c.account_id = p_account
      AND (f.pattern = '%%' OR contact.name ILIKE f.pattern OR contact.phone ILIKE f.pattern OR c.last_message_text ILIKE f.pattern)
      AND (p_company IS NULL OR btrim(contact.company) = p_company)
      AND (coalesce(cardinality(p_tags), 0) = 0 OR EXISTS (
        SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = c.contact_id AND ct.tag_id = ANY(p_tags)
      ))
      AND CASE p_filter
        WHEN 'all' THEN true
        WHEN 'unread' THEN c.unread_count > 0
        WHEN 'unassigned' THEN c.status = 'open' AND c.assigned_agent_id IS NULL
        WHEN 'waiting' THEN c.status <> 'closed' AND c.last_inbound_at IS NOT NULL AND
          (c.last_reply_at IS NULL OR c.last_reply_at < c.last_inbound_at)
        WHEN 'expiring' THEN c.status <> 'closed' AND c.last_inbound_at > statement_timestamp() - interval '24 hours'
          AND c.last_inbound_at <= statement_timestamp() - interval '22 hours'
          AND (c.last_reply_at IS NULL OR c.last_reply_at < c.last_inbound_at)
        ELSE c.status = p_filter
      END
      AND (p_cursor_id IS NULL OR CASE WHEN f.oldest_first
        THEN (ordering.sort_at, c.id) > (p_cursor_at, p_cursor_id)
        ELSE (ordering.sort_at, c.id) < (p_cursor_at, p_cursor_id) END)
    ORDER BY CASE WHEN f.oldest_first THEN ordering.sort_at END ASC,
      CASE WHEN f.oldest_first THEN c.id END ASC, ordering.sort_at DESC, c.id DESC LIMIT 51
  )
  SELECT (to_jsonb(c) - ARRAY['sort_at','oldest_first']) || jsonb_build_object('contact',
    to_jsonb(contact) || jsonb_build_object('tags', coalesce(tags.value, '[]'::jsonb))), c.sort_at
  FROM chosen c JOIN public.contacts contact ON contact.id = c.contact_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name, t.id) AS value FROM public.contact_tags ct
      JOIN public.tags t ON t.id = ct.tag_id WHERE ct.contact_id = contact.id
  ) tags ON true
  ORDER BY CASE WHEN c.oldest_first THEN c.sort_at END ASC,
    CASE WHEN c.oldest_first THEN c.id END ASC, c.sort_at DESC, c.id DESC;
$$;

CREATE FUNCTION public.inbox_companies(p_account UUID)
RETURNS TABLE(company TEXT) LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT DISTINCT btrim(c.company) AS company FROM public.contacts c
  WHERE c.account_id = p_account AND c.company IS NOT NULL AND btrim(c.company) <> ''
    AND EXISTS (SELECT 1 FROM public.conversations v WHERE v.account_id = p_account AND v.contact_id = c.id)
  ORDER BY company LIMIT 500;
$$;

REVOKE ALL ON FUNCTION public.inbox_conversation_page(UUID, TEXT, TEXT, UUID[], TEXT, TIMESTAMPTZ, UUID),
  public.inbox_companies(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(UUID, TEXT, TEXT, UUID[], TEXT, TIMESTAMPTZ, UUID),
  public.inbox_companies(UUID) TO authenticated;
