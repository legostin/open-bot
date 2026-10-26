import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Inbox, KeyRound, ListChecks, LogOut, ScrollText, UserRound } from "lucide-react";
import { api, errorText, onSessionLost, setCsrf } from "./api.ts";
import type { AuthState, VaultState } from "./types.ts";
import { routeHref, type Page } from "./lib/route.ts";
import { useRoute } from "./router.ts";
import { SessionProvider, useLiveEvents, useSession } from "./session.tsx";
import { AccentStrip, Logo } from "./ui/brand.tsx";
import { Button, cx, IconButton, Spinner } from "./ui/kit.tsx";
import { ToastProvider } from "./ui/overlay.tsx";
import { ThemeSwitch } from "./ui/theme.tsx";
import { Login } from "./pages/Login.tsx";
import { ApprovalsPage } from "./pages/Approvals.tsx";
import { VaultPage } from "./pages/Vault.tsx";
import { RulesPage } from "./pages/Rules.tsx";
import { AuditPage } from "./pages/Audit.tsx";
import { AccountPage } from "./pages/Account.tsx";

export function App() {
  return (
    <ToastProvider>
      <AuthGate />
    </ToastProvider>
  );
}

function AuthGate() {
  const [auth, setAuth] = useState<AuthState>();
  const [loadError, setLoadError] = useState<string>();
  const [reason, setReason] = useState<string>();

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      const s = await api.state();
      setCsrf(s.authenticated ? s.csrf : undefined);
      setAuth(s);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    onSessionLost(() => {
      setReason("Сессия пульта истекла — войдите снова. Вы вернётесь на ту же страницу.");
      setAuth((a) => (a ? { ...a, authenticated: false, csrf: undefined } : a));
    });
    void load();
  }, [load]);

  const lost = useCallback((why?: string) => {
    setCsrf(undefined);
    setReason(why ?? "Сессия пульта истекла — войдите снова. Вы вернётесь на ту же страницу.");
    setAuth((a) => (a ? { ...a, authenticated: false, csrf: undefined } : a));
  }, []);

  const loggedOut = useCallback(() => {
    setCsrf(undefined);
    setReason(undefined);
    void load();
  }, [load]);

  if (!auth) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
        <AccentStrip />
        {loadError ? (
          <div className="max-w-sm text-center">
            <p className="text-sm text-danger">{loadError}</p>
            <Button className="mt-4" onClick={() => void load()}>
              Повторить
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <Login
        state={auth}
        reason={reason}
        onRecheck={load}
        onLoggedIn={(csrf) => {
          setCsrf(csrf);
          setReason(undefined);
          setAuth({ ...auth, authenticated: true, csrf });
        }}
      />
    );
  }

  return (
    <SessionProvider auth={auth} onLost={lost} onLoggedOut={loggedOut}>
      <Shell />
    </SessionProvider>
  );
}

const NAV: Array<{ page: Page; label: string; short: string; icon: ReactNode }> = [
  { page: "approvals", label: "Подтверждения", short: "Запросы", icon: <Inbox className="size-5" /> },
  { page: "vault", label: "Vault", short: "Vault", icon: <KeyRound className="size-5" /> },
  { page: "rules", label: "Правила", short: "Правила", icon: <ListChecks className="size-5" /> },
  { page: "audit", label: "Аудит", short: "Аудит", icon: <ScrollText className="size-5" /> },
  { page: "account", label: "Аккаунт", short: "Аккаунт", icon: <UserRound className="size-5" /> },
];

function useVaultState(): VaultState | undefined {
  const [state, setState] = useState<VaultState>();
  useEffect(() => {
    api
      .vault()
      .then((v) => setState(v.state))
      .catch(() => {});
  }, []);
  useLiveEvents((e) => {
    if (e.type === "vault.state") setState(e.data.state);
  });
  return state;
}

