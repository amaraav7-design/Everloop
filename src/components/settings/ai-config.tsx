'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import { GOOGLE_FREE_TEXT_MODELS, isManagedProvider, MANAGED_PROVIDER_LABEL, type ManagedAiProvider } from '@/lib/ai/managed-providers';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';
import { invalidateAiAccountStatus } from '@/lib/ai/account-status-cache';

const MASKED_KEY = '••••••••••••••••';

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';

const PROVIDER_LABEL = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  ...MANAGED_PROVIDER_LABEL,
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  openai_compatible: 'your-api-key',
  openrouter: 'sk-or-…',
  google_ai_studio: 'AIza…',
};

type ProviderConnection = { provider: ManagedAiProvider; model: string; free_only: boolean };

export function AiConfig({ onOpenPlayground }: { onOpenPlayground: () => void }) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [savedProvider, setSavedProvider] = useState<AiProvider | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [freeOnly, setFreeOnly] = useState(true);
  const [autoReplyPilot, setAutoReplyPilot] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [res, status] = await Promise.all([
        fetch('/api/ai/config', { cache: 'no-store' }),
        canEdit ? fetch('/api/ai/connections', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null) : null,
      ]);
      const data = await res.json();
      const savedConnections: ProviderConnection[] = status?.connections ?? [];
      setConnections(savedConnections);
      setAutoReplyPilot(Boolean(status?.auto_reply_pilot));
      setFreeOnly(savedConnections.find(connection => connection.provider === data.provider)?.free_only ?? true);
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setSavedProvider(data.provider);
        setModel(data.model);
        setBaseUrl(data.base_url ?? '');
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [canEdit, t]);

  useEffect(() => {
    if (profileLoading || !accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig, profileLoading]);

  const handleProviderChange = (next: AiProvider) => {
    if (provider === next) return;
    const saved = connections.find(connection => connection.provider === next);
    const hasKey = Boolean(saved) || (next === savedProvider && configured);
    setProvider(next);
    setModel(saved?.model ?? (next === 'openai_compatible' ? '' : AI_PROVIDER_DEFAULT_MODEL[next]));
    setFreeOnly(saved?.free_only ?? true);
    setHasStoredKey(hasKey);
    setApiKey(hasKey ? MASKED_KEY : '');
    setKeyEdited(false);
    if (isManagedProvider(next)) {
      setAutoReplyEnabled(false);
      setIsActive(false);
    }
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    base_url: provider === 'openai_compatible' ? baseUrl.trim() : null,
    api_key: keyPayload(),
    free_only: freeOnly,
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          base_url: provider === 'openai_compatible' ? baseUrl.trim() : null,
          api_key: keyPayload(),
          free_only: freeOnly,
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (provider === 'openai_compatible' && !baseUrl.trim()) {
      toast.error(t('missingBaseUrl'));
      return;
    }
    if (!hasStoredKey && !keyPayload()) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        invalidateAiAccountStatus();
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        invalidateAiAccountStatus();
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setSavedProvider(null);
        setConnections([]);
        setBaseUrl('');
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        setHandoffAgentId('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (profileLoading || (accountId && loading)) {
    return (
      <div role="status" className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> {t('loading')}
      </div>
    );
  }

  if (!accountId) return <p role="status" className="text-sm text-muted-foreground">{t('loadFailed')}</p>;

  const disabled = !canEdit || saving;
  const isGoogleTest = provider === 'google_ai_studio';
  const canAutoReply = provider !== 'openrouter' || autoReplyPilot;
  const handoffMember = members.find(member => member.user_id === handoffAgentId);

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('providerAndKey')}
            </CardTitle>
            <CardDescription>
              {t('encryptionNotice')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ai-provider">{t('provider')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger id="ai-provider">
                    <SelectValue>
                      {provider === 'openai_compatible' ? t('providerOpenAiCompatible') : PROVIDER_LABEL[provider]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openrouter">{PROVIDER_LABEL.openrouter}</SelectItem>
                    <SelectItem value="google_ai_studio">{PROVIDER_LABEL.google_ai_studio}</SelectItem>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                    <SelectItem value="openai_compatible">
                      {t('providerOpenAiCompatible')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">{t('model')}</Label>
                {provider === 'google_ai_studio' ? (
                  <Select value={model} onValueChange={value => { if (value) setModel(value); }} disabled={disabled}>
                    <SelectTrigger id="ai-model"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GOOGLE_FREE_TEXT_MODELS.map(choice => <SelectItem key={choice} value={choice}>{choice}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="ai-model"
                    value={model}
                    onChange={event => setModel(event.target.value)}
                    placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                    disabled={disabled}
                  />
                )}
              </div>

              {provider === 'openai_compatible' && (
                <div className="space-y-2">
                  <Label htmlFor="ai-base-url">{t('baseUrl')}</Label>
                  <Input
                    id="ai-base-url"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">{t('baseUrlHint')}</p>
                </div>
              )}
            </div>

            {provider === 'openrouter' && (
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <Label htmlFor="openrouter-free-only">{t('connections.freeOnly')}</Label>
                  <p className="text-xs text-muted-foreground">{t('connections.freeModels')}</p>
                </div>
                <Switch id="openrouter-free-only" checked={freeOnly} onCheckedChange={setFreeOnly} disabled={disabled} />
              </div>
            )}
            {isManagedProvider(provider) && (
              <p className="text-sm text-muted-foreground">
                {t(provider === 'google_ai_studio' ? 'connections.googleTestOnly' : 'connections.openRouterDrafts')}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testKey')}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="font-normal text-muted-foreground">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>
          </CardContent>
        </Card>

        {isGoogleTest ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('connections.playgroundOnlyTitle')}</CardTitle>
              <CardDescription>{t('connections.playgroundOnlyDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {savedProvider === provider && hasStoredKey ? (
                <Button variant="outline" onClick={onOpenPlayground}>{t('connections.openPlayground')}</Button>
              ) : (
                <p className="text-sm text-muted-foreground">{t('connections.saveForPlayground')}</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('behaviour')}</CardTitle>
              <CardDescription>
                {t('behaviourDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
                <Textarea
                  id="ai-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder={t('promptPlaceholder')}
                  rows={5}
                  disabled={disabled}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <Label id="ai-assistant-label" htmlFor="ai-assistant-enabled">{t('enableAssistant')}</Label>
                  <p id="ai-assistant-description" className="text-xs text-muted-foreground">
                    {t('enableAssistantDesc')}
                  </p>
                </div>
                <Switch
                  id="ai-assistant-enabled"
                  aria-labelledby="ai-assistant-label"
                  aria-describedby="ai-assistant-description"
                  checked={isActive}
                  onCheckedChange={setIsActive}
                  disabled={disabled}
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <Label id="ai-auto-reply-label" htmlFor="ai-auto-reply">{t('autoReply')}</Label>
                  <p id="ai-auto-reply-description" className="text-xs text-muted-foreground">
                    {t(canAutoReply ? 'autoReplyDesc' : 'connections.openRouterAutoReplyUnavailable')}
                  </p>
                </div>
                <Switch
                  id="ai-auto-reply"
                  aria-labelledby="ai-auto-reply-label"
                  aria-describedby="ai-auto-reply-description"
                  checked={autoReplyEnabled}
                  onCheckedChange={setAutoReplyEnabled}
                  disabled={disabled || !isActive || !canAutoReply}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('maxAutoRepliesDesc')}
                  </p>
                </div>
                <Input
                  id="ai-max"
                  type="number"
                  min={1}
                  max={20}
                  value={maxPerConversation}
                  onChange={(e) =>
                    setMaxPerConversation(
                      Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                    )
                  }
                  disabled={disabled || !autoReplyEnabled}
                  className="w-20"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('handoffToDesc')}
                </p>
                <Select
                  value={handoffAgentId || HANDOFF_QUEUE}
                  onValueChange={(v) =>
                    setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                  }
                  disabled={disabled || !autoReplyEnabled}
                >
                  <SelectTrigger id="ai-handoff">
                    <SelectValue>{handoffMember ? memberLabel(handoffMember) : t('handoffQueue')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={HANDOFF_QUEUE}>
                      {t('handoffQueue')}
                    </SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {memberLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        )}

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
