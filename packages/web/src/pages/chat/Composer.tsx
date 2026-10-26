// Message composer: Enter = send, Shift+Enter = newline (on the phone Return is a newline, the button sends), /command autocomplete, Stop while streaming.
// Inside the iOS app an empty field shows a hold-to-talk mic (the app's on-device dictation).
// Plugins may wrap/replace it (chat.composer) and add buttons (chat.composerActions).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowUp, Mic, Square } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { mobileMode } from "../../lib/mobile";
import { native, nativeErrorText, type NativeBridge } from "../../lib/native";
import { applyCommand, filterCommands, slashQuery, type CommandInfo } from "../../lib/commands";
import { isStreaming } from "../../lib/messages";
import { interrupt, sendMessage, useConversationMessages } from "../../state/app";
import { toast } from "../../state/toast";
import { cx } from "../../components/ui";
import { t } from "../../i18n";
import { PluginBoundary } from "../../plugins/boundary";
import { pickOverride } from "../../plugins/registry";
import { ComposerActions, usePluginRegistry } from "../../plugins/slots";

// Unsent text per conversation. Kept in sessionStorage too, so it survives the page reloading in the same tab
// (the phone app reloads its chat page when it signs it in again, e.g. after the hub restarted).
const DRAFTS_KEY = "ob.drafts";
const drafts = new Map<string, string>();
try {
  for (const [id, text] of Object.entries(JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, unknown>)) {
    if (typeof text === "string") drafts.set(id, text);
  }
} catch {
  /* no storage: drafts last until reload */
}

function keepDraft(conversationId: string, text: string): void {
  if (text) drafts.set(conversationId, text);
  else drafts.delete(conversationId);
  try {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    /* private mode or full: in memory only */
  }
}

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

/** A press shorter than this with no words is a tap: say how the mic works. */
const TAP_MS = 350;

/**
 * Hold-to-talk: pressing starts the app's dictation, the live words arrive as `dictation` events, letting go stops it
 * and hands over the final text. A failed start (mic or speech recognition not allowed) reports the app's reason.
 */
function MicButton({
  bridge,
  onListening,
  onWords,
  onDone,
  onError,
}: {
  bridge: NativeBridge;
  onListening: (on: boolean) => void;
  onWords: (text: string) => void;
  onDone: (text: string, tap: boolean) => void;
  onError: (reason: string) => void;
}) {
  const [held, setHeld] = useState(false);
  const run = useRef<{ started: Promise<boolean>; off: () => void; at: number; released: boolean } | null>(null);

  const press = (e: PointerEvent<HTMLButtonElement>) => {
    if (run.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety: pointerup still reaches us on the button */
    }
    const off = bridge.onEvent((ev) => {
      if (ev.type === "dictation" && typeof ev.text === "string") onWords(ev.text);
    });
    const started = bridge.dictation.start().then(
      () => true,
      (err: unknown) => {
        onError(nativeErrorText(err));
        return false;
      },
    );
    run.current = { started, off, at: Date.now(), released: false };
    setHeld(true);
    onListening(true);
    bridge.haptic("light").catch(() => {});
  };

  const release = async () => {
    const r = run.current;
    if (!r || r.released) return;
    r.released = true;
    setHeld(false);
    let text = "";
    if (await r.started) {
      try {
        text = (await bridge.dictation.stop()).text;
      } catch (err) {
        onError(nativeErrorText(err));
      }
    }
    r.off();
    run.current = null;
    onListening(false);
    onDone(text, Date.now() - r.at < TAP_MS);
  };

  // Leaving the chat while held stops the mic.
  useEffect(
    () => () => {
      const r = run.current;
      if (r && !r.released) {
        r.off();
        void r.started.then((ok) => {
          if (ok) bridge.dictation.stop().catch(() => {});
        });
      }
    },
    [bridge],
  );

  return (
    <button
      type="button"
      onPointerDown={press}
      onPointerUp={() => void release()}
      onPointerCancel={() => void release()}
      onLostPointerCapture={() => void release()}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={t("composer.mic")}
      aria-pressed={held}
      title={t("composer.mic")}
      className={cx(
        "mic-button inline-flex size-9 items-center justify-center rounded-xl transition",
        held ? "scale-110 bg-danger text-white shadow-card" : "bg-accent text-accent-fg",
      )}
    >
      <Mic className={cx("size-[18px]", held && "animate-pulse")} />
    </button>
  );
}

