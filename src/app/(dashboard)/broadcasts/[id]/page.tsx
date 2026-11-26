'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  PlayCircle,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
  RECIPIENT_STATUSES,
} from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { fetchAllPages } from '@/lib/supabase/paged-query';

const RECIPIENT_PAGE_SIZE = 50;

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const t = useTranslations('Broadcasts.detail');
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">{t('funnel')}</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.round((step.value / max) * 100);
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color}`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}



/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const broadcastId = params.id as string;
  const { accountRole: role } = useAuth();
  const canManage = role !== null && role !== 'viewer';

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [recipientPage, setRecipientPage] = useState(0);
  const [recipientCount, setRecipientCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [campaignAction, setCampaignAction] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resumingScope, setResumingScope] = useState<
    'pending' | 'failed' | null
  >(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    const db = createClient();
    const from = recipientPage * RECIPIENT_PAGE_SIZE;
    let list = db.from('broadcast_recipients').select('*, contact:contacts(name,phone)', { count: 'exact' })
      .eq('broadcast_id', broadcastId).order('id').range(from, from + RECIPIENT_PAGE_SIZE - 1);
    if (statusFilter === 'replied') list = list.not('replied_at', 'is', null);
    else if (statusFilter !== 'all') list = list.eq('status', statusFilter);
    const campaign = db.from('broadcasts').select('*').eq('id', broadcastId);
    const pending = db.from('broadcast_recipients').select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId).eq('status', 'pending');
    try {
      const [parent, page, backlog] = await Promise.all([
        (signal ? campaign.abortSignal(signal) : campaign).single(),
        signal ? list.abortSignal(signal) : list,
        signal ? pending.abortSignal(signal) : pending,
      ]);
      if (signal?.aborted) return;
      if (parent.error || page.error || backlog.error) throw new Error(t('notFound'));
      setBroadcast(parent.data);
      setRecipients(page.data ?? []);
      setRecipientCount(page.count ?? 0);
      setPendingCount(backlog.count ?? 0);
      if (from > 0 && from >= (page.count ?? 0)) setRecipientPage(0);
      setError(null);
    } catch (error) {
      if (!signal?.aborted) setError(error instanceof Error ? error.message : t('notFound'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [broadcastId, recipientPage, statusFilter, t]);

  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    const refresh = async () => {
      if (active || document.visibilityState === 'hidden') return;
      active = true;
      try { await fetchData(controller.signal); } finally { active = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 8000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [fetchData]);

  function filterRecipients(filter: RecipientStatus | 'all') {
    setStatusFilter(filter);
    setRecipientPage(0);
  }

  async function control(action: 'pause' | 'resume' | 'cancel') {
    setCampaignAction(action);
    try {
      const res = await fetch(`/api/whatsapp/campaigns/${broadcastId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setConfirmCancel(false);
      await fetchData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('control.error'));
    } finally {
      setCampaignAction(null);
    }
  }

  async function handleExport() {
    if (!broadcast || exporting) return;
    setExporting(true);
    try {
      const supabase = createClient();
      const exportRows = await fetchAllPages<BroadcastRecipient>((from, to) => supabase
        .from('broadcast_recipients').select('*, contact:contacts(name,phone)')
        .eq('broadcast_id', broadcastId).order('id').range(from, to));
    const header = [
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('control.reply'),
      t('control.attribution'),
      t('table.error'),
    ];
    const rows = exportRows.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.replied_at ?? '',
      r.reply_attribution ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
      downloadBlob(`campaign-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
    } catch {
      toast.error(t('control.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  /**
   * Hand the leftovers to the server (issue #472).
   *
   * The wizard's send loop lives in the tab that started the campaign,
   * so navigating away strands the rest as 'pending' with the broadcast
   * stuck 'sending'. This is the recovery, and the same call retries
   * failed recipients.
   */
  async function handleResume(scope: 'pending' | 'failed') {
    setResumingScope(scope);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(
          t('toastResumeFailed', {
            error: payload?.error || `HTTP ${res.status}`,
          }),
        );
        return;
      }

      toast.success(
        payload.remaining > 0
          ? t('toastResumeStartedCapped', {
              count: payload.resuming,
              remaining: payload.remaining,
            })
          : t('toastResumeStarted', { count: payload.resuming }),
      );
      // Delivery runs server-side after the 202, so the counts here are
      // a snapshot — reload to pick up the first of it.
      await fetchData();
    } catch (err) {
      toast.error(
        t('toastResumeFailed', {
          error: err instanceof Error ? err.message : t('unknownError'),
        }),
      );
    } finally {
      setResumingScope(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(t('toastFailedDelete', { error: delErr.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          {t('backToBroadcasts')}
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  const queuedDelivery = broadcast.delivery_mode === 'queue';
  const controllable = queuedDelivery && ['queued', 'scheduled', 'sending', 'paused'].includes(broadcast.status);
  const retryableCount = broadcast.failed_count;
  const isStalled = !queuedDelivery && broadcast.status === 'sending' && pendingCount > 0;

  const funnelSteps: FunnelStep[] = [
    { label: t('stats.sent'), value: broadcast.sent_count, color: 'bg-primary' },
    { label: t('stats.delivered'), value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: t('stats.read'), value: broadcast.read_count, color: 'bg-blue-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {tStatus(status.label)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>{t('template', { name: broadcast.template_name })}</span>
              <span>-</span>
              <span>
                {t('createdAt', { date: new Date(broadcast.created_at).toLocaleDateString() })}
              </span>
            </div>
          </div>
        </div>

        {/* Delete — inline-confirm pattern matches the pipeline-settings
            "Delete Pipeline" flow. Mid-send broadcasts can't be deleted
            because orphaning in-flight Meta messages would leave the
            funnel inconsistent. */}
        {canManage && !queuedDelivery && (confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
            <span className="text-red-300">{t('deletePrompt')}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? t('deleting') : t('confirm')}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={broadcast.status === 'sending'}
            onClick={() => setConfirmDelete(true)}
            title={
              broadcast.status === 'sending'
                ? t('cannotDeleteSending')
                : t('deleteHover')
            }
            className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        ))}
      </div>

      {/* Resume / retry (issue #472). Only rendered when there is
          actually something outstanding. */}
      {queuedDelivery && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {broadcast.scheduled_at && <span>{t('control.scheduledFor', { date: new Date(broadcast.scheduled_at).toLocaleString() })}</span>}
            <span>{t('control.pending', { count: pendingCount })}</span>
            <span>{t('control.excluded', { count: broadcast.excluded_count ?? 0 })}</span>
            {(broadcast.uncertain_count ?? 0) > 0 && <span>{t('control.uncertain', { count: broadcast.uncertain_count ?? 0 })}</span>}
          </div>
          {canManage && controllable && (
            <div className="flex flex-wrap items-center gap-2">
              {confirmCancel ? (
                <>
                  <p className="text-sm" role="status">{t('control.confirmCancel')}</p>
                  <Button variant="outline" disabled={Boolean(campaignAction)} onClick={() => setConfirmCancel(false)}>{t('control.keep')}</Button>
                  <Button variant="destructive" disabled={Boolean(campaignAction)} onClick={() => control('cancel')}>{t('control.cancel')}</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" disabled={Boolean(campaignAction)} onClick={() => control(broadcast.status === 'paused' ? 'resume' : 'pause')}>
                    {t(broadcast.status === 'paused' ? 'control.resume' : 'control.pause')}
                  </Button>
                  <Button variant="outline" disabled={Boolean(campaignAction)} onClick={() => setConfirmCancel(true)}>{t('control.cancel')}</Button>
                </>
              )}
            </div>
          )}
        </section>
      )}
      {canManage && !queuedDelivery && (pendingCount > 0 || retryableCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <div className="text-sm">
            <p className="font-medium text-foreground">
              {isStalled ? t('resumeStalledTitle') : t('resumeTitle')}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {isStalled
                ? t('resumeStalledHint', { count: pendingCount })
                : t('resumeHint', { count: retryableCount })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pendingCount > 0 && (
              <Button
                size="sm"
                onClick={() => handleResume('pending')}
                disabled={resumingScope !== null}
              >
                {resumingScope === 'pending' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PlayCircle className="h-3.5 w-3.5" />
                )}
                {t('resumePending', { count: pendingCount })}
              </Button>
            )}
            {retryableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleResume('failed')}
                disabled={resumingScope !== null}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {resumingScope === 'failed' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                {t('retryFailed', { count: retryableCount })}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t('stats.totalRecipients')}
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t('stats.sent')}
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('stats.delivered')}
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('stats.read')}
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('stats.replied')}
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('stats.failed')}
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            {statusFilter !== 'all'
              ? t('recipientsHeader', { filtered: recipientCount, total: broadcast.total_recipients })
              : t('recipientsHeaderAll', { total: recipientCount })}
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? t('allStatuses')
                  : tStatus(getRecipientStatus(statusFilter).label)}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => filterRecipients('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {t('allStatuses')}
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => filterRecipients(s)}
                    className={
                      statusFilter === s
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {tStatus(getRecipientStatus(s).label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={!broadcast.total_recipients || exporting}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              {t('exportCsv')}
            </Button>
          </div>
        </div>

        {recipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {statusFilter === 'all'
                ? t('noRecipients')
                : t('noRecipientsFilter')}
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y md:hidden">
              {recipients.map(recipient => {
                const status = getRecipientStatus(recipient.status);
                const latest = recipient.replied_at ?? recipient.read_at ?? recipient.delivered_at ?? recipient.sent_at;
                return (
                  <li key={recipient.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold">{recipient.contact?.name ?? t('unknownContact')}</p>
                        {recipient.contact?.phone && <p className="text-xs text-muted-foreground">{recipient.contact.phone}</p>}
                      </div>
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}>{tStatus(status.label)}</span>
                    </div>
                    {latest && <time dateTime={latest} className="mt-1 block text-xs text-muted-foreground">{new Date(latest).toLocaleString()}</time>}
                    {recipient.error_message && (
                      <details className="mt-1 text-sm text-status-critical">
                        <summary className="min-h-11 cursor-pointer content-center">{t('table.error')}</summary>
                        <p className="break-words">{recipient.error_message}</p>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">{t('table.contact')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.phone')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.sent')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.delivered')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.read')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('control.reply')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.error')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((recipient) => {
                  const rStatus = getRecipientStatus(recipient.status);
                  return (
                    <TableRow key={recipient.id} className="border-border">
                      <TableCell className="font-medium text-foreground">
                        {recipient.contact?.name ?? t('unknownContact')}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {tStatus(rStatus.label)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.replied_at ? new Date(recipient.replied_at).toLocaleString() : '–'}
                        {recipient.reply_attribution && <span className="block text-xs">{t(`control.${recipient.reply_attribution}`)}</span>}
                      </TableCell>
                      <TableCell className="max-w-xs whitespace-normal break-words text-xs text-status-critical">
                        {recipient.error_message ?? '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          </>
        )}
        {recipientCount > RECIPIENT_PAGE_SIZE && (
          <div className="flex items-center justify-end gap-2 border-t border-border p-3">
            <Button variant="outline" size="sm" disabled={recipientPage === 0} onClick={() => setRecipientPage(page => page - 1)}>{t('control.previous')}</Button>
            <Button variant="outline" size="sm" disabled={(recipientPage + 1) * RECIPIENT_PAGE_SIZE >= recipientCount} onClick={() => setRecipientPage(page => page + 1)}>{t('control.next')}</Button>
          </div>
        )}

      </div>
    </div>
  );
}
