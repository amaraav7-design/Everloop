"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

export function useTotalUnread(): number {
  const { accountId } = useAuth();
  const [count, setCount] = useState<{ accountId: string; total: number } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let timer: number | undefined;
    let controller: AbortController | null = null;

    async function refresh() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const { count: total, error } = await supabase.from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId).gt("unread_count", 0).abortSignal(request.signal);
      if (!request.signal.aborted && !error) setCount({ accountId: accountId!, total: total ?? 0 });
    }
    function schedule() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 300);
    }
    void refresh();
    const channel = supabase.channel("total-unread-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `account_id=eq.${accountId}` }, schedule)
      .subscribe(status => { if (status === "SUBSCRIBED") schedule(); });
    window.addEventListener("focus", schedule);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", schedule);
      void supabase.removeChannel(channel);
    };
  }, [accountId]);
  return count?.accountId === accountId ? count.total : 0;
}
