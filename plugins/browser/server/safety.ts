// What counts as an action with consequences. The regex sources are passed into the page script (PAGE_RULES),
// which classifies elements: form submit controls, labels like "Buy", "Send", "Delete" in English or Russian,
// identifiers like id="placeYourOrder", links that act (…/delete, data-method="delete") and controls the site itself
// confirms (data-confirm, onclick="confirm(…)"). Such elements only run through browser_submit, which the user approves.
// Russian stems are written as \u escapes (source files outside the locale catalogs stay ASCII/English).

/** A lowercase Cyrillic letter. JS \b is ASCII-only, so Cyrillic words end with a "no letter follows" lookahead. */
const CYR = "[\\u0430-\\u044f\\u0451]";
const END = `(?!${CYR})`;

/** Verbs and nouns of consequential actions in English: matched as whole words, case-insensitively. */
const EN_ACTIONS = [
  "buy",
  "purchase",
  "pay",
  "checkout",
  "check\\s*out",
  "order",
  "place\\s+(?:your\\s+)?order",
  "send",
  "submit",
  "confirm",
  "delete",
  // Not filter chips or a shopping cart: those are undone with a click.
  "remove(?!\\s+(?:all\\s+)?(?:filters?|tags?|selection|from\\s+(?:the\\s+|my\\s+)?(?:cart|basket|bag|wishlist|favou?rites)))",
  "erase",
  "destroy",
  "discard",
  "publish",
  "post",
  "tweet",
  "retweet",
  "repost",
  "transfer",
  "withdraw",
  "deposit",
  "top\\s*up",
  "sell",
  "bid",
  "donate",
  "subscribe",
  "unsubscribe",
  "book",
  "reserve",
  "approve",
  "vote",
  "deactivate",
  // "Sign the petition", "Sign and send"; not "Sign in", "Sign up", "Sign out".
  "sign(?![\\s-]*(?:in|up|out|on|off)\\b)",
  "apply\\s+(?:now|for)",
  "close\\s+(?:my\\s+|your\\s+|the\\s+)?account",
  "empty\\s+(?:the\\s+)?(?:trash|bin)",
];

/**
 * The same in Russian, as stems. In order: kupit'/kupite/kupi (buy; not "kupon", coupon), pokupk- (purchase),
 * oplat- (pay), zakaz (order; not "zakazy", "my orders"), oformit'/oformite/oformlenie (check out), otprav- (send),
 * podtverd- (confirm), udalit'/udalite/udalenie/udali (delete; not "udalyonnyj", remote), steret' (erase),
 * unichtozh- (destroy), opublik-/publik- (publish), razmestit'/razmestite (post an ad), perevest-/perived- (transfer),
 * pozhertv- (donate), podpisat'/podpisk- (sign, subscribe), otpis- (unsubscribe), bronir- (book), spisat (charge),
 * prodat'/prodajte (sell), vyvesti (withdraw), popolnit'/popolnite (top up), zapisat'sya (sign up for an appointment),
 * podat'/ostavit' zayavk- (file an application), progolosova- (vote), sdelat' stavk- (place a bid),
 * otmenit' bron'/zapis' (cancel a booking), zakryt' schyot/akkaunt (close an account), deaktiv- (deactivate),
 * ochistit' korzin- (empty the trash).
 */
