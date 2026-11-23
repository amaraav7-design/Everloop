'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { House, Menu, MessageSquare, Radio, Users } from 'lucide-react';
import type { Ref } from 'react';
import { cn } from '@/lib/utils';

const destinations = [
  { href: '/dashboard', label: 'home', icon: House },
  { href: '/inbox', label: 'inbox', icon: MessageSquare },
  { href: '/contacts', label: 'contacts', icon: Users },
  { href: '/broadcasts', label: 'campaigns', icon: Radio },
] as const;

const tab = 'flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

export function MobileNavigation({ open, moreButton, onMore }: {
  open: boolean;
  moreButton: Ref<HTMLButtonElement>;
  onMore: () => void;
}) {
  const pathname = usePathname();
  const t = useTranslations('Mobile');
  return (
    <nav aria-label={t('navigation')} className="everloop-mobile-nav grid shrink-0 grid-cols-5 border-t border-border bg-background lg:hidden">
      {destinations.map(({ href, label, icon: Icon }) => {
        const current = pathname === href || pathname.startsWith(href + '/');
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined} className={cn(tab, current && 'bg-primary/10 font-semibold text-primary')}>
            <Icon className="size-5" aria-hidden="true" />
            <span className="max-w-full truncate">{t(label)}</span>
          </Link>
        );
      })}
      <button
        ref={moreButton}
        type="button"
        className={cn(tab, open && 'bg-primary/10 text-primary')}
        aria-expanded={open}
        aria-controls="everloop-primary-drawer"
        aria-haspopup="dialog"
        onClick={onMore}
      >
        <Menu className="size-5" aria-hidden="true" />
        {t('more')}
      </button>
    </nav>
  );
}
