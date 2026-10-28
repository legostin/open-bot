// /chat/:id: a group chat, or an older ad-hoc chat.

import { useStore } from "../../lib/store";
import { conversations, groups, session, useSelector } from "../../state/app";
import { SetupGate } from "../../components/BrainSetupCard";
import { useReadMarker } from "./AgentPage";
import { ChatView } from "./ChatView";

export function ChatPage({ conversationId }: { conversationId?: string }) {
  const s = useStore(session);
  const id = conversationId ?? s?.mainConversationId;
  const conv = useStore(conversations).find((c) => c.id === id);
  // A group chat counts unread messages like an agent's dialog: seen once on screen.
  const unread = useSelector(groups, (list) => list?.find((g) => g.conversationId === id)?.unread ?? 0);
  useReadMarker(conv?.kind === "group" ? id : undefined, unread);
  if (!s || !id) return null;
  return <ChatView conversationId={id} bottom={<SetupGate conversationId={id} agentId={conv?.agentId} />} />;
}
