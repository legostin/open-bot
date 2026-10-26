// Authenticated session state: live socket, pending approvals, idle logout, title badge.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api.ts";
import { connectLive, type LiveStatus } from "./live.ts";
import { chime, notifyApproval, primeAudio } from "./alerts.ts";
import type { ApprovalView, AuthState, ConsoleEvent } from "./types.ts";
import { t, useLocale, type MessageKey } from "./i18n/index.ts";

/** Mirrors the server's console idle timeout; enforced client-side too, because live refreshes keep the cookie alive. */
export const IDLE_MS = 30 * 60_000;

type Listener = (e: ConsoleEvent) => void;

interface SessionCtx {
  auth: AuthState;
  live: LiveStatus;
  pending: ApprovalView[] | undefined;
  pendingError: string | undefined;
  refreshPending: () => Promise<void>;
  /** Drop a resolved approval locally right away (the socket event will confirm). */
  dropPending: (id: string) => void;
  subscribe: (fn: Listener) => () => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}

/** Subscribe to live events; the handler may change between renders. */
export function useLiveEvents(handler: Listener): void {
  const { subscribe } = useSession();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

export function SessionProvider({ auth, onLost, onLoggedOut, children }: { auth: AuthState; onLost: (reason?: MessageKey) => void; onLoggedOut: () => void; children: ReactNode }) {
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [pending, setPending] = useState<ApprovalView[]>();
  const [pendingError, setPendingError] = useState<string>();
  const listeners = useRef(new Set<Listener>());
  const lostRef = useRef(onLost);
  lostRef.current = onLost;

  const refreshPending = useCallback(async () => {
    try {
      const list = await api.approvals("pending");
      setPending(list);
      setPendingError(undefined);
    } catch (e) {
      setPendingError((e as Error).message);
    }
  }, []);

  const dropPending = useCallback((id: string) => setPending((l) => l?.filter((a) => a.id !== id)), []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  // Live socket.
  useEffect(() => {
    void refreshPending();
    const stop = connectLive({
      onStatus: setLive,
      onReconnect: () => void refreshPending(),
      onUnauthorized: () => {
        void api
          .state()
          .then((s) => {
            if (!s.authenticated) lostRef.current();
          })
          .catch(() => {});
      },
      onEvent: (e) => {
        if (e.type === "approval.created") {
          void refreshPending();
          chime();
          notifyApproval(e.data);
        } else if (e.type === "approval.resolved") {
          setPending((l) => l?.filter((a) => a.id !== e.data.id));
        }
        listeners.current.forEach((fn) => fn(e));
      },
    });
    return stop;
  }, [refreshPending]);

  // Title badge.
  const count = pending?.length ?? 0;
  const locale = useLocale();
  useEffect(() => {
    const base = t("app.title");
    document.title = count ? `(${count}) ${base}` : base;
    return () => {
      document.title = t("app.title");
    };
  }, [count, locale]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      onLoggedOut();
    }
  }, [onLoggedOut]);

  // Idle logout (client-side) + audio priming on first interaction.
  useEffect(() => {
    let last = Date.now();
    const activity = () => {
      last = Date.now();
      primeAudio();
    };
    const check = () => {
      if (Date.now() - last > IDLE_MS) {
        void api.logout().catch(() => {});
        lostRef.current("session.idleLogout");
      }
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((ev) => window.addEventListener(ev, activity, { passive: true }));
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, 15_000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, activity));
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, []);

  const value = useMemo<SessionCtx>(
    () => ({ auth, live, pending, pendingError, refreshPending, dropPending, subscribe, logout }),
    [auth, live, pending, pendingError, refreshPending, dropPending, subscribe, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
