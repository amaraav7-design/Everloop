import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-personalization';

export interface CampaignInput {
  name: string;
  templateId: string;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
  headerText?: string;
  buttonParams?: Record<string, string>;
  scheduledAt?: string | null;
  draftId?: string;
}

export interface CampaignSummary {
  total: number;
  eligible: number;
  duplicates: number;
  exclusions: Record<'invalid_phone' | 'marketing_opt_out' | 'marketing_consent_required' | 'invalid_template_parameters', number>;
  example: string | null;
}
