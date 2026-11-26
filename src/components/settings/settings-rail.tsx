'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-sections';

export function SettingsRail({
  active,
  onSelect,
  hints,
  className,
}: {
  active: SettingsSection;
  className?: string;
  onSelect: (section: SettingsSection) => void;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
}) {
  const t = useTranslations('Settings');
  return (
    <nav
      aria-label={t('sectionsNav')}
      className={cn(
        'flex flex-col gap-3', className,
      )}
    >
      {RAIL_GROUPS.map(({ label, group }) => {
        const items = SETTINGS_SECTIONS.filter(
          (s) => SECTION_META[s].group === group,
        );
        return (
          <div
            key={group}
            className={cn("overflow-hidden rounded-xl border bg-card lg:rounded-none lg:border-0 lg:bg-transparent", group === "top" && "hidden lg:block")}
          >
            {label ? (
              <div className="border-b bg-card-2 px-3 py-2 text-xs font-semibold text-muted-foreground lg:border-0 lg:bg-transparent lg:pt-2 lg:pb-1.5">
                {t(`groups.${group}`)}
              </div>
            ) : null}
            {items.map((s) => {
              const meta = SECTION_META[s];
              const Icon = meta.icon;
              const isActive = s === active;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm font-medium transition-colors last:border-b-0 lg:min-h-9 lg:rounded-lg lg:border-b-0',
                    isActive
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{t(`sections.${s}`)}</span>
                  <ChevronRight className="size-4 text-muted-foreground lg:hidden" aria-hidden="true" />
                  {hints?.[s] != null ? (
                    <span
                      className={cn(
                        'hidden items-center gap-1.5 text-xs lg:inline-flex',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {hints[s]}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
