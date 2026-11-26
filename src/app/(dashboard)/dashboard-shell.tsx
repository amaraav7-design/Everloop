"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { MobileNavigation } from "@/components/layout/mobile-navigation";
import { useCaptureInstallPrompt } from "@/components/pwa/install-prompt";
import { PwaRuntime, useKeyboardViewport } from "@/components/pwa/pwa-runtime";
import { Sidebar } from "@/components/layout/sidebar";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { BrowserNotificationsListener } from "@/components/notifications/browser-notifications-listener";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const inbox = usePathname() === "/inbox";
  useKeyboardViewport();
  useCaptureInstallPrompt();
  const t = useTranslations("DashboardShell");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const button = moreButton.current;
    return () => button?.focus({ preventScroll: true });
  }, [sidebarOpen]);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="everloop-shell flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return <WorkspaceShell inbox={inbox} sidebarOpen={sidebarOpen} closeSidebar={closeSidebar} moreButton={moreButton} onMore={() => setSidebarOpen(true)}>{children}</WorkspaceShell>;
}

function WorkspaceShell({ children, inbox, sidebarOpen, closeSidebar, moreButton, onMore }: {
  children: React.ReactNode;
  inbox: boolean;
  sidebarOpen: boolean;
  closeSidebar: () => void;
  moreButton: React.Ref<HTMLButtonElement>;
  onMore: () => void;
}) {
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  const t = useTranslations("DashboardShell");

  return (
    <div className="everloop-shell flex overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
      <BrowserNotificationsListener />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} totalUnread={totalUnread} unreadNotifications={unreadNotifications} />
      <div inert={sidebarOpen} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <a href="#main-content" className="sr-only z-50 rounded-md bg-primary px-4 py-3 font-semibold text-primary-foreground focus:not-sr-only focus:absolute focus:start-4 focus:top-3">
          {t("skipToContent")}
        </a>
        <Header unreadNotifications={unreadNotifications} />
        <PwaRuntime />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main id="main-content" tabIndex={-1} className={cn("relative min-h-0 flex-1", inbox ? "flex flex-col overflow-hidden" : "overflow-y-auto overscroll-y-contain p-4 sm:p-6 xl:px-8")}>
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {inbox ? <div className="min-h-0 flex-1">{children}</div> : children}
        </main>
        <MobileNavigation open={sidebarOpen} moreButton={moreButton} onMore={onMore} totalUnread={totalUnread} />
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
