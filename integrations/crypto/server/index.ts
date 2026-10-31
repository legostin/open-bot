// Builtin plugin "crypto": cryptocurrency prices from CoinGecko's public API (no key; a few calls a minute). Both
// tools show a card in the chat (widget "prices": each coin's price, its 24-hour change and a 7-day sparkline).

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { ToolResult } from "@piomio/shared";

interface Settings {
  /** CoinGecko's address (tests point it at a fake). */
  apiUrl?: string;
}

export interface CoinRow {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  rank?: number;
  price: number;
  change24h?: number;
  change7d?: number;
  /** Prices over the last 7 days, oldest first, thinned out. */
  sparkline?: number[];
}

/** What the "prices" card draws. */
export interface PricesCard {
  /** The currency of the prices (lowercase, as CoinGecko names it: usd, eur, rub…). */
  currency: string;
  coins: CoinRow[];
  /** When the prices were taken. */
  at: string;
}

const MAX_COINS = 10;
const MAX_TOP = 25;
const SPARK_POINTS = 42;

/** Tickers people use, by CoinGecko id: saves a search call (the free API allows only a few a minute). */
const KNOWN: Record<string, string> = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  usdt: "tether",
  usdc: "usd-coin",
  bnb: "binancecoin",
  sol: "solana",
  xrp: "ripple",
  doge: "dogecoin",
  ada: "cardano",
  trx: "tron",
  ton: "the-open-network",
  dot: "polkadot",
  ltc: "litecoin",
  avax: "avalanche-2",
  link: "chainlink",
  xmr: "monero",
  matic: "matic-network",
  pol: "polygon-ecosystem-token",
  shib: "shiba-inu",
  near: "near",
  atom: "cosmos",
  xlm: "stellar",
};

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

class CryptoError extends Error {}

/** Every n-th point, the last one always: a sparkline needs no more. */
export function thin(values: number[], points = SPARK_POINTS): number[] {
  if (values.length <= points) return values;
  const step = (values.length - 1) / (points - 1);
  return Array.from({ length: points }, (_, i) => values[Math.round(i * step)]);
}

