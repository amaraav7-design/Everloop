'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { WifiOff } from 'lucide-react';

function subscribeNetwork(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

export function PwaRuntime() {
  const t = useTranslations('Mobile');
  const online = useSyncExternalStore(subscribeNetwork, () => navigator.onLine, () => true);
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/everloop-sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
  }, []);
  if (online) return null;
  return (
    <p role="status" className="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-muted px-3 py-2 text-center text-sm">
      <WifiOff aria-hidden="true" className="size-4 shrink-0" /> {t('offline')}
    </p>
  );
}

export function useKeyboardViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const media = window.matchMedia('(max-width: 1023px)');
    if (!viewport) return;
    const root = document.documentElement;
    function resize() {
      if (!viewport || !media.matches || viewport.scale !== 1 || window.innerHeight - viewport.height < 120) {
        root.style.removeProperty('--mobile-viewport');
        root.removeAttribute('data-everloop-keyboard');
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.matches('textarea, input, [contenteditable="true"]'))) {
        root.style.setProperty('--mobile-viewport', `${viewport.height}px`);
        root.setAttribute('data-everloop-keyboard', 'open');
      }
    }
    viewport.addEventListener('resize', resize);
    media.addEventListener('change', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      media.removeEventListener('change', resize);
      root.style.removeProperty('--mobile-viewport');
      root.removeAttribute('data-everloop-keyboard');
    };
  }, []);
}
