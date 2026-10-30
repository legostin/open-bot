// Builtin plugin "currency": exchange rates without a key. Frankfurter (the European Central Bank's daily reference
// rates) gives the rate and its history; currencies the ECB does not publish (the rouble, the tenge…) come from
// ExchangeRate-API's open endpoint, today's rate only. currency_convert shows a card (widget "rates"): the sum in
// each currency, with a sparkline of the last weeks where there is history.

import type { PluginContext, PluginModule } from "@owlbot/plugin-sdk";
import type { ToolResult } from "@owlbot/shared";

interface Settings {
  /** The services' addresses (tests point them at a fake). */
  frankfurterUrl?: string;
  erApiUrl?: string;
}

export interface RateRow {
  code: string;
  /** 1 `from` in this currency. */
  rate: number;
  /** `amount` in this currency. */
  value: number;
  /** The rate over the last `days` days, oldest first (ECB working days). */
  history?: number[];
  /** Change of the rate over that time, in percent. */
  change?: number;
}

/** What the "rates" card draws. */
export interface RatesCard {
  amount: number;
  from: string;
  /** The rates' date (YYYY-MM-DD). */
  date: string;
  source: "ecb" | "exchangerate-api";
  days: number;
  rows: RateRow[];
}

const MAX_TARGETS = 8;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const CODE = /^[A-Z]{3}$/;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

class RatesError extends Error {}

