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

const tab = 'flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

export function MobileNavigation({ open, moreButton, onMore, totalUnread }: {
  open: boolean;
  moreButton: Ref<HTMLButtonElement>;
  onMore: () => void;
  totalUnread: number;
}) {
  const pathname = usePathname();
  const t = useTranslations('Mobile');
  const tSidebar = useTranslations('Sidebar');
  const moreCurrent = !destinations.some(({ href }) => pathname === href || pathname.startsWith(href + '/')) && pathname !== '/notifications';
  return (
    <nav aria-label={t('navigation')} className="everloop-mobile-nav grid shrink-0 grid-cols-5 gap-0.5 border-t bg-card px-1 pt-1 lg:hidden">
      {destinations.map(({ href, label, icon: Icon }) => {
        const current = pathname === href || pathname.startsWith(href + '/');
        const unread = label === 'inbox' && totalUnread > 0;
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined}
            aria-label={unread ? `${t(label)}, ${tSidebar('unreadConversations', { count: totalUnread })}` : undefined}
            className={cn(tab, current && 'bg-primary-soft font-semibold text-primary')}>
            <span className="relative">
              <Icon className="size-5" aria-hidden="true" />
              {unread && <span aria-hidden="true" className="absolute -end-2 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">{totalUnread > 9 ? '9+' : totalUnread}</span>}
            </span>
            <span className="max-w-full truncate">{t(label)}</span>
          </Link>
        );
      })}
      <button
        ref={moreButton}
        type="button"
        className={cn(tab, (open || moreCurrent) && 'bg-primary-soft text-primary')}
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
