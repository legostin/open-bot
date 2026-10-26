// What counts as an action with consequences. The regex sources are passed into the page script,
// which classifies elements (form submit controls, labels like "Buy", "Отправить", "Удалить").

/**
 * Labels of buttons / controls that perform an external action. JS \b is ASCII-only, so Cyrillic stems are matched
 * as substrings with a negative lookahead where a short stem would be ambiguous ("Купи" vs "Купон").
 */
export const ACTION_LABEL_RE =
  /\b(?:buy|purchase|pay|checkout|check\s*out|order|place\s+order|send|submit|confirm|delete|remove|publish|post|transfer|donate|subscribe|unsubscribe|book|reserve|approve)\b|куп(?:ить|и(?![а-яё]))|покупк|оплат|заказ|оформ(?:ить|ление)|отправ|подтверд|удал(?:ить|ени|и(?![а-яё]))|опублик|публик|перевест|перевед|пожертв|подпис(?:ат|к)|отпис|бронир|списат/iu;

/** Plain navigation links are only blocked for destructive / unsubscribe actions (GET links that do things). */
export const LINK_ACTION_LABEL_RE = /\b(?:delete|remove|unsubscribe|deactivate)\b|удал(?:ить|ени|и(?![а-яё]))|отпис|деактив/iu;

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

export const SUBMIT_HINT =
  "Такие действия выполняются только через browser_submit: пользователь подтвердит их. " +
  "Вызовите browser_submit с этим ref, текущим url страницы и description — коротко и точно, что произойдёт (например «Отправить форму заказа на shop.example»).";