function Shell() {
  const route = useRoute();
  const { pending, live, logout } = useSession();
  const vaultState = useVaultState();
  const count = pending?.length ?? 0;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page]);

  const badge = (page: Page, compact = false) => {
    if (page === "approvals" && count > 0) {
      return (
        <span className={cx("inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-5 text-amber-950", compact && "absolute -top-1 left-1/2 ml-1.5")}>
          {count > 99 ? "99+" : count}
        </span>
      );
    }
    if (page === "vault" && vaultState && vaultState !== "unlocked") {
      return <span className={cx("size-2 rounded-full bg-amber-500", compact && "absolute top-0 left-1/2 ml-2.5")} title={vaultState === "sealed" ? "Vault запечатан" : "Vault не создан"} />;
    }
    return null;
  };

  return (
    <div className="min-h-dvh bg-bg">
      <AccentStrip />

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface pt-[3px] md:flex">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <Logo />
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-semibold text-fg">Пульт безопасности</div>
            <div className="text-xs text-muted">open-bot</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2" aria-label="Разделы">
          {NAV.map((n) => {
            const active = route.page === n.page;
            return (
              <a
                key={n.page}
                href={routeHref(n.page)}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-brand-soft text-brand-fg ring-1 ring-brand-line" : "text-muted hover:bg-inset hover:text-fg",
                )}
              >
                <span className={active ? "text-brand-fg" : "text-faint"}>{n.icon}</span>
                <span className="flex-1">{n.label}</span>
                {badge(n.page)}
              </a>
            );
          })}
        </nav>
        <div className="space-y-3 border-t border-line p-3">
          <LiveIndicator status={live} />
          <ThemeSwitch />
          <Button variant="ghost" size="sm" className="w-full justify-start" icon={<LogOut className="size-4" />} onClick={() => void logout()}>
            Выйти из пульта
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-line bg-surface/90 px-4 pt-[calc(3px+env(safe-area-inset-top))] pb-2.5 backdrop-blur md:hidden">
        <div className="mt-2.5 flex flex-1 items-center gap-2.5">
          <Logo />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[15px] font-semibold text-fg">Пульт безопасности</div>
            <LiveIndicator status={live} compact />
          </div>
          <IconButton label="Выйти из пульта" onClick={() => void logout()}>
            <LogOut className="size-4.5" />
          </IconButton>
        </div>
      </header>

      <main className="md:pl-60">
        <div className="mx-auto max-w-4xl px-4 pt-5 pb-28 sm:px-6 md:pt-8 md:pb-12">
          {route.page === "approvals" && <ApprovalsPage focusId={route.id} />}
          {route.page === "vault" && <VaultPage />}
          {route.page === "rules" && <RulesPage />}
          {route.page === "audit" && <AuditPage />}
          {route.page === "account" && <AccountPage />}
        </div>
      </main>

      {/* Mobile tab bar */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur md:hidden" aria-label="Разделы">
        <div className="grid grid-cols-5">
          {NAV.map((n) => {
            const active = route.page === n.page;
            return (
              <a
                key={n.page}
                href={routeHref(n.page)}
                aria-current={active ? "page" : undefined}
                className={cx("relative flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium", active ? "text-brand-fg" : "text-muted")}
              >
                <span className="relative">{n.icon}</span>
                {badge(n.page, true)}
                <span>{n.short}</span>
                {active && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-brand" />}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function LiveIndicator({ status, compact }: { status: "connecting" | "open" | "closed"; compact?: boolean }) {
  const label = status === "open" ? "На связи с хабом" : status === "connecting" ? "Подключение…" : "Нет связи — переподключаемся";
  return (
    <div className={cx("flex items-center gap-2 text-xs text-muted", !compact && "px-1")} title="Живые обновления подтверждений и состояния vault">
      <span className={cx("size-2 shrink-0 rounded-full", status === "open" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-400 animate-pulse" : "bg-red-500")} />
      <span className="truncate">{label}</span>
    </div>
  );
}
