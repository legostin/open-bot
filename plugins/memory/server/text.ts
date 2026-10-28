// Text helpers for capture and recall: word stems (English and Russian, crude but language-free), overlap, headlines,
// and the two guards — secrets never enter memory, sensitive facts wait for the user's yes.

const STOP = new Set(
  (
    // English
    "the a an and or but if then so of to in on at by for with from about into over after before as is are was were be been " +
    "being have has had do does did not no yes this that these those it its i me my mine you your yours we our they them their " +
    "he him his she her what which who whom when where why how all any some can could will would should shall may might must " +
    "just very also too more most much many such than there here only own same other each both few out up down off again once " +
    "user user's users please thanks thank ok okay hello hi hey let lets want need like know think tell said say get got make " +
    // Russian
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из " +
    "ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей " +
    "может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот " +
    "того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при " +
    "наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо " +
    "свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это пользователь пользователя " +
    "пожалуйста спасибо привет давай хочу нужно знаешь скажи"
  ).split(/\s+/),
);

/** Lowercase words (letters and digits) of a text. */
export function words(text: string): string[] {
  return String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const RU_END = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|ой|ей|ий|ый|ая|яя|ое|ее|ые|ие|ом|ем|ам|ям|ах|ях|ов|ев|ую|юю|ся)$/;
const EN_END = /(ing|ed|es|ly)$/;
const SOFT = /[aeiouyаеиоуыэюяьйs]$/;

/**
 * A crude stem that survives inflection, in both languages: "Казани" / "Казань" / "Казанью" → "казан",
 * "Анне" / "Анна" → "анн", "велосипедом" → "велосипед", "users" → "user". Matching is by word prefix, so a shorter
 * stem still finds longer forms.
 */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/ё/g, "е");
  if (/^\d+$/.test(w)) return w;
  if (w.length >= 6) w = w.replace(/[а-я]/.test(w) ? RU_END : EN_END, "");
  for (let i = 0; i < 2 && w.length >= 4 && SOFT.test(w); i++) w = w.slice(0, -1);
  return w;
}

/** Distinct content stems of a text (stop words and very short words dropped). */
export function stems(text: string, max = 64): string[] {
  const out = new Set<string>();
  for (const w of words(text)) {
    if (w.length < 3 && !/^\d+$/.test(w)) continue;
    if (STOP.has(w)) continue;
    out.add(stem(w));
    if (out.size >= max) break;
  }
  return [...out];
}

/** " word word … " for word-prefix matching: haystack.includes(" " + stem). */
export function haystack(text: string): string {
  return ` ${words(text).join(" ")} `;
}

/** Jaccard overlap of two stem sets (0..1). */
export function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of new Set(a)) if (sb.has(x)) inter++;
  return inter / (new Set([...a, ...b]).size || 1);
}

/** Share of the smaller set found in the larger one (0..1): "contains the same claim". */
export function containment(a: string[], b: string[]): number {
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  if (!small.length) return 0;
  const sl = new Set(large);
  return small.filter((x) => sl.has(x)).length / small.length;
}

/** A short title from a fact's text: its first sentence, cut at a word. */
export function headline(text: string, max = 80): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const s = first.replace(/[.!?]+$/, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${at > max / 2 ? cut.slice(0, at) : cut}…`;
}

/** The same subject ("Анна" / "Анну", "Perm" / "perm"). */
export function sameEntity(a: string, b: string): boolean {
  const x = words(a).map(stem).join(" ");
  const y = words(b).map(stem).join(" ");
  return !!x && x === y;
}

// ---------- guards ----------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\b\d{9,10}:[A-Za-z0-9_-]{30,}\b/, // bot tokens
  /(?:password|passwd|passcode|пароль|пин-?код|pin code|secret|token|api key|апи ключ|ключ api)(?:\s+[^\s:=]+){0,3}?\s*(?:\bis\b|:|=|—|-)\s*\S{4,}/i,
  /(?:cvv|cvc)\s*:?\s*\d{3,4}\b/i,
  /(?:seed phrase|мнемоническ\S* фраз\S*|сид-?фраз\S*)/i,
];

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Long random-looking tokens: letters and digits mixed, 32+ characters. */
function highEntropy(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const s = m[0];
    if (/^vault:/.test(s)) continue;
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return true;
    if (/^[a-f0-9]{40,}$/i.test(s)) return true;
  }
  return false;
}

/** Why a text must not be remembered (a secret), or undefined. vault:// references are fine. */
export function secretReason(text: string): string | undefined {
  const t = String(text ?? "").replace(/vault:\/\/[\w.-]+/g, "");
  for (const p of SECRET_PATTERNS) if (p.test(t)) return "secret";
  for (const m of t.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "card";
  }
  if (highEntropy(t)) return "token";
  return undefined;
}

const SENSITIVE = [
  // health
  /\b(diagnos\w*|illness|disease|cancer|hiv|diabetes|depress\w*|anxiety|therap\w*|psychiatr\w*|medication|prescri\w*|pregnan\w*|disorder|surgery)\b/i,
  /(диагноз|болезн|болеет|(?<!\p{L})рак(?:а|ом|у)?(?!\p{L})|(?<!\p{L})вич(?!\p{L})|диабет|депресс|терапевт|психиатр|психотерап|лекарств|беремен|расстройств|операци(?:я|и|ю|ей)(?!\p{L}))/iu,
  // money
  /\b(salary|income|debt|loan|mortgage|bank account|credit score|bankrupt\w*)\b/i,
  /(зарплат|(?<!\p{L})доход|(?<!\p{L})долг(?:и|а|ов|ом|ам)?(?!\p{L})|кредит|ипотек|банковск\S* сч|банкрот)/iu,
  // beliefs, intimate life, legal
  /\b(religio\w*|political views|votes? for|sexual\w*|gay|lesbian|bisexual|transgender|criminal record|arrest\w*|lawsuit)\b/i,
  /(религи|политическ\S* взгляд|голосует за|сексуальн|ориентаци|судимост|(?<!\p{L})арест|судебн)/iu,
  // documents
  /\b(passport|ssn|social security|driver'?s licen[cs]e number|tax id)\b/i,
  /(паспорт|снилс|(?<!\p{L})инн(?!\p{L})|номер прав)/iu,
];

/** Health, money, beliefs, intimate life, legal matters, documents: remembered only with the user's yes. */
export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((p) => p.test(String(text ?? "")));
}
