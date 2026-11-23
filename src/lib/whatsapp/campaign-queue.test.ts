import { describe, expect, it, vi } from 'vitest';
import { campaignFingerprint, campaignSendFailure, readCampaignSchedule } from './campaign-queue';
import { MetaApiError } from './meta-api';
import { TemplateEligibilityError } from './template-delivery';

describe('campaign queue boundaries', () => {
  it('recognizes a retried launch regardless of object property order', () => {
    expect(campaignFingerprint({ b: 2, a: { y: 1, x: 0 } })).toBe(
      campaignFingerprint({ a: { x: 0, y: 1 }, b: 2 }),
    );
    expect(campaignFingerprint({ body: ['a', 'b'] })).not.toBe(campaignFingerprint({ body: ['b', 'a'] }));
  });

  it('converts a zoned schedule to UTC and rejects ambiguous inputs', () => {
    expect(readCampaignSchedule('2026-11-23T18:00:00+05:30')).toBe('2026-11-23T12:30:00.000Z');
    expect(() => readCampaignSchedule('2026-11-23T18:00')).toThrow();
    expect(() => readCampaignSchedule('tomorrow')).toThrow();
  });

  it('backs off confirmed Meta rate limits and stops after the retry budget', () => {
    const rateLimit = new MetaApiError('Rate limited', { httpStatus: 429 });
    expect(campaignSendFailure(rateLimit, 1)).toEqual({
      state: 'retry', reason: 'provider_rate_limited', retrySeconds: 120,
    });
    expect(campaignSendFailure(rateLimit, 4).state).toBe('failed');
  });

  it('never replays a timeout or a Meta response whose send result is uncertain', () => {
    expect(campaignSendFailure(new DOMException('Timed out', 'TimeoutError'), 0).state).toBe('uncertain');
    expect(campaignSendFailure(new MetaApiError('Upstream failed', { httpStatus: 503 }), 0).state).toBe('uncertain');
  });

  it('excludes an opt-out discovered by the final send check', () => {
    expect(campaignSendFailure(new TemplateEligibilityError('marketing_opt_out'), 0)).toEqual({
      state: 'excluded', reason: 'marketing_opt_out',
    });
  });

  it('rejects a campaign schedule without trusting the host time zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T07:00:00Z'));
    try {
      expect(readCampaignSchedule('2026-11-23T12:30:00+05:30')).toBe(new Date().toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});