const sig = (n: number) => Number(n.toPrecision(n >= 1 ? 8 : 4));
const pct = (n?: number) => (n === undefined ? "" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

/** CoinGecko's /coins/markets rows → the card's. */
export function toRows(list: any[]): CoinRow[] {
  return list
    .filter((c) => typeof c?.current_price === "number")
    .map((c) => ({
      id: String(c.id),
      symbol: String(c.symbol ?? "").toUpperCase(),
      name: String(c.name ?? c.id),
      ...(c.image ? { image: String(c.image) } : {}),
      ...(typeof c.market_cap_rank === "number" ? { rank: c.market_cap_rank } : {}),
      price: sig(c.current_price),
      ...(typeof c.price_change_percentage_24h === "number" ? { change24h: Number(c.price_change_percentage_24h.toFixed(2)) } : {}),
      ...(typeof c.price_change_percentage_7d_in_currency === "number" ? { change7d: Number(c.price_change_percentage_7d_in_currency.toFixed(2)) } : {}),
      ...(Array.isArray(c.sparkline_in_7d?.price) && c.sparkline_in_7d.price.length > 1 ? { sparkline: thin(c.sparkline_in_7d.price as number[]).map(sig) } : {}),
    }));
}

export function describe(card: PricesCard): string {
  const cur = card.currency.toUpperCase();
  return card.coins
    .map((c) => `${c.name} (${c.symbol})${c.rank ? ` #${c.rank}` : ""}: ${c.price} ${cur}${c.change24h !== undefined ? `, 24h ${pct(c.change24h)}` : ""}${c.change7d !== undefined ? `, 7d ${pct(c.change7d)}` : ""}`)
    .join("\n");
}

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const base = () => (settings.apiUrl || "https://api.coingecko.com").replace(/\/+$/, "");
    const resolved = new Map<string, string>();

    async function get<T>(path: string): Promise<T> {
      let res: Response;
      try {
        res = await fetch(base() + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      } catch (e: any) {
        throw new CryptoError(`CoinGecko is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`);
      }
      if (res.status === 429) throw new CryptoError("CoinGecko's free API is busy (too many requests): try again in a minute.");
      const body = (await res.json().catch(() => undefined)) as any;
      if (!res.ok) throw new CryptoError(`CoinGecko: ${body?.error ?? body?.status?.error_message ?? `HTTP ${res.status}`}`);
      return body as T;
    }

    /** "BTC", "toncoin", "the-open-network" → CoinGecko's id: a known ticker, else its search (the exact ticker with the best rank). */
    async function idOf(q: string): Promise<string | undefined> {
      const key = q.trim().toLowerCase();
      if (!key) return undefined;
      const hit = KNOWN[key] ?? resolved.get(key);
      if (hit) return hit;
      const coins = (await get<{ coins?: any[] }>(`/api/v3/search?query=${encodeURIComponent(key)}`)).coins ?? [];
      const rank = (c: any) => (typeof c.market_cap_rank === "number" ? c.market_cap_rank : 1e9);
      const exact = (f: (c: any) => boolean) => coins.filter(f).sort((a, b) => rank(a) - rank(b))[0];
      const pick = exact((c) => String(c.id).toLowerCase() === key) ?? exact((c) => String(c.symbol).toLowerCase() === key) ?? exact((c) => String(c.name).toLowerCase() === key) ?? coins[0];
      if (pick?.id) resolved.set(key, String(pick.id));
      return pick?.id;
    }

    async function markets(currency: string, query: string): Promise<PricesCard> {
      const list = await get<any[]>(`/api/v3/coins/markets?vs_currency=${encodeURIComponent(currency)}&sparkline=true&price_change_percentage=24h,7d&${query}`);
      return { currency, coins: toRows(Array.isArray(list) ? list : []), at: new Date().toISOString() };
    }

    const currencyOf = (v: unknown) => {
      const c = String(v ?? "usd").trim().toLowerCase() || "usd";
      if (!/^[a-z]{3,5}$/.test(c)) throw new CryptoError(`"${v}" is not a currency CoinGecko prices in (usd, eur, rub, btc…).`);
      return c;
    };
    const fail = (e: any) => text(e instanceof CryptoError ? e.message : `Crypto prices failed: ${e?.message ?? e}`, true);
    const shown = "\nA card with these prices and 7-day charts is shown in the chat: answer briefly, without repeating every number. Prices move fast; this is not investment advice.";

    ctx.tools.register({
      name: "prices",
      effect: "read",
      description:
        "Current prices of cryptocurrencies (CoinGecko) with their 24-hour and 7-day change, shown as a card with 7-day charts in the chat. " +
        "`coins`: tickers or names (BTC, ETH, TON, \"solana\"); `currency`: what to price in (usd by default; eur, rub… work too).",
      inputSchema: {
        type: "object",
        properties: {
          coins: { type: "array", items: { type: "string" }, description: `1–${MAX_COINS} tickers or names, e.g. ["BTC","ETH"]` },
          currency: { type: "string", description: "usd (default), eur, rub…" },
        },
        required: ["coins"],
      },
      handler: async (input, call) => {
        try {
          const currency = currencyOf(input.currency);
          const asked = (Array.isArray(input.coins) ? input.coins : [input.coins]).map((s: unknown) => String(s ?? "")).filter(Boolean).slice(0, MAX_COINS);
          if (!asked.length) return text("Name at least one coin.", true);
          const ids: string[] = [];
          const unknown: string[] = [];
          for (const q of asked) {
            const id = await idOf(q);
            if (id) ids.push(id);
            else unknown.push(q);
          }
          if (!ids.length) return text(`CoinGecko knows none of: ${unknown.join(", ")}.`, true);
          const card = await markets(currency, `ids=${[...new Set(ids)].map(encodeURIComponent).join(",")}`);
          // In the order asked.
          card.coins.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          if (!card.coins.length) return text("CoinGecko returned no prices for these coins.", true);
          ctx.widgets.show(call, "prices", card);
          return text(`${describe(card)}${unknown.length ? `\nNot found: ${unknown.join(", ")}.` : ""}${shown}`);
        } catch (e) {
          return fail(e);
        }
      },
    });

    ctx.tools.register({
      name: "top",
      effect: "read",
      description: "The largest cryptocurrencies by market capitalisation with their prices and changes (CoinGecko), shown as a card with 7-day charts in the chat.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: MAX_TOP, description: "How many (default 10)" },
          currency: { type: "string", description: "usd (default), eur, rub…" },
        },
      },
      handler: async (input, call) => {
        try {
          const currency = currencyOf(input.currency);
          const count = Math.min(MAX_TOP, Math.max(1, Math.round(Number(input.count) || 10)));
          const card = await markets(currency, `order=market_cap_desc&per_page=${count}&page=1`);
          if (!card.coins.length) return text("CoinGecko returned no prices.", true);
          ctx.widgets.show(call, "prices", card);
          return text(`${describe(card)}${shown}`);
        } catch (e) {
          return fail(e);
        }
      },
    });
  },
};

export default plugin;
