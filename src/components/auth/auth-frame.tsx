import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { EverloopMark } from '@/components/layout/everloop-mark';

export async function AuthFrame({ children }: { children: ReactNode }) {
  const t = await getTranslations('AuthFrame');

  return (
    <main className="everloop-auth bg-background grid min-h-dvh grid-rows-[auto_1fr] lg:grid-cols-[minmax(20rem,0.88fr)_minmax(0,1.12fr)] lg:grid-rows-[1fr]">
      <div className="bg-card flex items-center gap-2.5 border-b px-5 py-3 font-semibold lg:hidden">
        <EverloopMark />
        Everloop
      </div>
      <div className="relative hidden overflow-hidden bg-[var(--brand-field)] px-10 py-10 text-[var(--brand-ink)] lg:grid lg:content-between xl:px-14 xl:py-12">
        <div className="relative z-10 flex items-center gap-3">
          <EverloopMark className="size-11" />
          <span className="text-xl font-semibold tracking-tight">Everloop</span>
        </div>
        <svg
          className="pointer-events-none absolute -end-[18%] top-1/2 w-[130%] -translate-y-1/2 opacity-[0.13]"
          viewBox="2 2 60 60"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M44 20H29a12 12 0 0 0 0 24h13a6 6 0 0 0 0-12H29"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M49 13H29a19 19 0 0 0 0 38h13a13 13 0 0 0 0-26H29"
            stroke="currentColor"
            strokeWidth=".8"
            strokeLinecap="round"
          />
        </svg>
        <p className="relative z-10 max-w-[22ch] pb-4 text-3xl leading-[1.12] font-semibold tracking-tight xl:text-[2.8rem]">
          {t('description')}
        </p>
      </div>
      <div className="flex min-w-0 items-start justify-center p-5 sm:px-8 sm:py-12 lg:items-center">
        {children}
      </div>
    </main>
  );
}
