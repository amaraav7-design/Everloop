'use client';

import { useRef, useState } from 'react';
import type { CampaignInput, CampaignPreview } from '@/lib/whatsapp/campaign-input';
export type { VariableMapping } from '@/lib/broadcast-personalization';

async function sendRequest(input: CampaignInput & { testTo?: string }, action: 'preview' | 'launch' | 'test', key?: string, signal?: AbortSignal) {
  const response = await fetch('/api/whatsapp/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ ...input, action }),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Could not prepare the campaign.');
  return result;
}

export async function previewCampaign(input: CampaignInput, signal: AbortSignal): Promise<CampaignPreview> {
  return sendRequest(input, 'preview', undefined, signal);
}

export function useBroadcastSending() {
  const [isProcessing, setIsProcessing] = useState(false);
  const launch = useRef<{ body: string; key: string } | null>(null);
  const busy = useRef(false);
  const testLaunch = useRef<{ body: string; key: string } | null>(null);

  async function createAndSendBroadcast(payload: CampaignInput): Promise<string> {
    if (busy.current) throw new Error('The campaign is already being queued.');
    busy.current = true;
    setIsProcessing(true);
    const body = JSON.stringify(payload);
    if (launch.current?.body !== body) launch.current = { body, key: crypto.randomUUID() };
    try {
      return (await sendRequest(payload, 'launch', launch.current.key)).broadcast_id;
    } finally {
      busy.current = false;
      setIsProcessing(false);
    }
  }

  async function queueCampaignTest(payload: CampaignInput, testTo: string) {
    const input = { ...payload, testTo, scheduledAt: null, draftId: undefined };
    const body = JSON.stringify(input);
    if (testLaunch.current?.body !== body) testLaunch.current = { body, key: crypto.randomUUID() };
    await sendRequest(input, 'test', testLaunch.current.key);
    testLaunch.current = null;
  }

  return { createAndSendBroadcast, isProcessing, queueCampaignTest };
}
