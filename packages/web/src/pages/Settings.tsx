// Core settings (GET/PATCH /api/settings) plus settings sections contributed by UI plugins.

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, LogOut, Save } from "lucide-react";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { agents, ensureAgents, logout, refreshBootstrap, session } from "../state/app";
import { toast } from "../state/toast";
import { usePluginRegistry } from "../plugins/slots";
import { PluginBoundary } from "../plugins/boundary";
import { Button, Card, ErrorNote, Field, Input, Loading, Page, Select, TagInput, Toggle } from "../components/ui";

interface CoreSettings {
  timezone: string;
  defaultAgent: string;
  quietHours: { enabled: boolean; start: string; end: string };
  digestTimes: string[];
  notifyRatePerHour: number;
  brainEgressAllow: string[];
  channelApprovalDetails: boolean;
  brainConcurrency: number;
  approvalInlineWaitSec: number;
  approvalExpireHours: number;
  language: string;
}

type NumKey = "notifyRatePerHour" | "brainConcurrency" | "approvalInlineWaitSec" | "approvalExpireHours";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Keys whose JSON differs between two settings objects. */
export function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export function SettingsPage() {
  const s = useStore(session);
  const agentList = useStore(agents);
  const { settings: sections } = usePluginRegistry();
  const [orig, setOrig] = useState<CoreSettings | null>(null);
  const [form, setForm] = useState<CoreSettings | null>(null);
  const [nums, setNums] = useState<Record<NumKey, string>>({ notifyRatePerHour: "", brainConcurrency: "", approvalInlineWaitSec: "", approvalExpireHours: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(undefined);
    try {
      const r = await api.get<CoreSettings>("/api/settings");
      setOrig(r);
      setForm(r);
      setNums({
        notifyRatePerHour: String(r.notifyRatePerHour),
        brainConcurrency: String(r.brainConcurrency),
        approvalInlineWaitSec: String(r.approvalInlineWaitSec),
        approvalExpireHours: String(r.approvalExpireHours),
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
    ensureAgents();
  }, []);

  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);

  if (error && !form)
    return (
      <Page title="Настройки">
        <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
      </Page>
    );
  if (!form || !orig)
    return (
      <Page title="Настройки">
        <Loading />
      </Page>
    );

  const set = <K extends keyof CoreSettings>(k: K, v: CoreSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const build = (): { next?: CoreSettings; error?: string } => {
    const next: CoreSettings = { ...form };
    const limits: Record<NumKey, [number, number, string]> = {
      notifyRatePerHour: [0, 100, "Уведомлений в час"],
      brainConcurrency: [1, 16, "Параллельных сессий"],
      approvalInlineWaitSec: [0, 600, "Ожидание подтверждения"],
      approvalExpireHours: [1, 24 * 30, "Срок подтверждения"],
    };
    for (const k of Object.keys(limits) as NumKey[]) {
      const n = Number(nums[k]);
      const [min, max, label] = limits[k];
      if (!Number.isInteger(n) || n < min || n > max) return { error: `${label}: целое число от ${min} до ${max}` };
      next[k] = n;
    }
    if (!TIME_RE.test(next.quietHours.start) || !TIME_RE.test(next.quietHours.end)) return { error: "Тихие часы: время в формате ЧЧ:ММ" };
    const badTime = next.digestTimes.find((t) => !TIME_RE.test(t));
    if (badTime) return { error: `Время сводки «${badTime}»: формат ЧЧ:ММ` };
    if (zones.length && !zones.includes(next.timezone) && next.timezone !== "UTC") return { error: `Неизвестный часовой пояс «${next.timezone}»` };
    return { next };
  };

  const pending = build();
  const changed = pending.next ? changedKeys(orig as unknown as Record<string, unknown>, pending.next as unknown as Record<string, unknown>) : [];

  const save = async () => {
    const r = build();
    if (!r.next) return toast(r.error ?? "Проверьте поля", "error");
    const patch = Object.fromEntries(changedKeys(orig as unknown as Record<string, unknown>, r.next as unknown as Record<string, unknown>).map((k) => [k, (r.next as unknown as Record<string, unknown>)[k]]));
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try {
      const saved = await api.patch<CoreSettings>("/api/settings", patch);
      setOrig(saved);
      setForm(saved);
      toast("Настройки сохранены", "success");
      void refreshBootstrap();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveBar = (
    <Button variant="primary" icon={<Save className="size-4" />} onClick={() => void save()} disabled={!changed.length} loading={busy}>
      Сохранить
    </Button>
  );

  return (
    <Page title="Настройки" actions={saveBar}>
      <div className="flex flex-col gap-4">
        <Card title="Общие">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Часовой пояс" hint="Для расписаний, тихих часов и сводок">
              <Input list="tz-list" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
              <datalist id="tz-list">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label="Язык">
              <Select value={form.language} onChange={(e) => set("language", e.target.value)}>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label="Агент по умолчанию" hint="Отвечает в главном треде и берёт новые задачи">
              <Select value={form.defaultAgent} onChange={(e) => set("defaultAgent", e.target.value)}>
                {!(agentList ?? []).some((a) => a.id === form.defaultAgent) && <option value={form.defaultAgent}>{form.defaultAgent}</option>}
                {(agentList ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Уведомления">
          <div className="flex flex-col gap-4">
            <div>
              <Toggle checked={form.quietHours.enabled} onChange={(v) => set("quietHours", { ...form.quietHours, enabled: v })} label={<span className="font-medium">Тихие часы</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">Уведомления приходят без звука, неважное копится до утра</div>
              {form.quietHours.enabled && (
                <div className="mt-3 flex flex-wrap items-center gap-2 pl-12 text-sm">
                  с
                  <Input type="time" value={form.quietHours.start} onChange={(e) => set("quietHours", { ...form.quietHours, start: e.target.value })} className="w-32" aria-label="Начало тихих часов" />
                  до
                  <Input type="time" value={form.quietHours.end} onChange={(e) => set("quietHours", { ...form.quietHours, end: e.target.value })} className="w-32" aria-label="Конец тихих часов" />
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field group label="Время сводок" hint="ЧЧ:ММ, Enter — добавить">
                <TagInput value={form.digestTimes} onChange={(v) => set("digestTimes", v)} placeholder="09:00" />
              </Field>
              <Field label="Уведомлений в час" hint="Лимит срочных уведомлений на один триггер">
                <Input type="number" min={0} value={nums.notifyRatePerHour} onChange={(e) => setNums((n) => ({ ...n, notifyRatePerHour: e.target.value }))} />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="Подтверждения">
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ждать ответа в ходе, сек" hint="Сколько агент ждёт решения, прежде чем отложить действие">
                <Input type="number" min={0} value={nums.approvalInlineWaitSec} onChange={(e) => setNums((n) => ({ ...n, approvalInlineWaitSec: e.target.value }))} />
              </Field>
              <Field label="Срок подтверждения, ч" hint="После — запрос отменяется">
                <Input type="number" min={1} value={nums.approvalExpireHours} onChange={(e) => setNums((n) => ({ ...n, approvalExpireHours: e.target.value }))} />
              </Field>
            </div>
            <div>
              <Toggle checked={form.channelApprovalDetails} onChange={(v) => set("channelApprovalDetails", v)} label={<span className="font-medium">Показывать детали в Telegram</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">Полные параметры действия в сообщении. Выключено — только краткое описание и ссылка на пульт.</div>
            </div>
          </div>
        </Card>

        <Card title="Мозги">
          <div className="flex flex-col gap-4">
            <Field label="Параллельных сессий на мозг" hint="Сколько задач одновременно на одной паре «мозг@машина»" className="sm:max-w-xs">
              <Input type="number" min={1} value={nums.brainConcurrency} onChange={(e) => setNums((n) => ({ ...n, brainConcurrency: e.target.value }))} />
            </Field>
            <Field group label="Дополнительные разрешённые хосты" hint="Куда мозгам можно ходить в сеть помимо стандартного списка (Anthropic, OpenAI, GitHub, npm…). Маски вида *.example.com">
              <TagInput value={form.brainEgressAllow} onChange={(v) => set("brainEgressAllow", v)} placeholder="api.example.com" />
            </Field>
          </div>
        </Card>

        {pending.error && <ErrorNote>{pending.error}</ErrorNote>}

        {sections.map((sec) => {
          const C = sec.component;
          return (
            <Card key={sec.key} title={sec.title}>
              <PluginBoundary pluginId={sec.pluginId}>
                <C pluginId={sec.pluginId} />
              </PluginBoundary>
            </Card>
          );
        })}

        <Card title="Безопасность">
          <p className="mb-3 text-sm text-muted">Пароль, passkey, vault, правила и журнал аудита живут в отдельном пульте безопасности — основная страница и плагины не имеют к ним доступа.</p>
          <div className="flex flex-wrap gap-2">
            {s && (
              <a
                href={s.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2"
              >
                Открыть пульт <ExternalLink className="size-4" />
              </a>
            )}
            <Button icon={<LogOut className="size-4" />} onClick={() => void logout()}>
              Выйти
            </Button>
          </div>
        </Card>

        <div className="flex justify-end pb-4">{saveBar}</div>
      </div>
    </Page>
  );
}