const RU_ACTIONS = [
  `\\u043a\\u0443\\u043f(?:\\u0438\\u0442\\u044c|\\u0438\\u0442\\u0435|\\u0438)${END}`,
  "\\u043f\\u043e\\u043a\\u0443\\u043f\\u043a",
  "\\u043e\\u043f\\u043b\\u0430\\u0442",
  "\\u0437\\u0430\\u043a\\u0430\\u0437(?!\\u044b|\\u043e\\u0432|\\u0430\\u043c|\\u0430\\u0445)",
  "\\u043e\\u0444\\u043e\\u0440\\u043c(?:\\u0438\\u0442\\u044c|\\u0438\\u0442\\u0435|\\u043b\\u0435\\u043d\\u0438)",
  "\\u043e\\u0442\\u043f\\u0440\\u0430\\u0432",
  "\\u043f\\u043e\\u0434\\u0442\\u0432\\u0435\\u0440\\u0434",
  `\\u0443\\u0434\\u0430\\u043b(?:\\u0438\\u0442\\u044c|\\u0438\\u0442\\u0435|\\u0435\\u043d\\u0438|\\u0438${END})`,
  "\\u0441\\u0442\\u0435\\u0440\\u0435\\u0442\\u044c",
  "\\u0443\\u043d\\u0438\\u0447\\u0442\\u043e\\u0436",
  "\\u043f\\u0443\\u0431\\u043b\\u0438\\u043a",
  "\\u0440\\u0430\\u0437\\u043c\\u0435\\u0441\\u0442\\u0438(?:\\u0442\\u044c|\\u0442\\u0435)",
  "\\u043f\\u0435\\u0440\\u0435\\u0432\\u0435\\u0441\\u0442",
  "\\u043f\\u0435\\u0440\\u0435\\u0432\\u0435\\u0434",
  "\\u043f\\u043e\\u0436\\u0435\\u0440\\u0442\\u0432",
  "\\u043f\\u043e\\u0434\\u043f\\u0438\\u0441(?:\\u0430\\u0442|\\u043a)",
  "\\u043e\\u0442\\u043f\\u0438\\u0441",
  "\\u0431\\u0440\\u043e\\u043d\\u0438\\u0440",
  "\\u0441\\u043f\\u0438\\u0441\\u0430\\u0442",
  `\\u043f\\u0440\\u043e\\u0434\\u0430(?:\\u0442\\u044c|\\u0439\\u0442\\u0435)${END}`,
  "\\u0432\\u044b\\u0432\\u0435\\u0441\\u0442\\u0438",
  "\\u043f\\u043e\\u043f\\u043e\\u043b\\u043d\\u0438(?:\\u0442\\u044c|\\u0442\\u0435)",
  "\\u0437\\u0430\\u043f\\u0438\\u0441\\u0430\\u0442\\u044c\\u0441\\u044f",
  "(?:\\u043f\\u043e\\u0434\\u0430\\u0442\\u044c|\\u043e\\u0441\\u0442\\u0430\\u0432\\u0438\\u0442\\u044c)\\s+\\u0437\\u0430\\u044f\\u0432\\u043a",
  "\\u043f\\u0440\\u043e\\u0433\\u043e\\u043b\\u043e\\u0441\\u043e\\u0432\\u0430",
  "\\u0441\\u0434\\u0435\\u043b\\u0430\\u0442\\u044c\\s+\\u0441\\u0442\\u0430\\u0432\\u043a",
  "\\u043e\\u0442\\u043c\\u0435\\u043d\\u0438\\u0442\\u044c\\s+(?:\\u0431\\u0440\\u043e\\u043d|\\u0437\\u0430\\u043f\\u0438\\u0441)",
  "\\u0437\\u0430\\u043a\\u0440\\u044b\\u0442\\u044c\\s+(?:\\u0441\\u0447[\\u0435\\u0451]\\u0442|\\u0430\\u043a\\u043a\\u0430\\u0443\\u043d\\u0442)",
  "\\u0434\\u0435\\u0430\\u043a\\u0442\\u0438\\u0432",
  "\\u043e\\u0447\\u0438\\u0441\\u0442\\u0438\\u0442\\u044c\\s+\\u043a\\u043e\\u0440\\u0437\\u0438\\u043d",
];

/** Labels (accessible name, text, value, title) of buttons / controls that perform an external action. */
export const ACTION_LABEL_RE = new RegExp(`\\b(?:${EN_ACTIONS.join("|")})\\b|${RU_ACTIONS.join("|")}`, "iu");

/**
 * Plain navigation links are only blocked for destructive / unsubscribe actions (GET links that do things), and only
 * when the link text is short like a command ("Delete", "Unsubscribe"), not an article title that mentions deleting.
 * Russian stems: udal- (delete), otpis- (unsubscribe), deaktiv- (deactivate), unichtozh- (destroy).
 */
export const LINK_ACTION_LABEL_RE = new RegExp(
  `\\b(?:delete|remove|erase|destroy|unsubscribe|deactivate)\\b|${[
    `\\u0443\\u0434\\u0430\\u043b(?:\\u0438\\u0442\\u044c|\\u0438\\u0442\\u0435|\\u0435\\u043d\\u0438|\\u0438${END})`,
    "\\u043e\\u0442\\u043f\\u0438\\u0441",
    "\\u0434\\u0435\\u0430\\u043a\\u0442\\u0438\\u0432",
    "\\u0443\\u043d\\u0438\\u0447\\u0442\\u043e\\u0436",
  ].join("|")}`,
  "iu",
);

