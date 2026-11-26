'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function useEditorLeave(guarded: boolean) {
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);

  const navigate = useCallback(
    (href: string) => {
      if (guarded) setDestination(href);
      else router.push(href);
    },
    [guarded, router]
  );

  useEffect(() => {
    if (!guarded) return;

    function onLink(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        !(event.target instanceof Element)
      )
        return;
      const link = event.target.closest('a[href]');
      if (
        !(link instanceof HTMLAnchorElement) ||
        (link.target && link.target !== '_self') ||
        link.hasAttribute('download')
      )
        return;
      const url = new URL(link.href);
      if (
        url.origin !== location.origin ||
        (url.pathname === location.pathname && url.search === location.search)
      )
        return;
      event.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    }

    function onExit(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }

    document.addEventListener('click', onLink, { capture: true });
    window.addEventListener('beforeunload', onExit);
    return () => {
      document.removeEventListener('click', onLink, { capture: true });
      window.removeEventListener('beforeunload', onExit);
    };
  }, [guarded, navigate]);

  function dismiss() {
    setDestination(null);
  }

  function leave() {
    if (!destination) return;
    router.push(destination);
    setDestination(null);
  }

  return { navigate, pending: destination !== null, dismiss, leave };
}

export function EditorLeaveDialog({
  open,
  onStay,
  onLeave,
  onSave,
  saving,
}: {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
  onSave: () => Promise<boolean>;
  saving: boolean;
}) {
  const t = useTranslations('EditorLeave');
  const [saveFailed, setSaveFailed] = useState(false);

  async function saveAndLeave() {
    if (await onSave()) onLeave();
    else setSaveFailed(true);
  }

  function stay() {
    setSaveFailed(false);
    onStay();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) stay();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {saveFailed && (
          <p role="alert" className="text-status-critical text-sm">
            {t('saveFailed')}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={saving} onClick={stay}>
            {t('stay')}
          </Button>
          <Button variant="destructive" disabled={saving} onClick={onLeave}>
            {t('discard')}
          </Button>
          <Button disabled={saving} onClick={() => void saveAndLeave()}>
            {saving ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
