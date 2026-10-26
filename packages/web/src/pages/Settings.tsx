// Core settings (GET/PATCH /api/settings) plus settings sections contributed by UI plugins.

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, LogOut, Save } from "lucide-react";
import type { Locale } from "@openbot/shared";
import { LOCALE_NAMES } from "@openbot/shared/i18n";
import { api, errorText } from "../lib/api";
import { useStore } from "../lib/store";
import { agents, ensureAgents, hubEvents, logout, refreshBootstrap, session } from "../state/app";
import { toast } from "../state/toast";
import { explicitLocale, locale, LOCALES, t, type MessageKey } from "../i18n";
import { usePluginRegistry } from "../plugins/slots";
import { PluginBoundary } from "../plugins/boundary";
import { BrowserLanguageSelect } from "../components/LanguageSelect";
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
  /** Hub language: notifications, channels, approval cards, agent replies; the UI default. */
  language: Locale;
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
  // The assistant can change settings from chat: pick that up unless the user is in the middle of editing.
  const dirty = useRef(false);
  dirty.current = !!form && !!orig && changedKeys(orig as unknown as Record<string, unknown>, form as unknown as Record<string, unknown>).length > 0;
  useEffect(() => {
    void load();
    ensureAgents();
    return hubEvents.on((e) => {
      if (e.type === "settings.updated" && !dirty.current) void load();
    });
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
      <Page title={t("nav.settings")}>
        <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
      </Page>
    );
  if (!form || !orig)
    return (
      <Page title={t("nav.settings")}>
        <Loading />
      </Page>
    );

  const set = <K extends keyof CoreSettings>(k: K, v: CoreSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const build = (): { next?: CoreSettings; error?: string } => {
    const next: CoreSettings = { ...form };
    const limits: Record<NumKey, [number, number, MessageKey]> = {
      notifyRatePerHour: [0, 100, "settings.notifyRate"],
      brainConcurrency: [1, 16, "settings.brainConcurrencyName"],
      approvalInlineWaitSec: [0, 600, "settings.approvalWaitName"],
      approvalExpireHours: [1, 24 * 30, "settings.approvalExpireName"],
    };
    for (const k of Object.keys(limits) as NumKey[]) {
      const n = Number(nums[k]);
      const [min, max, label] = limits[k];
      if (!Number.isInteger(n) || n < min || n > max) return { error: t("settings.error.integer", { field: t(label), min, max }) };
      next[k] = n;
    }
    if (!TIME_RE.test(next.quietHours.start) || !TIME_RE.test(next.quietHours.end)) return { error: t("settings.error.quietHours") };
    const badTime = next.digestTimes.find((x) => !TIME_RE.test(x));
    if (badTime) return { error: t("settings.error.digestTime", { value: badTime }) };
    if (zones.length && !zones.includes(next.timezone) && next.timezone !== "UTC") return { error: t("settings.error.timezone", { value: next.timezone }) };
    return { next };
  };

  const pending = build();
  const changed = pending.next ? changedKeys(orig as unknown as Record<string, unknown>, pending.next as unknown as Record<string, unknown>) : [];

  const save = async () => {
    const r = build();
    if (!r.next) return toast(r.error ?? t("settings.error.checkFields"), "error");
    const patch = Object.fromEntries(changedKeys(orig as unknown as Record<string, unknown>, r.next as unknown as Record<string, unknown>).map((k) => [k, (r.next as unknown as Record<string, unknown>)[k]]));
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try {
      const saved = await api.patch<CoreSettings>("/api/settings", patch);
      // This browser follows the hub language: show the interface in the new one.
      if ("language" in patch && !explicitLocale() && saved.language !== locale) return location.reload();
      setOrig(saved);
      setForm(saved);
      toast(t("common.settingsSaved"), "success");
      void refreshBootstrap();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveBar = (
    <Button variant="primary" icon={<Save className="size-4" />} onClick={() => void save()} disabled={!changed.length} loading={busy}>
      {t("common.save")}
    </Button>
  );

  const hubLocales = s?.locales?.length ? s.locales : LOCALES;

  return (
    <Page title={t("nav.settings")} actions={saveBar}>
      <div className="flex flex-col gap-4">
        <Card title={t("settings.general")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings.timezone")} hint={t("settings.timezoneHint")}>
              <Input list="tz-list" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
              <datalist id="tz-list">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label={t("settings.defaultAgent")} hint={t("settings.defaultAgentHint")}>
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

        <Card title={t("settings.language.title")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings.language.browser")} hint={t("settings.language.browserHint")}>
              <BrowserLanguageSelect hubLanguage={orig.language} />
            </Field>
            <Field label={t("settings.language.hub")} hint={t("settings.language.hubHint")}>
              <Select value={form.language} onChange={(e) => set("language", e.target.value as Locale)}>
                {!hubLocales.includes(form.language) && <option value={form.language}>{form.language}</option>}
                {hubLocales.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_NAMES[l] ?? l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title={t("settings.notifications")}>
          <div className="flex flex-col gap-4">
            <div>
              <Toggle checked={form.quietHours.enabled} onChange={(v) => set("quietHours", { ...form.quietHours, enabled: v })} label={<span className="font-medium">{t("settings.quietHours")}</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">{t("settings.quietHoursHint")}</div>
              {form.quietHours.enabled && (
                <div className="mt-3 flex flex-wrap items-center gap-2 pl-12 text-sm">
                  {t("settings.quietFrom")}
                  <Input type="time" value={form.quietHours.start} onChange={(e) => set("quietHours", { ...form.quietHours, start: e.target.value })} className="w-32" aria-label={t("settings.quietStart")} />
                  {t("settings.quietTo")}
                  <Input type="time" value={form.quietHours.end} onChange={(e) => set("quietHours", { ...form.quietHours, end: e.target.value })} className="w-32" aria-label={t("settings.quietEnd")} />
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field group label={t("settings.digestTimes")} hint={t("settings.digestTimesHint")}>
                <TagInput value={form.digestTimes} onChange={(v) => set("digestTimes", v)} placeholder="09:00" />
              </Field>
              <Field label={t("settings.notifyRate")} hint={t("settings.notifyRateHint")}>
                <Input type="number" min={0} value={nums.notifyRatePerHour} onChange={(e) => setNums((n) => ({ ...n, notifyRatePerHour: e.target.value }))} />
              </Field>
            </div>
          </div>
        </Card>

        <Card title={t("settings.approvals")}>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("settings.approvalWait")} hint={t("settings.approvalWaitHint")}>
                <Input type="number" min={0} value={nums.approvalInlineWaitSec} onChange={(e) => setNums((n) => ({ ...n, approvalInlineWaitSec: e.target.value }))} />
              </Field>
              <Field label={t("settings.approvalExpire")} hint={t("settings.approvalExpireHint")}>
                <Input type="number" min={1} value={nums.approvalExpireHours} onChange={(e) => setNums((n) => ({ ...n, approvalExpireHours: e.target.value }))} />
              </Field>
            </div>
            <div>
              <Toggle checked={form.channelApprovalDetails} onChange={(v) => set("channelApprovalDetails", v)} label={<span className="font-medium">{t("settings.approvalDetails")}</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">{t("settings.approvalDetailsHint")}</div>
            </div>
          </div>
        </Card>

        <Card title={t("settings.brains")}>
          <div className="flex flex-col gap-4">
            <Field label={t("settings.brainConcurrency")} hint={t("settings.brainConcurrencyHint")} className="sm:max-w-xs">
              <Input type="number" min={1} value={nums.brainConcurrency} onChange={(e) => setNums((n) => ({ ...n, brainConcurrency: e.target.value }))} />
            </Field>
            <Field group label={t("settings.egress")} hint={t("settings.egressHint")}>
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

        <Card title={t("settings.security")}>
          <p className="mb-3 text-sm text-muted">{t("settings.securityText")}</p>
          <div className="flex flex-wrap gap-2">
            {s && (
              <a
                href={s.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2"
              >
                {t("common.openConsole")} <ExternalLink className="size-4" />
              </a>
            )}
            <Button icon={<LogOut className="size-4" />} onClick={() => void logout()}>
              {t("common.logout")}
            </Button>
          </div>
        </Card>

        <div className="flex justify-end pb-4">{saveBar}</div>
      </div>
    </Page>
  );
}
