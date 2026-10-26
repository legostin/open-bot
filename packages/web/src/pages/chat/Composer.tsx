// Message composer: Enter = send, Shift+Enter = newline, /command autocomplete, @member autocomplete in group chats,
// Stop while streaming (in a group: while members answer). Plugins may wrap/replace it (chat.composer) and add buttons
// (chat.composerActions).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, UsersRound } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { applyCommand, filterCommands, slashQuery, type CommandInfo } from "../../lib/commands";
import { applyMention, filterMentions, mentionQuery, type MentionOption } from "../../lib/mentions";
import { isStreaming } from "../../lib/messages";
import { useStore } from "../../lib/store";
import { agents, conversations, groups, interrupt, sendMessage, useConversationMessages, useSelector } from "../../state/app";
import { toast } from "../../state/toast";
import { AgentAvatar } from "../../components/AgentAvatar";
import { cx } from "../../components/ui";
import { t } from "../../i18n";
import { PluginBoundary } from "../../plugins/boundary";
import { pickOverride } from "../../plugins/registry";
import { ComposerActions, usePluginRegistry } from "../../plugins/slots";

const drafts = new Map<string, string>();

let commandsCache: { at: number; list: Promise<CommandInfo[]> } | undefined;
function loadCommands(): Promise<CommandInfo[]> {
  if (!commandsCache || Date.now() - commandsCache.at > 60_000) {
    commandsCache = { at: Date.now(), list: api.get<CommandInfo[]>("/api/commands").catch(() => []) };
  }
  return commandsCache.list;
}

export function useSend(conversationId: string) {
  return useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await sendMessage(conversationId, trimmed);
    },
    [conversationId],
  );
}

/** A group chat's members for @mentions (none in other conversations). */
function useMentionable(conversationId: string) {
  const meta = useSelector(conversations, (list) => list.find((c) => c.id === conversationId));
  const agentList = useStore(agents);
  const members = meta?.kind === "group" ? meta.members : undefined;
  return useMemo(() => (members ?? []).map((id) => agentList?.find((a) => a.id === id) ?? { id, name: id, avatar: undefined }), [members, agentList]);
}

export function DefaultComposer({ conversationId }: { conversationId: string }) {
  const conv = useConversationMessages(conversationId);
  const mentionable = useMentionable(conversationId);
  const isGroup = mentionable.length > 0;
  // Between two members' answers no message streams, but the round goes on.
  const groupRunning = useSelector(groups, (list) => !!list?.find((g) => g.conversationId === conversationId)?.running);
  const streaming = isStreaming(conv.messages) || groupRunning;
  const send = useSend(conversationId);
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(drafts.get(conversationId) ?? "");
  }, [conversationId]);
  useEffect(() => {
    drafts.set(conversationId, text);
  }, [conversationId, text]);
  useEffect(() => {
    if (!streaming) setStopping(false);
  }, [streaming]);

  // Auto-grow up to ~40% of the viewport.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const query = slashQuery(text);
  useEffect(() => {
    if (query !== null) void loadCommands().then(setCommands);
  }, [query !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestions = query !== null && !dismissed ? filterCommands(commands, query) : [];
  const mention = isGroup ? mentionQuery(text, caret) : null;
  const mentions = mention && !dismissed ? filterMentions(mentionable, mention.query) : [];
  // One list at a time: "/command" only at the very start, "@member" anywhere.
  const options = suggestions.length || mentions.length;
  const active = Math.min(sel, Math.max(0, options - 1));
  useEffect(() => {
    setSel(0);
    setDismissed(false);
  }, [query, mention?.start, mention?.query]);

  const submit = async () => {
    if (!text.trim() || busy) return;
    const value = text;
    setBusy(true);
    setText("");
    try {
      await send(value);
    } catch (e) {
      setText(value);
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
      ta.current?.focus();
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      const ok = await interrupt(conversationId);
      if (!ok) toast(t("composer.nothingToStop"), "info");
    } catch (e) {
      toast(errorText(e), "error");
      setStopping(false);
    }
  };

  const choose = (c: CommandInfo) => {
    setText(applyCommand(c.name));
    setDismissed(true);
    ta.current?.focus();
  };

  const chooseMention = (o: MentionOption) => {
    if (!mention) return;
    const next = applyMention(text, caret, mention.start, o.id);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const pick = (i: number) => (suggestions.length ? choose(suggestions[i]) : chooseMention(mentions[i]));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (options) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setSel(() => (active + 1) % options);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setSel(() => (active - 1 + options) % options);
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        return pick(active);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setDismissed(true);
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="relative">
      {suggestions.length > 0 && (
        <div className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-card" role="listbox" aria-label={t("composer.commands")}>
          {suggestions.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              onMouseMove={() => setSel(i)}
              className={cx("flex w-full items-baseline gap-3 px-3 py-2 text-left text-sm", i === active ? "bg-accent-soft" : "")}
            >
              <span className="shrink-0 font-mono font-medium text-accent-text">/{c.name.replace(/^\//, "")}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{c.description}</span>
              {c.source && <span className="shrink-0 text-xs text-muted">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      {mentions.length > 0 && (
        <div className="animate-in absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-card" role="listbox" aria-label={t("composer.mentions")}>
          {mentions.map((o, i) => {
            const a = mentionable.find((m) => m.id === o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseMention(o);
                }}
                onMouseMove={() => setSel(i)}
                className={cx("flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm", i === active ? "bg-accent-soft" : "")}
              >
                {o.all ? (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                    <UsersRound className="size-3.5" />
                  </span>
                ) : (
                  <AgentAvatar avatar={a?.avatar} id={o.id} name={o.name} size={24} />
                )}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{o.all ? t("composer.everyone") : o.name}</span>
                  {o.all && <span className="text-muted"> · {t("composer.everyoneHint")}</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted">@{o.id}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-1.5 pl-3 shadow-card transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          placeholder={isGroup ? t("composer.groupPlaceholder") : t("composer.placeholder")}
          aria-label={t("composer.message")}
          className="max-h-[40vh] min-h-9 flex-1 resize-none overflow-hidden bg-transparent py-2 text-[15px] leading-relaxed outline-none focus-visible:outline-none placeholder:text-muted/80"
        />
        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          <ComposerActions conversationId={conversationId} />
          {streaming ? (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping}
              title={t("composer.stop")}
              aria-label={t("composer.stop")}
              className="inline-flex size-9 items-center justify-center rounded-xl bg-fg text-bg transition hover:opacity-90 disabled:opacity-50"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!text.trim() || busy}
              title={t("composer.sendTitle")}
              aria-label={t("composer.send")}
              className="inline-flex size-9 items-center justify-center rounded-xl bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-40"
            >
              <ArrowUp className="size-[18px]" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 hidden px-1 text-[11px] text-muted sm:block">{t("composer.hint")}</div>
    </div>
  );
}

/** The composer slot: a plugin override (highest priority) or the default composer. */
export function Composer({ conversationId }: { conversationId: string }) {
  const { contributions } = usePluginRegistry();
  const send = useSend(conversationId);
  const override = pickOverride(contributions, "chat.composer");
  const core = <DefaultComposer conversationId={conversationId} />;
  if (!override) return core;
  const C = override.component;
  return (
    <PluginBoundary pluginId={override.pluginId} fallback={core}>
      <C pluginId={override.pluginId} conversationId={conversationId} Default={DefaultComposer} send={send} />
    </PluginBoundary>
  );
}