async function getJson<T>(url: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (e: any) {
    throw new RatesError(`${what} is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
  }
  const body = (await res.json().catch(() => undefined)) as any;
  if (!res.ok) throw new RatesError(`${what}: ${body?.message ?? body?.["error-type"] ?? `HTTP ${res.status}`}`);
  return body as T;
}

/** "usd", " Eur " → "USD"; anything else is not a currency code. */
export function code(v: unknown): string | undefined {
  const c = String(v ?? "").trim().toUpperCase();
  return CODE.test(c) ? c : undefined;
}

/** Enough digits to read a rate: more for small numbers. */
export function roundTo(n: number): number {
  const digits = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 6;
  return Number(n.toFixed(digits));
}

/** A sum of money: cents, or enough digits to see a sum below one. */
export function roundMoney(n: number): number {
  return Number(n.toFixed(Math.abs(n) >= 1 ? 2 : 6));
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The card in a line per currency, for the model. */
export function describe(card: RatesCard): string {
  const source = card.source === "ecb" ? `European Central Bank reference rates of ${card.date}` : `ExchangeRate-API rates of ${card.date}`;
  const lines = card.rows.map((r) => {
    const trend = r.change !== undefined ? `; ${card.days} days: ${r.change >= 0 ? "+" : ""}${r.change.toFixed(2)}%` : "";
    return `${card.amount} ${card.from} = ${r.value} ${r.code} (1 ${card.from} = ${r.rate} ${r.code}${trend})`;
  });
  return `${lines.join("\n")}\nSource: ${source}.`;
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const frankfurter = () => (settings.frankfurterUrl || "https://api.frankfurter.dev").replace(/\/+$/, "");
    const erApi = () => (settings.erApiUrl || "https://open.er-api.com").replace(/\/+$/, "");

    // The ECB's list changes once in years: asked once per run.
    let ecbCodes: Promise<Set<string>> | undefined;
    const ecb = () =>
      (ecbCodes ??= getJson<Record<string, string>>(`${frankfurter()}/v1/currencies`, "Frankfurter")
        .then((m) => new Set(Object.keys(m)))
        .catch((e) => {
          ecbCodes = undefined;
          throw e;
        }));

    async function fromEcb(amount: number, from: string, to: string[], days: number): Promise<RatesCard> {
      const latest = await getJson<{ date: string; rates: Record<string, number> }>(`${frankfurter()}/v1/latest?base=${from}&symbols=${to.join(",")}`, "Frankfurter");
      let series: Record<string, Record<string, number>> = {};
      if (days > 0) {
        const start = isoDay(new Date(Date.parse(latest.date) - days * 86_400_000));
        series = (await getJson<{ rates: Record<string, Record<string, number>> }>(`${frankfurter()}/v1/${start}..?base=${from}&symbols=${to.join(",")}`, "Frankfurter")).rates ?? {};
      }
      const dates = Object.keys(series).sort();
      const rows = to.map((c): RateRow => {
        const rate = latest.rates[c];
        if (typeof rate !== "number") throw new RatesError(`Frankfurter has no ${from}→${c} rate.`);
        const history = dates.map((d) => series[d][c]).filter((v): v is number => typeof v === "number");
        const first = history[0];
        return {
          code: c,
          rate: roundTo(rate),
          value: roundMoney(amount * rate),
          ...(history.length > 1 ? { history: history.map(roundTo), change: Number((((rate - first) / first) * 100).toFixed(2)) } : {}),
        };
      });
      return { amount, from, date: latest.date, source: "ecb", days, rows };
    }

    async function fromErApi(amount: number, from: string, to: string[]): Promise<RatesCard> {
      const r = await getJson<{ result: string; rates?: Record<string, number>; time_last_update_unix?: number; "error-type"?: string }>(`${erApi()}/v6/latest/${from}`, "ExchangeRate-API");
      if (r.result !== "success" || !r.rates) throw new RatesError(`ExchangeRate-API: ${r["error-type"] === "unsupported-code" ? `no rates for ${from}` : (r["error-type"] ?? "no rates")}`);
      const rows = to.map((c): RateRow => {
        const rate = r.rates![c];
        if (typeof rate !== "number") throw new RatesError(`No exchange rate is known for ${c}.`);
        return { code: c, rate: roundTo(rate), value: roundMoney(amount * rate) };
      });
      const date = r.time_last_update_unix ? isoDay(new Date(r.time_last_update_unix * 1000)) : isoDay(new Date());
      return { amount, from, date, source: "exchangerate-api", days: 0, rows };
    }

    ctx.tools.register({
      name: "convert",
      effect: "read",
      description:
        "Convert money between currencies at today's exchange rate and show it as a card in the chat, with how each rate moved over the last weeks. " +
        "ISO 4217 codes: USD, EUR, RUB, KZT, GBP, CNY… Rates are central-bank reference rates (European Central Bank via Frankfurter; " +
        "others such as RUB or KZT from ExchangeRate-API, without history), not a bank's buy/sell price: say so if the user is about to exchange money. " +
        "Use it for any question about exchange rates or prices in another currency; then answer briefly, the card shows the numbers.",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number", description: "How much (default 1)" },
          from: { type: "string", description: "Currency code to convert from, e.g. USD" },
          to: { type: "array", items: { type: "string" }, description: `Currency codes to convert to (1–${MAX_TARGETS}), e.g. ["EUR","RUB"]` },
          days: { type: "integer", minimum: 0, maximum: MAX_DAYS, description: `History to show, in days (default ${DEFAULT_DAYS}; 0 for none)` },
        },
        required: ["from", "to"],
      },
      handler: async (input, call) => {
        try {
          const from = code(input.from);
          if (!from) return text(`"${input.from}" is not a currency code: use three letters like USD.`, true);
          const list: Array<string | undefined> = (Array.isArray(input.to) ? input.to : [input.to]).map(code);
          if (!list.length || list.some((c) => !c)) return text(`"to" must be currency codes like ["EUR","RUB"].`, true);
          const to = [...new Set(list as string[])].filter((c) => c !== from).slice(0, MAX_TARGETS);
          if (!to.length) return text("Give at least one currency other than the one converted from.", true);
          const amount = input.amount === undefined ? 1 : Number(input.amount);
          if (!Number.isFinite(amount) || amount < 0) return text("amount must be a positive number.", true);
          const days = input.days === undefined ? DEFAULT_DAYS : Math.min(MAX_DAYS, Math.max(0, Math.round(Number(input.days) || 0)));
          const known = await ecb().catch(() => new Set<string>());
          const card = [from, ...to].every((c) => known.has(c)) ? await fromEcb(amount, from, to, days) : await fromErApi(amount, from, to);
          ctx.widgets.show(call, "rates", card);
          return text(`${describe(card)}\nA card with these numbers is shown in the chat: answer in a sentence instead of repeating them.`);
        } catch (e: any) {
          return text(e instanceof RatesError ? e.message : `Exchange rates failed: ${e?.message ?? e}`, true);
        }
      },
    });
  },
};

export default plugin;
