'use client';

import { useEffect, useSyncExternalStore } from 'react';

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

let installPrompt: InstallPrompt | null = null;
const installSubscribers = new Set<() => void>();

export function setInstallPrompt(prompt: InstallPrompt | null) {
  installPrompt = prompt;
  for (const callback of installSubscribers) callback();
}

function subscribeInstallPrompt(callback: () => void) {
  installSubscribers.add(callback);
  return () => { installSubscribers.delete(callback); };
}

export function useCaptureInstallPrompt() {
  useEffect(() => {
    function onPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    }
    function onInstall() { setInstallPrompt(null); }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstall);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstall);
    };
  }, []);
}

export function useInstallPrompt() {
  return useSyncExternalStore(subscribeInstallPrompt, () => installPrompt, () => null);
}
