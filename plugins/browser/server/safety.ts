// What counts as an action with consequences. The regex sources are passed into the page script,
// which classifies elements (form submit controls, labels like "Buy", "Send", "Delete" in English or Russian).
// Russian stems are written as \u escapes (source files outside the locale catalogs stay ASCII/English).

/**
 * Labels of buttons / controls that perform an external action. JS \b is ASCII-only, so Cyrillic stems are matched
 * as substrings with a negative lookahead where a short stem would be ambiguous ("kupi" = buy vs "kupon" = coupon).
 * Russian stems, in order: kupit'/kupi (buy), pokupk- (purchase), oplat- (pay), zakaz (order), oformit'/oformlenie
 * (check out), otprav- (send), podtverd- (confirm), udalit'/udaleni-/udali (delete), opublik-/publik- (publish),
 * perevest/perived (transfer), pozhertv- (donate), podpisat/podpisk- (subscribe), otpis- (unsubscribe),
 * bronir- (book), spisat (charge). The class inside the lookaheads is the lowercase Cyrillic alphabet.
 */
export const ACTION_LABEL_RE =
  /\b(?:buy|purchase|pay|checkout|check\s*out|order|place\s+order|send|submit|confirm|delete|remove|publish|post|transfer|donate|subscribe|unsubscribe|book|reserve|approve)\b|\u043a\u0443\u043f(?:\u0438\u0442\u044c|\u0438(?![\u0430-\u044f\u0451]))|\u043f\u043e\u043a\u0443\u043f\u043a|\u043e\u043f\u043b\u0430\u0442|\u0437\u0430\u043a\u0430\u0437|\u043e\u0444\u043e\u0440\u043c(?:\u0438\u0442\u044c|\u043b\u0435\u043d\u0438\u0435)|\u043e\u0442\u043f\u0440\u0430\u0432|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434|\u0443\u0434\u0430\u043b(?:\u0438\u0442\u044c|\u0435\u043d\u0438|\u0438(?![\u0430-\u044f\u0451]))|\u043e\u043f\u0443\u0431\u043b\u0438\u043a|\u043f\u0443\u0431\u043b\u0438\u043a|\u043f\u0435\u0440\u0435\u0432\u0435\u0441\u0442|\u043f\u0435\u0440\u0435\u0432\u0435\u0434|\u043f\u043e\u0436\u0435\u0440\u0442\u0432|\u043f\u043e\u0434\u043f\u0438\u0441(?:\u0430\u0442|\u043a)|\u043e\u0442\u043f\u0438\u0441|\u0431\u0440\u043e\u043d\u0438\u0440|\u0441\u043f\u0438\u0441\u0430\u0442/iu;

/**
 * Plain navigation links are only blocked for destructive / unsubscribe actions (GET links that do things).
 * Russian stems: udal- (delete), otpis- (unsubscribe), deaktiv- (deactivate).
 */
export const LINK_ACTION_LABEL_RE = /\b(?:delete|remove|unsubscribe|deactivate)\b|\u0443\u0434\u0430\u043b(?:\u0438\u0442\u044c|\u0435\u043d\u0438|\u0438(?![\u0430-\u044f\u0451]))|\u043e\u0442\u043f\u0438\u0441|\u0434\u0435\u0430\u043a\u0442\u0438\u0432/iu;

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
  "Such actions only run through browser_submit, after the user approves them. " +
  'Call browser_submit with this ref, the current page url and a description: short and exact, what will happen (e.g. "Submit the order form on shop.example").';
