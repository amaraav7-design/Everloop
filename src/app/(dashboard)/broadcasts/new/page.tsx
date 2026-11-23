'use client';

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending, type VariableMapping } from '@/hooks/use-broadcast-sending';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { CampaignInput } from '@/lib/whatsapp/campaign-input';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = ['template', 'audience', 'personalize', 'send'] as const;

export default function NewBroadcastPage() {
  return <Suspense><CampaignWizard /></Suspense>;
}

function CampaignWizard() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, queueCampaignTest } = useBroadcastSending();
  const draftId = useSearchParams().get('draft') ?? undefined;
  const [loadingDraft, setLoadingDraft] = useState(Boolean(draftId));
  const [savingDraft, setSavingDraft] = useState(false);

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<Record<string, VariableMapping>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [buttonParams, setButtonParams] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [name, setName] = useState('');
  const previousStep = useRef(currentStep);
  const stepContent = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (currentStep === previousStep.current) return;
    previousStep.current = currentStep;
    const content = stepContent.current;
    content?.closest('main')?.scrollTo({ top: 0 });
    content?.focus({ preventScroll: true });
  }, [currentStep]);

  useEffect(() => {
    if (!draftId) return;
    let active = true;
    async function loadDraft() {
      const db = createClient();
      const { data: draft } = await db.from('broadcasts').select('name, template_name, template_language, audience_filter, template_variables, draft_payload')
        .eq('id', draftId).eq('status', 'draft').maybeSingle();
      if (!active) return;
      if (!draft) {
        toast.error(t('draftUnavailable'));
        router.replace('/broadcasts');
        return;
      }
      const payload = draft.draft_payload as CampaignInput | null;
      const { data: savedTemplate } = await db.from('message_templates').select('*')
        .eq('name', draft.template_name).eq('language', draft.template_language)
        .eq('status', 'APPROVED').maybeSingle<MessageTemplate>();
      if (!active) return;
      setName(draft.name);
      setAudience(payload?.audience ?? draft.audience_filter ?? { type: 'all' });
      setVariables(payload?.variables ?? draft.template_variables ?? {});
      setHeaderMediaUrl(payload?.headerMediaUrl ?? '');
      setHeaderText(payload?.headerText ?? '');
      setButtonParams(payload?.buttonParams ?? {});
      setScheduledAt(payload?.scheduledAt ?? null);
      if (savedTemplate) {
        setTemplate(savedTemplate);
        setCurrentStep(1);
      }
      setLoadingDraft(false);
    }
    void loadDraft();
    return () => { active = false; };
  }, [draftId, router, t]);

  function campaignInput(): CampaignInput | null {
    if (!template) return null;
    return { name, templateId: template.id, audience, variables, headerMediaUrl: headerMediaUrl.trim(), headerText: headerText.trim(), buttonParams, scheduledAt, draftId };
  }

  async function handleSend() {
    const payload = campaignInput();
    if (!payload) return;
    try {
      const broadcastId = await createAndSendBroadcast(payload);
      router.push(`/broadcasts/${broadcastId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('broadcastFailed'));
    }
  }

  async function handleTest(phone: string) {
    const payload = campaignInput();
    if (!payload) return;
    await queueCampaignTest(payload, phone);
    toast.success(t('testQueued'));
  }

  async function handleSaveDraft() {
    const payload = campaignInput();
    if (!payload || !template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }
    setSavingDraft(true);
    try {
      const supabase = createClient();
      const fields = {
        name: name.trim(), template_name: template.name, template_language: template.language ?? 'en_US',
        template_variables: variables, audience_filter: audience, draft_payload: payload,
      };
      const query = draftId
        ? supabase.from('broadcasts').update(fields).eq('id', draftId).eq('account_id', accountId).eq('status', 'draft')
        : supabase.from('broadcasts').insert({ ...fields, account_id: accountId, user_id: (await supabase.auth.getUser()).data.user?.id });
      const { data, error } = await query.select('id').maybeSingle();
      if (error || !data) throw new Error(error?.message ?? t('draftUnavailable'));
      toast.success(t('toastDraftSaved'));
      router.push('/broadcasts');
    } catch (error) {
      toast.error(t('toastFailedDraft', { error: error instanceof Error ? error.message : t('draftUnavailable') }));
    } finally {
      setSavingDraft(false);
    }
  }

  if (loadingDraft) return <p role="status" className="text-sm text-muted-foreground">{t('loadingDraft')}</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Step Indicator */}
      <ol className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <li key={step} aria-current={isActive ? 'step' : undefined} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  aria-hidden="true"
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`sr-only text-sm font-medium sm:not-sr-only ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  aria-hidden="true"
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Step Content */}
      <div
        ref={stepContent}
        role="group"
        aria-label={t(`steps.${steps[currentStep]}`)}
        tabIndex={-1}
        className="relative min-h-[400px] outline-none"
      >
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              headerText={headerText}
              onHeaderTextChange={setHeaderText}
              buttonParams={buttonParams}
              onButtonParamsChange={setButtonParams}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              variables={variables}
              headerMediaUrl={headerMediaUrl}
              headerText={headerText}
              buttonParams={buttonParams}
              onTest={handleTest}
              scheduledAt={scheduledAt}
              onScheduleChange={setScheduledAt}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing || savingDraft}
            />
          )}
        </div>
      </div>
    </div>
  );
}
