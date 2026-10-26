import { useStore } from "../../lib/store";
import { conversations, session } from "../../state/app";
import { SetupGate } from "../../components/BrainSetupCard";
import { ChatView } from "./ChatView";

export function ChatPage({ conversationId }: { conversationId?: string }) {
  const s = useStore(session);
  const agentId = useStore(conversations).find((c) => c.id === (conversationId ?? s?.mainConversationId))?.agentId;
  if (!s) return null;
  const id = conversationId ?? s.mainConversationId;
  return <ChatView conversationId={id} bottom={<SetupGate conversationId={id} agentId={agentId} />} />;
}