/** Longest link text (in words) still read as a command; longer texts are titles of pages about the action. */
export const LINK_COMMAND_MAX_WORDS = 6;

/** A path segment or an action parameter of a link that acts when opened: /items/5/delete, ?action=unsubscribe. */
export const LINK_ACTION_PATH_RE = /^(?:delete|remove|erase|destroy|unsubscribe|deactivate|opt-?out|cancel-subscription)$/i;

/**
 * Identifiers of controls (id, name, data-testid, formaction…), split into words first ("placeYourOrder1" →
 * "place Your Order"). Narrower than the label list: identifiers like "post-card" or "submit-btn" are everywhere.
 */
export const ACTION_HINT_RE =
  /\b(?:buy|purchase|checkout|check\s*out|place\s+(?:your\s+)?order|(?:submit|confirm|complete)\s+(?:your\s+)?order|order\s+now|pay|(?:make|submit|confirm)\s+payment|delete|destroy|erase|transfer|withdraw|publish|tweet|send|donate|subscribe|unsubscribe)\b/i;

/**
 * Forms where "Continue" / "Next" moves money or commits an order, even on a plain type="button" (JS wizards):
 * checked against the form's id, name, class, action and label. Russian: oplat- (payment), zakaz (order),
 * oformlen- (checkout), platyozh/platezh (payment), perevod (transfer).
 */
export const CHECKOUT_FORM_RE =
  /\b(?:checkout|check\s*out|payment|pay|billing|purchase|order|transfer|donat\w*|subscri\w*|booking|reserv\w*)\b|оплат|заказ|оформлен|плат[её]ж|перевод/iu;

/** Labels that move a form on: in a checkout-like form they may commit it. Russian: dalee, prodolzhit', zavershit', gotovo, ok. */
export const PROCEED_LABEL_RE = new RegExp(
  `^[\\s\\p{P}\\p{S}]*(?:(?:continue|next|proceed|complete|finish|done|ok)\\b|(?:${[
    "\\u0434\\u0430\\u043b\\u0435\\u0435",
    "\\u043f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0438\\u0442\\u044c",
    "\\u0437\\u0430\\u0432\\u0435\\u0440\\u0448\\u0438\\u0442\\u044c",
    "\\u0433\\u043e\\u0442\\u043e\\u0432\\u043e",
    "\\u043e\\u043a",
  ].join("|")})${END})`,
  "iu",
);

/**
 * A check a site shows instead of the page that passes by itself within seconds (Cloudflare's interstitial). Russian:
 * "browser check", "checking the browser", "running a security check".
 */
export const CHECK_PASSING_RE = new RegExp(
  [
    "just a moment",
    "performing security verification",
    "checking your browser",
    "\\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u043a\\u0430 \\u0431\\u0440\\u0430\\u0443\\u0437\\u0435\\u0440\\u0430",
    "\\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u0435\\u043c \\u0431\\u0440\\u0430\\u0443\\u0437\\u0435\\u0440",
    "\\u0432\\u044b\\u043f\\u043e\\u043b\\u043d\\u0435\\u043d\\u0438\\u0435 \\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u043a\\u0438 \\u0431\\u0435\\u0437\\u043e\\u043f\\u0430\\u0441\\u043d\\u043e\\u0441\\u0442\\u0438",
  ].join("|"),
  "iu",
);

/**
 * A captcha or "not a robot" check a person has to pass. Russian: "confirm that you are not a robot", "I'm not a robot",
 * "you are not a robot?" (Yandex), "requests from your device look automated", "suspicious traffic" (Google).
 */
