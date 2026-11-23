'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { setInstallPrompt, useInstallPrompt } from "@/components/pwa/install-prompt";
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { revokePushOnThisDevice } from '@/lib/notifications/push-device';

export function MobileAppCard() {
  const t = useTranslations('Mobile');
  const { accountId, accountRole } = useAuth();
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const prompt = useInstallPrompt();

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || accountRole === 'viewer') return;
    const controller = new AbortController();
    void Promise.all([
      fetch('/api/mobile/push', { signal: controller.signal, cache: 'no-store' }).then(result => result.ok ? result.json() : null),
      navigator.serviceWorker.getRegistration('/').then(registration => registration?.pushManager.getSubscription()),
    ]).then(async ([settings, subscription]) => {
      const digest = subscription ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint)) : null;
      if (controller.signal.aborted) return;
      const fingerprint = digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : null;
      setPushKey(settings?.key ?? null);
      setPushEnabled(Boolean(fingerprint && settings?.devices?.includes(fingerprint) && Notification.permission === 'granted'));
    }).catch(() => {
      if (!controller.signal.aborted) {
        setPushKey(null);
        setPushEnabled(false);
      }
    });
    return () => controller.abort();
  }, [accountId, accountRole]);

  async function install() {
    if (!prompt) {
      setShowInstallHelp(value => !value);
      return;
    }
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      setShowInstallHelp(true);
    } finally {
      setInstallPrompt(null);
    }
  }

  async function togglePush() {
    if (!pushKey || busy || accountRole === 'viewer') return;
    setBusy(true);
    try {
      if (pushEnabled) {
        await revokePushOnThisDevice();
        setPushEnabled(false);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          toast.error(t('pushPermission'));
          return;
        }
        const registration = await navigator.serviceWorker.getRegistration('/');
        if (!registration?.active) throw new Error('Service worker is not ready');
        const existing = await registration.pushManager.getSubscription();
        const subscription = existing ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: pushKey,
        });
        try {
          const response = await fetch('/api/mobile/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription.toJSON()),
          });
          if (!response.ok) throw new Error('Push subscription could not be saved');
        } catch (error) {
          if (!existing) await subscription.unsubscribe();
          throw error;
        }
        setPushEnabled(true);
      }
    } catch {
      toast.error(t('pushError'));
      if (pushEnabled) setPushEnabled(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Smartphone className="size-4" aria-hidden="true" /> {t('installTitle')}</CardTitle>
        <CardDescription>{t('installDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="outline" className="min-h-11" onClick={install} aria-expanded={!prompt ? showInstallHelp : undefined}>
          <Download className="size-4" aria-hidden="true" /> {t(prompt ? 'installAction' : 'installHelpAction')}
        </Button>
        {showInstallHelp && <p className="text-sm text-muted-foreground">{t('installHelp')}</p>}
        {pushKey && accountRole !== 'viewer' && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">{t('pushDescription')}</p>
            <Button variant="outline" className="min-h-11" disabled={busy} onClick={togglePush}>
              {t(pushEnabled ? 'pushOff' : 'pushOn')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