export function DefaultComposer({ conversationId }: { conversationId: string }) {
  const conv = useConversationMessages(conversationId);
  const streaming = isStreaming(conv.messages);
  const send = useSend(conversationId);
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [listening, setListening] = useState(false);
  const [micNote, setMicNote] = useState<{ text: string; error: boolean } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(drafts.get(conversationId) ?? "");
  }, [conversationId]);
  useEffect(() => {
    keepDraft(conversationId, text);
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
  useEffect(() => {
    setSel(0);
    setDismissed(false);
  }, [query]);

  const submit = async (value: string = text) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setText("");
    try {
      await send(value);
    } catch (e) {
      setText(value);
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
      // On the phone, focusing would bring the keyboard up after every message (and after dictation).
      if (!mobileMode) ta.current?.focus();
    }
  };

  const dictated = (words: string, tap: boolean) => {
    if (words.trim()) return void submit(words);
    setText("");
    // A short tap explains the gesture; a hold that brought no words says so instead of doing nothing.
    setMicNote((n) => n ?? { text: t(tap ? "composer.holdToTalk" : "composer.notHeard"), error: false });
  };
  const showMic = !!native && (!text.trim() || listening);

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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (suggestions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setSel((i) => (i + 1) % suggestions.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setSel((i) => (i - 1 + suggestions.length) % suggestions.length);
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        return choose(suggestions[sel]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setDismissed(true);
      }
    }
    if (e.key === "Enter" && !e.shiftKey && (!mobileMode || e.metaKey)) {
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
              aria-selected={i === sel}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              onMouseMove={() => setSel(i)}
              className={cx("flex w-full items-baseline gap-3 px-3 py-2 text-left text-sm", i === sel ? "bg-accent-soft" : "")}
            >
              <span className="shrink-0 font-mono font-medium text-accent-text">/{c.name.replace(/^\//, "")}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{c.description}</span>
              {c.source && <span className="shrink-0 text-xs text-muted">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box flex items-end gap-2 rounded-2xl border border-border bg-surface p-1.5 pl-3 shadow-card transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMicNote(null);
          }}
          onKeyDown={onKeyDown}
          readOnly={listening}
          placeholder={listening ? t("composer.listening") : mobileMode ? t("composer.placeholderShort") : t("composer.placeholder")}
          aria-label={t("composer.message")}
          className="max-h-[40vh] min-h-9 flex-1 resize-none overflow-hidden bg-transparent py-2 text-[15px] leading-relaxed outline-none focus-visible:outline-none placeholder:text-muted/80"
        />
        <div className="flex shrink-0 items-center gap-1 pb-0.5">
          <ComposerActions conversationId={conversationId} />
          {native && showMic && (
            <MicButton
              bridge={native}
              onListening={(on) => {
                setListening(on);
                if (on) setMicNote(null);
              }}
              onWords={setText}
              onDone={dictated}
              onError={(reason) => setMicNote({ text: t("composer.micFailed", { reason }), error: true })}
            />
          )}
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
          ) : showMic ? null : (
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
      {micNote && (
        <div className={cx("mt-1.5 px-1 text-xs break-words", micNote.error ? "text-danger" : "text-muted")} role={micNote.error ? "alert" : "status"}>
          {micNote.text}
        </div>
      )}
      <div className="mt-1.5 hidden px-1 text-[11px] text-muted sm:block mobile:hidden">{t("composer.hint")}</div>
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