export const CHECK_RE = new RegExp(
  [
    "verify you are (?:a )?human",
    "are you a robot",
    "unusual traffic from your computer",
    "\\u043f\\u043e\\u0434\\u0442\\u0432\\u0435\\u0440\\u0434\\u0438\\u0442\\u0435, \\u0447\\u0442\\u043e \\u0432\\u044b \\u043d\\u0435 \\u0440\\u043e\\u0431\\u043e\\u0442",
    "\\u044f \\u043d\\u0435 \\u0440\\u043e\\u0431\\u043e\\u0442",
    "\\u0432\\u044b \\u043d\\u0435 \\u0440\\u043e\\u0431\\u043e\\u0442\\?",
    "\\u043f\\u043e\\u0445\\u043e\\u0436\\u0438 \\u043d\\u0430 \\u0430\\u0432\\u0442\\u043e\\u043c\\u0430\\u0442\\u0438\\u0447\\u0435\\u0441\\u043a\\u0438\\u0435",
    "\\u043f\\u043e\\u0434\\u043e\\u0437\\u0440\\u0438\\u0442\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u0442\\u0440\\u0430\\u0444\\u0438\\u043a",
  ].join("|"),
  "iu",
);

/** Everything the page script needs to classify elements (regex sources: RegExp objects do not cross into the page). */
export const PAGE_RULES = {
  action: ACTION_LABEL_RE.source,
  link: LINK_ACTION_LABEL_RE.source,
  linkWords: LINK_COMMAND_MAX_WORDS,
  linkPath: LINK_ACTION_PATH_RE.source,
  hint: ACTION_HINT_RE.source,
  checkoutForm: CHECKOUT_FORM_RE.source,
  proceed: PROCEED_LABEL_RE.source,
  check: CHECK_RE.source,
  checkPassing: CHECK_PASSING_RE.source,
};

/** Keys that activate the focused element: Enter (submits forms, sends chat messages) and Space (presses buttons). */
export function activationKey(key: string): "enter" | "space" | null {
  const last = String(key).split("+").pop() ?? "";
  if (/^(enter|numpadenter|return)$/i.test(last)) return "enter";
  if (last === " " || /^space$/i.test(last)) return "space";
  return null;
}

export interface FocusInfo {
  ref?: string;
  tag: string;
  name: string;
  editable: boolean;
  inForm: boolean;
  search: boolean;
  submit: boolean;
}

/** Enter in an editable field or a form (except search boxes) and activation of submit-like controls need browser_submit. */
export function keyNeedsSubmit(kind: "enter" | "space", f: FocusInfo): boolean {
  if (f.submit) return true;
  if (kind === "enter") return (f.editable || f.inForm) && !f.search;
  return false;
}

/** What browser_type does with text that ends with a line break, which in a field works like pressing Enter. */
export function splitTrailingNewline(text: string): { text: string; enter: boolean } {
  const m = /[\r\n]\s*$/.exec(text);
  return m ? { text: text.slice(0, m.index), enter: true } : { text, enter: false };
}

/**
 * Does the label the user approved (from browser_snapshot, possibly cut with "…" at 80 characters, possibly quoted)
 * still name the element? Case and spacing do not matter.
 */
export function sameLabel(approved: string, actual: string): boolean {
  const norm = (s: string) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'«“„]+|["'»”]+$/g, "")
      .trim()
      .toLowerCase();
  const a = norm(approved);
  const b = norm(actual);
  if (a === b) return true;
  const cutA = a.endsWith("…") ? a.slice(0, -1).trimEnd() : undefined;
  const cutB = b.endsWith("…") ? b.slice(0, -1).trimEnd() : undefined;
  // Only labels browser_snapshot itself cut (80 characters): a short "Pay…" must not stand for "Pay $500".
  if (cutA && cutA.length >= 60 && b.startsWith(cutA)) return true;
  if (cutB && cutB.length >= 60 && a.startsWith(cutB)) return true;
  return false;
}

export const SUBMIT_HINT =
  "Such actions only run through browser_submit, after the user approves them on a card that shows the control's name and the site.";

/** The exact browser_submit call for a refused element, so the model does not have to guess the arguments. */
export function submitCall(ref: string | undefined, label: string, url: string): string {
  if (!ref) return `Call browser_snapshot, then browser_submit with the field's ref, its label, the current url and a description.`;
  return (
    `Call browser_submit with ref "${ref}", label ${JSON.stringify(label)}, url ${JSON.stringify(url)} and a description: ` +
    'short and exact, in the user\'s language, what will happen (e.g. "Pay for the order of 2 items, $34.00, on shop.example").'
  );
}
