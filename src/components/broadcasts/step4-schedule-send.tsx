'use client';

import { useEffect, useState } from 'react';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import { previewCampaign, type VariableMapping } from '@/hooks/use-broadcast-sending';
import type { CampaignSummary } from '@/lib/whatsapp/campaign-input';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

function localInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl: string;
  headerText: string;
  buttonParams: Record<string, string>;
  onTest: (phone: string) => Promise<void>;
  scheduledAt: string | null;
  onScheduleChange: (date: string | null) => void;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  variables,
  headerMediaUrl, headerText, buttonParams, onTest,
  scheduledAt,
  onScheduleChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [preview, setPreview] = useState<CampaignSummary | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const [later, setLater] = useState(Boolean(scheduledAt));
  const [localTime, setLocalTime] = useState(() => scheduledAt ? localInputValue(new Date(scheduledAt)) : '');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const loadingReach = !preview && !previewError;
  const canLaunch = Boolean(name.trim() && preview?.eligible && (!later || (scheduledAt && !scheduleError)));
  const previewFailure = t('scheduleSend.toastFailedPreview');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const deadline = window.setTimeout(() => controller.abort(), 30_000);
    void previewCampaign({
      name: '', templateId: template.id, audience, variables,
      headerMediaUrl: headerMediaUrl.trim(), headerText: headerText.trim(), buttonParams,
    }, controller.signal)
      .then(result => { if (active) setPreview(result); })
      .catch(error => {
        if (active) {
          setPreviewError(!controller.signal.aborted && error instanceof Error ? error.message : previewFailure);
        }
      })
      .finally(() => window.clearTimeout(deadline));
    return () => {
      active = false;
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [template.id, audience, variables, headerMediaUrl, headerText, buttonParams, previewFailure, retry]);

  function changeLocalTime(value: string) {
    setLocalTime(value);
    const date = new Date(value);
    const valid = Number.isFinite(date.getTime()) && date.getTime() > Date.now() && localInputValue(date) === value;
    setScheduleError(Boolean(value) && !valid);
    onScheduleChange(valid ? date.toISOString() : null);
  }

  async function handleTest() {
    setTesting(true);
    try { await onTest(testPhone.trim()); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('scheduleSend.testError')); }
    finally { setTesting(false); }
  }

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label htmlFor="campaign-name" className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          id="campaign-name"
          maxLength={150}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{(preview?.eligible ?? 0).toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Processing overlay */}
      {previewError && (
        <div className="flex flex-wrap items-center gap-3 text-sm" role="status">
          <span className="text-destructive">{previewError}</span>
          <Button variant="outline" size="sm" onClick={() => { setPreviewError(null); setRetry(value => value + 1); }}>
            {t('scheduleSend.retryPreview')}
          </Button>
        </div>
      )}
      {preview && (
        <div className="space-y-3 rounded-lg border border-border p-4 text-sm">
          {preview.example && <p className="whitespace-pre-wrap break-words">{preview.example}</p>}
          {Object.entries(preview.exclusions).filter(([, count]) => count > 0).map(([reason, count]) => (
            <p key={reason} className="text-muted-foreground">{t(`scheduleSend.exclusions.${reason}`, { count })}</p>
          ))}
          {preview.duplicates > 0 && <p className="text-muted-foreground">{t('scheduleSend.exclusions.duplicates', { count: preview.duplicates })}</p>}
          {!preview.eligible && <p className="text-muted-foreground">{t('scheduleSend.noEligible')}</p>}
        </div>
      )}

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">{t('scheduleSend.test')}</summary>
        <p className="my-3 text-sm text-muted-foreground">{t('scheduleSend.testHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="campaign-test-phone">{t('scheduleSend.testPhone')}</label>
          <Input id="campaign-test-phone" type="tel" autoComplete="tel" value={testPhone} placeholder="+14155550123"
            onChange={event => setTestPhone(event.target.value)} className="w-full max-w-xs text-base" />
          <Button variant="outline" disabled={!name.trim() || !testPhone.trim() || testing || isProcessing} onClick={handleTest}>
            {t('scheduleSend.test')}
          </Button>
        </div>
      </details>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">{t('scheduleSend.timing')}</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="campaign-timing" checked={!later} onChange={() => { setLater(false); setScheduleError(false); onScheduleChange(null); }} />
          {t('scheduleSend.sendNow')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="campaign-timing" checked={later} onChange={() => { setLater(true); changeLocalTime(localTime); }} />
          {t('scheduleSend.schedule')}
        </label>
        {later && (
          <div className="space-y-1.5">
            <label htmlFor="campaign-time" className="text-sm">{t('scheduleSend.localTime', { zone })}</label>
            <Input id="campaign-time" type="datetime-local" value={localTime} onChange={event => changeLocalTime(event.target.value)} aria-invalid={scheduleError} className="w-full max-w-sm text-base" />
            {scheduleError && <p className="text-sm text-destructive" role="alert">{t('scheduleSend.invalidTime')}</p>}
          </div>
        )}
      </fieldset>

      {isProcessing && <p className="flex items-center gap-2 text-sm" role="status"><Loader2 className="size-4 animate-spin" />{t('scheduleSend.sending')}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!canLaunch || isProcessing}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            <Send className="h-4 w-4" />
            {t(later ? 'scheduleSend.schedule' : 'scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('scheduleSend.confirmTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('scheduleSend.confirmDesc', {
                  count: preview?.eligible ?? 0,
                  template: template.name,
                  b: (chunks) => (
                    <span className="font-medium text-popover-foreground">{chunks}</span>
                  ),
                })}
              </DialogDescription>
            </DialogHeader>
            {later && scheduledAt && <p className="text-sm">{new Date(scheduledAt).toLocaleString()} ({zone})</p>}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Send className="h-4 w-4" />
                {t(later ? 'scheduleSend.schedule' : 'scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
