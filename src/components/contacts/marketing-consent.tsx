'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  MANUAL_CONSENT_SOURCES,
  type MarketingConsent,
  type MarketingConsentState,
} from '@/lib/whatsapp/marketing-consent';

interface ConsentResult { consent: MarketingConsent | null; addressable: boolean }

export function ContactMarketingConsent({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.marketingConsent');
  const format = useFormatter();
  const id = useId();
  const url = `/api/contacts/${contactId}/marketing-consent`;
  const [data, setData] = useState<ConsentResult | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    fetch(url, { signal: request.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      setData(await response.json());
    }).catch(() => {
      if (!request.signal.aborted) setError(t('loadFailed'));
    });
    return () => request.abort();
  }, [url, t]);

  async function save(state: MarketingConsentState, fields?: FormData) {
    setBusy(true);
    setError('');
    try {
      const date = fields ? new Date(String(fields.get('occurred_at'))) : null;
      if (date && (!Number.isFinite(date.getTime()) || date.getTime() > Date.now())) {
        setError(t('invalidEvidence'));
        return;
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, source: fields?.get('source'), evidence: fields?.get('evidence'), occurred_at: date?.toISOString() }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        setError(result?.error ?? t('saveFailed'));
        return;
      }
      setData(result);
      setEditing(false);
    } catch {
      setError(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save('opted_in', new FormData(event.currentTarget));
  }

  return (
    <section aria-labelledby={id} className="mt-5 space-y-3 border-t border-border pt-4">
      <div>
        <h3 id={id} className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          {data ? t(data.consent?.state ?? 'unknown') : error ? null : t('loading')}
          {data?.consent && ` · ${format.dateTime(new Date(data.consent.occurred_at), { dateStyle: 'medium' })}`}
          {data?.consent && ` · ${t(`sources.${data.consent.source}`)}`}
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {data && !data.addressable && <p className="text-sm text-muted-foreground">{t('addressUnavailable')}</p>}
      {data?.addressable && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => setEditing(true)}>
            {t('recordOptIn')}
          </Button>
          {data.consent?.state !== 'opted_out' && (
            <Button type="button" variant="ghost" className="h-11" disabled={busy} onClick={() => void save('opted_out')}>
              {t('stopMarketing')}
            </Button>
          )}
        </div>
      )}
      {editing && (
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-source`}>{t('source')}</Label>
            <select id={`${id}-source`} name="source" required defaultValue="" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="" disabled>{t('selectSource')}</option>
              {MANUAL_CONSENT_SOURCES.map(source => <option key={source} value={source}>{t(`sources.${source}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-date`}>{t('date')}</Label>
            <Input id={`${id}-date`} name="occurred_at" type="datetime-local" className="h-11" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-evidence`}>{t('evidence')}</Label>
            <Input id={`${id}-evidence`} name="evidence" className="h-11" maxLength={500} required aria-describedby={`${id}-help`} />
            <p id={`${id}-help`} className="text-xs text-muted-foreground">{t('evidenceHelp')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-11" disabled={busy}>{t('recordOptIn')}</Button>
            <Button type="button" variant="ghost" className="h-11" disabled={busy} onClick={() => setEditing(false)}>{t('cancel')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
