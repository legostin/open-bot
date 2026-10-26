import { useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../../lib/store";
import { session } from "../../state/app";
import { IconButton } from "../../components/ui";
import { ConversationList } from "./ConversationList";
import { ChatView } from "./ChatView";
import { FirstRunChecklist } from "./Checklist";

export function ChatPage({ conversationId }: { conversationId?: string }) {
  const s = useStore(session);
  const [threads, setThreads] = useState(false);
  if (!s) return null;
  const id = conversationId ?? s.mainConversationId;
  const isMain = id === s.mainConversationId;

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface/40 lg:block">
        <ConversationList activeId={id} />
      </aside>

      {threads && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setThreads(false)} />
          <div className="animate-in absolute inset-y-0 left-0 flex w-[85%] max-w-80 flex-col border-r border-border bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-border py-1.5 pr-2 pl-4">
              <span className="font-semibold">Чаты</span>
              <IconButton label="Закрыть" onClick={() => setThreads(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <ConversationList activeId={id} onNavigate={() => setThreads(false)} />
          </div>
        </div>
      )}

      <ChatView conversationId={id} onOpenThreads={() => setThreads(true)} top={isMain ? <FirstRunChecklist /> : undefined} />
    </div>
  );
}
