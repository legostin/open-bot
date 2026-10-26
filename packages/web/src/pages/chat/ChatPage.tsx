import { useStore } from "../../lib/store";
import { session } from "../../state/app";
import { ChatView } from "./ChatView";
import { FirstRunChecklist } from "./Checklist";

export function ChatPage({ conversationId }: { conversationId?: string }) {
  const s = useStore(session);
  if (!s) return null;
  const id = conversationId ?? s.mainConversationId;
  return <ChatView conversationId={id} top={id === s.mainConversationId ? <FirstRunChecklist /> : undefined} />;
}
