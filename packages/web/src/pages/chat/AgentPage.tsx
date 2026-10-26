// An agent's long-lived dialog: "/" for the default agent, "/agent/:id" for everyone else on the team.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useStore } from "../../lib/store";
import { agents, ensureAgents, ensureTeam, markRead, refreshTeam, session, team, useConversationMessages } from "../../state/app";
import { TopBar } from "../../components/Layout";
import { EmptyState, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { AgentHeader } from "./AgentHeader";
import { DetailsToggle } from "./DetailsToggle";
import { ChatView } from "./ChatView";
import { SetupGate } from "../../components/BrainSetupCard";

/** While the dialog is on screen, tell the hub the user has seen it up to the newest finished message. */
export function useReadMarker(conversationId: string | undefined, unread: number): void {
  const conv = useConversationMessages(conversationId);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  const newest = useMemo(() => {
    for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].status !== "streaming") return conv.messages[i].createdAt;
    return undefined;
  }, [conv.messages]);
  const sent = useRef("");
  useEffect(() => {
    if (!conversationId || !visible || !newest || unread === 0) return;
    const key = `${conversationId}|${newest}`;
    if (sent.current === key) return;
    sent.current = key;
    void markRead(conversationId, newest);
  }, [conversationId, visible, newest, unread]);
}

export function AgentPage({ agentId }: { agentId?: string }) {
  const s = useStore(session);
  const list = useStore(agents);
  const members = useStore(team);
  useEffect(() => {
    ensureAgents();
    ensureTeam();
  }, []);

  const id = agentId ?? s?.defaultAgent;
  const agent = list?.find((a) => a.id === id);
  const member = members?.find((m) => m.agentId === id);
  const isDefault = !!s && id === s.defaultAgent;
  const conversationId = member?.conversationId ?? (isDefault ? s?.mainConversationId : undefined);

  // A newly added agent gets its dialog with the next team listing (once per agent).
  const asked = useRef<string>(undefined);
  useEffect(() => {
    if (agent && members && !member && asked.current !== agent.id) {
      asked.current = agent.id;
      void refreshTeam();
    }
  }, [agent, members, member]);

  useReadMarker(conversationId, member?.unread ?? 0);

  if (!s || !id) return null;

  if (list && !agent) {
    const fallback = list.find((a) => a.id === s.defaultAgent);
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6">
          <EmptyState icon="bot" title={t("agent.notFound")} hint={t("agent.notFoundHint")} />
          {fallback && (
            <Link href="/" className="text-sm text-accent-text underline">
              {t("agent.openDefault", { name: fallback.name })}
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <AgentHeader agentId={id} />
        <DetailsToggle />
      </TopBar>
      <div className="min-h-0 flex-1">
        {conversationId ? (
          <ChatView
            key={conversationId}
            conversationId={conversationId}
            header={false}
            bottom={<SetupGate conversationId={conversationId} agentId={id} />}
            emptyHint={agent && !isDefault ? t("agent.emptyHint", { name: agent.name }) : undefined}
          />
        ) : (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  );
}
