// The iOS app's chat screen: /m/chat/:conversationId in a WKWebView. Only that conversation (messages, cards,
// plugin slots, the composer), full height, no sidebar, settings panel or header (the app draws a native one), the
// composer docked above the keyboard. UI plugins load as on the computer.

import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useStore } from "../lib/store";
import { mobileConversationId, mobileMode, trackVisualViewport } from "../lib/mobile";
import { native, openOutside } from "../lib/native";
import { setShowDetails } from "../state/prefs";
import { agents, conversations, ensureAgents, ensureTeam, hubIsBack, session, team, useConversationMessages } from "../state/app";
import { useUiPlugins } from "../plugins/host";
import { EmptyState } from "../components/ui";
import { SetupGate } from "../components/BrainSetupCard";
import { ChatView } from "./chat/ChatView";
import { useReadMarker } from "./chat/AgentPage";
import { t } from "../i18n";

/** Tell the app the page is on screen (it hides its spinner), once. */
function signalReady(conversationId: string): void {
  requestAnimationFrame(() => {
    native?.ready(conversationId).catch(() => {});
  });
}

/** The page shows an error (hub unreachable…): let the app reveal it, with its Retry button. */
export function useMobileReadyOnError(error: boolean): void {
  useEffect(() => {
    if (mobileMode && error) signalReady(mobileConversationId(window.location.pathname) ?? "");
  }, [error]);
}

/**
 * Links that leave the hub open in Safari, also the ones plugins render or open with window.open (sign-in pages
 * in plugin setup cards). Explicit handlers (markdown, sign-in cards) already did it and prevented the default.
 */
function useOutsideLinks(): void {
  useEffect(() => {
    const bridge = native;
    if (!bridge) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (a) openOutside(e, a.getAttribute("href") ?? undefined, bridge);
    };
    document.addEventListener("click", onClick);
    const open = window.open;
    window.open = (url?: string | URL, target?: string, features?: string) => {
      let handled = false;
      openOutside({ preventDefault: () => void (handled = true) }, url === undefined ? undefined : String(url), bridge);
      return handled ? null : open.call(window, url, target, features);
    };
    return () => {
      document.removeEventListener("click", onClick);
      window.open = open;
    };
  }, []);
}

/** What the app says: its "Show steps" switch (the web UI's detailed mode), and that the hub answers again. */
function useNativeEvents(): void {
  useEffect(
    () =>
      native?.onEvent((ev) => {
        if (ev.type === "details" && typeof ev.on === "boolean") setShowDetails(ev.on);
        if (ev.type === "online") hubIsBack();
      }),
    [],
  );
}

function MobileChat({ conversationId }: { conversationId: string }) {
  const s = useStore(session);
  const convs = useStore(conversations);
  const members = useStore(team);
  const agentList = useStore(agents);
  const conv = useConversationMessages(conversationId);
  useEffect(() => {
    ensureTeam();
    ensureAgents();
  }, []);

  const member = members?.find((m) => m.conversationId === conversationId);
  const agentId = convs.find((c) => c.id === conversationId)?.agentId ?? member?.agentId;
  const agent = agentId ? agentList?.find((a) => a.id === agentId) : undefined;
  const isDefault = !!s && agentId === s.defaultAgent;
  useReadMarker(conversationId, member?.unread ?? 0);

  // Once the first page of messages (or its error) is on screen.
  const told = useRef(false);
  useEffect(() => {
    if (told.current || !conv.loaded) return;
    told.current = true;
    signalReady(conversationId);
  }, [conv.loaded, conversationId]);

  return (
    <ChatView
      conversationId={conversationId}
      header={false}
      bottom={<SetupGate conversationId={conversationId} agentId={agentId} />}
      emptyHint={agent && !isDefault ? t("agent.emptyHint", { name: agent.name }) : undefined}
    />
  );
}

export function MobileApp() {
  useUiPlugins();
  useOutsideLinks();
  useNativeEvents();
  useEffect(() => trackVisualViewport(), []);
  const [location] = useLocation();
  const id = mobileConversationId(location);
  useEffect(() => {
    if (!id) signalReady("");
  }, [id]);

  return (
    <div className="mobile-shell flex flex-col overflow-hidden bg-bg">
      {id ? (
        <MobileChat key={id} conversationId={id} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState icon="message-square" title={t("mobile.noChat")} hint={t("mobile.noChatHint")} />
        </div>
      )}
    </div>
  );
}
