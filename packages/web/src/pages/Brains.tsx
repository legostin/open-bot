// Brains: probe status per brain ref, limits, and setup instructions.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Brain, ExternalLink, KeyRound, RefreshCw, TimerReset } from "lucide-react";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { formatDateTime, relativeTime, type Tone } from "../lib/format";
import { hubEvents, session } from "../state/app";
import { toast } from "../state/toast";
import { Badge, Button, Card, CodeLine, EmptyState, ErrorNote, Loading, Page } from "../components/ui";

interface BrainRow {
  ref: string;
  label: string;
  host?: string;
  connected: boolean;
  probe?: { available: boolean; authenticated: boolean; version?: string; models?: string[]; detail?: string; checkedAt?: string };
  limitedUntil?: string;
  limitDetail?: string;
}

function status(b: BrainRow): { label: string; tone: Tone } {
  if (!b.connected) return { label: "не подключён", tone: "neutral" };
  if (b.limitedUntil) return { label: `лимит до ${formatDateTime(b.limitedUntil)}`, tone: "warning" };
  if (!b.probe) return { label: "не проверен", tone: "neutral" };
  if (!b.probe.available) return { label: "недоступен", tone: "danger" };
  if (!b.probe.authenticated) return { label: "нужен вход", tone: "warning" };
  return { label: "готов", tone: "success" };
}

function hostLabel(host?: string): string | undefined {
  if (!host) return undefined;
  if (host.startsWith("plugin:")) return `плагин ${host.slice(7)}`;
  if (host.startsWith("machine:")) return `машина ${host.slice(8)}`;
  return host;
}

export function BrainsPage() {
  const s = useStore(session);
  const [list, setList] = useState<BrainRow[] | null>(null);
  const [error, setError] = useState<string>();
  const [probingAll, setProbingAll] = useState(false);
  const [probing, setProbing] = useState<string>();

  const load = useCallback(async (fresh = false) => {
    setError(undefined);
    try {
      setList(await api.get<BrainRow[]>(`/api/brains${fresh ? "?probe=1" : ""}`));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return hubEvents.on((e) => {
      if (e.type === "brains.updated" || e.type === "plugins.updated" || e.type === "machine.updated") void load();
    });
  }, [load]);

  const probeAll = async () => {
    setProbingAll(true);
    await load(true);
    setProbingAll(false);
  };

  const probe = async (ref: string) => {
    setProbing(ref);
    try {
      await api.post("/api/brains/probe", { ref });
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setProbing(undefined);
    }
  };

  const clearLimit = async (ref: string) => {
    try {
      await api.del(`/api/brains/limits/${encodeURIComponent(ref)}`);
      toast("Лимит сброшен", "success");
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const vaultLink = s ? `${s.consoleUrl}/#/vault` : "#";

  return (
    <Page
      title="Мозги"
      subtitle="Чем думают агенты: Claude Code и Codex по вашей подписке или API любых провайдеров."
      actions={
        <Button icon={<RefreshCw className="size-4" />} onClick={() => void probeAll()} loading={probingAll}>
          Проверить все
        </Button>
      }
    >
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
      {!list && !error && <Loading text="Проверяю мозги…" />}
      {list && list.length === 0 && <EmptyState icon="brain" title="Мозгов пока нет" hint="Они появятся, когда запустится плагин мозгов или подключится машина." />}
      {list && list.length > 0 && (
        <div className="mb-8 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {list.map((b, i) => {
            const st = status(b);
            return (
              <div key={b.ref} className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center ${i ? "border-t border-border" : ""}`}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                    <Brain className="size-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.label}</span>
                      <Badge tone={st.tone} dot>
                        {st.label}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                      {b.label !== b.ref && <span className="font-mono">{b.ref}</span>}
                      {hostLabel(b.host) && <span>{hostLabel(b.host)}</span>}
                      {b.probe?.version && <span>версия {b.probe.version}</span>}
                      {b.probe?.checkedAt && <span>проверен {relativeTime(b.probe.checkedAt)}</span>}
                    </div>
                    {(b.probe?.detail || b.limitDetail) && <div className="mt-1 text-xs break-words text-muted">{b.limitedUntil ? b.limitDetail : b.probe?.detail}</div>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 pl-12 sm:pl-0">
                  {b.limitedUntil && (
                    <Button size="sm" icon={<TimerReset className="size-3.5" />} onClick={() => void clearLimit(b.ref)}>
                      Сбросить лимит
                    </Button>
                  )}
                  {b.connected && (
                    <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void probe(b.ref)} loading={probing === b.ref}>
                      Проверить
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="mb-3 text-lg font-semibold">Как подключить</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Claude Code">
          <Steps>
            <li>
              На любой машине с Claude Code, где вы вошли в подписку, выполните:
              <CodeLine>claude setup-token</CodeLine>
            </li>
            <li>
              Сохраните полученный токен в пульте безопасности как запись vault с id <Code>claude_code_token</Code>.
            </li>
            <li>Нажмите «Проверить» у <Code>claude-code@local</Code>.</li>
          </Steps>
          <ConsoleLink href={vaultLink} />
          <p className="mt-3 text-xs text-muted">На подключённых машинах используется ваш обычный вход в Claude Code.</p>
        </Card>
        <Card title="Codex">
          <Steps>
            <li>
              Войдите в ChatGPT внутри контейнера:
              <CodeLine>docker exec -it -u agent openbot codex login --device-auth</CodeLine>
            </li>
            <li>Откройте ссылку, введите код и подтвердите вход.</li>
            <li>Нажмите «Проверить» у <Code>codex@local</Code>.</li>
          </Steps>
          <p className="mt-3 text-xs text-muted">
            Или используйте ключ: запись vault <Code>openai_api_key</Code>.
          </p>
        </Card>
        <Card title="API-ключи">
          <p className="text-sm">Для собственной петли агента (мозг «api») сохраните ключ в vault под одним из id:</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            <KeyRow id="anthropic_api_key" label="Anthropic" />
            <KeyRow id="openai_api_key" label="OpenAI" />
            <KeyRow id="openrouter_api_key" label="OpenRouter" />
          </ul>
          <ConsoleLink href={vaultLink} />
        </Card>
      </div>
    </Page>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-relaxed [&_li>div]:mt-1.5">{children}</ol>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-md border border-border bg-code-bg px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}

function KeyRow({ id, label }: { id: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <KeyRound className="size-3.5 text-muted" />
      <span className="w-24 text-muted">{label}</span>
      <Code>{id}</Code>
    </li>
  );
}

function ConsoleLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline">
      Открыть vault в пульте <ExternalLink className="size-3.5" />
    </a>
  );
}
