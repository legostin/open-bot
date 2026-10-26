// The agent of a conversation, in the chat header: avatar + name; the menu switches agents, creates a new one
// (name and avatar first) or opens agent settings — all without leaving the chat.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, SlidersHorizontal } from "lucide-react";
import type { AgentDef } from "@openbot/shared";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { agents, ensureAgents, updateConversation } from "../../state/app";
import { openPanel } from "../../state/panel";
import { toast } from "../../state/toast";
import { AgentAvatar } from "../../components/AgentAvatar";
import { cx } from "../../components/ui";
import { AgentEditor } from "../Agents";
import { t } from "../../i18n";

export function AgentSwitcher({ conversationId, agentId, readOnly }: { conversationId: string; agentId?: string; readOnly?: boolean }) {
  const list = useStore(agents);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => ensureAgents(), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const current = list?.find((a) => a.id === agentId);
  const pick = async (a: AgentDef) => {
    setOpen(false);
    if (a.id === agentId) return;
    try {
      await updateConversation(conversationId, { agentId: a.id });
      toast(t("chat.agentChanged", { name: a.name }), "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div ref={box} className="relative min-w-0">
      <button
        type="button"
        disabled={readOnly}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("chat.agent")}
        className="flex min-w-0 items-center gap-2 rounded-xl py-1 pr-1.5 pl-1 transition enabled:hover:bg-surface-2"
      >
        <AgentAvatar avatar={current?.avatar} id={agentId} name={current?.name ?? agentId} size={30} />
        <span className="min-w-0 truncate text-[15px] font-semibold">{current?.name ?? agentId ?? t("message.assistant")}</span>
        {!readOnly && <ChevronDown className="size-4 shrink-0 text-muted" />}
      </button>

      {open && list && (
        <div role="menu" className="animate-in absolute top-full left-0 z-30 mt-1 w-72 max-w-[86vw] overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-card">
          <div className="max-h-[50vh] overflow-y-auto">
            {list.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={a.id === agentId}
                onClick={() => void pick(a)}
                className={cx("flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-surface-2", a.id === agentId && "bg-surface-2/70")}
              >
                <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  {a.description && <span className="block truncate text-xs text-muted">{a.description}</span>}
                </span>
                {a.id === agentId && <Check className="size-4 shrink-0 text-accent-text" />}
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm font-medium text-accent-text transition hover:bg-surface-2"
            >
              <span className="flex size-[30px] items-center justify-center rounded-full border border-dashed border-accent/60">
                <Plus className="size-4" />
              </span>
              {t("agents.new")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openPanel("agents");
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm text-muted transition hover:bg-surface-2 hover:text-fg"
            >
              <span className="flex size-[30px] items-center justify-center">
                <SlidersHorizontal className="size-4" />
              </span>
              {t("chat.manageAgents")}
            </button>
          </div>
        </div>
      )}

      {creating && (
        <AgentEditor
          onClose={() => setCreating(false)}
          onSaved={(a) => {
            setCreating(false);
            void pick(a);
          }}
        />
      )}
    </div>
  );
}
