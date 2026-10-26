// Code that runs inside web pages. It is serialized with Function.prototype.toString and evaluated through CDP
// (Runtime.evaluate), so page CSP does not block it. It must be self-contained: no references to module scope.
// Elements get stable refs in a `data-owl-ref` attribute; the counter lives in the plugin, so refs never repeat
// across navigations (an old ref can not silently point at a different element on a new page).

declare const document: any;
declare const window: any;
declare const getComputedStyle: any;
declare const CSS: any;
declare const location: any;

export function pageScript(op: string, a: any): any {
  const norm = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const ACTION = new RegExp(a.action || "$^", "iu");
  const LINK_ACTION = new RegExp(a.linkAction || "$^", "iu");
  const TEXT_INPUTS = ["", "text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "week", "time"];
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden" i]), textarea, select, summary, [contenteditable=""], [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="menuitemradio"], [role="option"], [role="switch"], [role="combobox"], [role="textbox"], [role="searchbox"], [role="slider"], ' +
    '[role="spinbutton"], [role="treeitem"], [onclick], [tabindex]:not([tabindex="-1"])';

  // ---------- DOM walking (open shadow roots included) ----------
  function allElements(root: any, out: any[]) {
    const list = root.querySelectorAll("*");
    for (const el of list) {
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, out);
    }
    return out;
  }
  function byRef(ref: string) {
    const sel = '[data-owl-ref="' + CSS.escape(ref) + '"]';
    const direct = document.querySelector(sel);
    if (direct) return direct;
    for (const el of allElements(document, [])) if (el.shadowRoot) {
      const found = el.shadowRoot.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  function visible(el: any) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  // ---------- naming and roles ----------
  function textOfIds(el: any, ids: string) {
    const doc = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : document;
    return ids
      .split(/\s+/)
      .map((id: string) => {
        const t = doc.getElementById(id) || document.getElementById(id);
        return t ? t.innerText || t.textContent || "" : "";
      })
      .join(" ");
  }
  function nameOf(el: any): string {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = norm(textOfIds(el, lb));
      if (t) return t;
    }
    const al = norm(el.getAttribute("aria-label"));
    if (al) return al;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = String(el.type || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return norm(el.value) || (type === "submit" ? "Submit" : "");
      if (type === "image") return norm(el.alt) || norm(el.value) || "Submit";
      const labels = el.labels ? Array.from(el.labels).map((l: any) => l.innerText).join(" ") : "";
      return norm(labels) || norm(el.placeholder) || norm(el.title) || norm(el.getAttribute("data-placeholder")) || norm(el.name);
    }
    const text = norm(el.innerText);
    if (text) return text;
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img && norm(img.alt)) return norm(img.alt);
    if (norm(el.title)) return norm(el.title);
    const svgTitle = el.querySelector && el.querySelector("svg title");
    if (svgTitle) return norm(svgTitle.textContent);
    return norm(el.getAttribute("data-placeholder") || el.getAttribute("placeholder"));
  }
  function roleOf(el: any): string {
    const explicit = norm(el.getAttribute("role"));
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = String(el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "file") return "file";
      if (t === "color") return "color";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  }
  function isEditable(el: any) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return !el.readOnly && !el.disabled;
    if (tag === "input") return TEXT_INPUTS.includes(String(el.getAttribute("type") || "").toLowerCase()) && !el.readOnly && !el.disabled;
    return !!el.isContentEditable || ["textbox", "searchbox", "combobox"].includes(norm(el.getAttribute("role")));
  }
  function isSecret(el: any) {
    return el.getAttribute("data-owl-secret") === "1" || String(el.type || "").toLowerCase() === "password";
  }
  function isSearch(el: any, form: any) {
    if (el.closest && el.closest('[role="search"]')) return true;
    if (String(el.getAttribute("type") || "").toLowerCase() === "search") return true;
    if (!form) return false;
    const hint = [form.id, form.getAttribute("class"), form.getAttribute("action"), form.getAttribute("name"), form.getAttribute("aria-label")].join(" ");
    // "poisk" is Russian for search.
    if (/search|\u043f\u043e\u0438\u0441\u043a/i.test(hint)) return true;
    if (form.querySelector('input[type="search" i]')) {
      const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter((f: any) => {
        const t = String(f.type || "").toLowerCase();
        return !["hidden", "submit", "button", "image", "reset"].includes(t);
      });
      return fields.length <= 3 && !form.querySelector('input[type="password" i]');
    }
    return false;
  }
  function realLink(el: any) {
    if (el.tagName.toLowerCase() !== "a" || el.getAttribute("role") === "button") return false;
    const href = el.getAttribute("href") || "";
    return !!href && !href.startsWith("#") && !/^javascript:/i.test(href);
  }
  /** Is activating this element an action with consequences (form submit, buy, send, delete...)? */
  function classify(el: any) {
    // Clicking a <label> activates its control (which may be a submit button).
    const target = el.tagName === "LABEL" && el.control ? el.control : el;
    const ctrl = (target.closest && target.closest('button, input[type="submit" i], input[type="image" i], a[href], [role="button"], [role="link"], [role="menuitem"]')) || target;
    const tag = ctrl.tagName.toLowerCase();
    const type = String(ctrl.getAttribute("type") || "").toLowerCase();
    const form = ctrl.form || (ctrl.closest && ctrl.closest("form"));
    const label = nameOf(ctrl) + (tag === "input" ? " " + norm(ctrl.value) : "");
    const search = isSearch(ctrl, form);
    let submit = false;
    let reason = "";
    if (realLink(ctrl)) {
      if (LINK_ACTION.test(label)) {
        submit = true;
        reason = "label";
      }
    } else if (ACTION.test(label)) {
      submit = true;
      reason = "label";
    } else if (form && !search && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image")))) {
      submit = true;
      reason = "form";
    }
    return {
      submit,
      reason,
      search,
      inForm: !!form,
      editable: isEditable(el),
      tag: el.tagName.toLowerCase(),
      inputType: el.tagName.toLowerCase() === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : "",
      role: roleOf(el),
      name: cut(nameOf(el), 80),
      href: realLink(ctrl) ? ctrl.href : "",
    };
  }
  function assignRef(el: any) {
    let ref = el.getAttribute("data-owl-ref");
    if (!ref) {
      ref = "e" + a.seq++;
      el.setAttribute("data-owl-ref", ref);
    }
    return ref;
  }
  function shortHref(href: string) {
    try {
      const u = new URL(href, location.href);
      if (u.origin === location.origin) return cut(u.pathname + u.search + u.hash, 80);
      return cut(u.href, 80);
    } catch {
      return cut(href, 80);
    }
  }
  /** A visible modal dialog: only its elements can be used while it is open. */
  function modalRoot() {
    for (const c of document.querySelectorAll('dialog[open], [aria-modal="true"], [role="alertdialog"]')) {
      if (c.tagName === "DIALOG" && !c.matches(":modal")) continue;
      if (visible(c)) return c;
    }
    return null;
  }
  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // ---------- operations ----------
  if (op === "snapshot") {
    const limit = a.limit || 100;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const modal = modalRoot();
    const scope = modal || document;
    const cands: any[] = [];
    // Refs must be unique: cloned nodes (carousels) or a page copying our attributes would make a ref ambiguous.
    const everything = allElements(document, []);
    const counts = new Map();
    for (const el of everything) {
      const r = el.getAttribute && el.getAttribute("data-owl-ref");
      if (r) counts.set(r, (counts.get(r) || 0) + 1);
    }
    for (const el of everything) {
      const r = el.getAttribute && el.getAttribute("data-owl-ref");
      if (r && (counts.get(r) > 1 || !/^e\d+$/.test(r) || Number(r.slice(1)) >= a.seq)) el.removeAttribute("data-owl-ref");
    }
    const els = modal ? allElements(scope, []) : everything;
    let index = 0;
    for (const el of els) {
      index++;
      if (!el.matches || !el.matches(INTERACTIVE)) continue;
      if (el.closest && el.closest("[inert]")) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const dist = r.bottom < 0 ? -r.bottom : r.top > vh ? r.top - vh : r.right < 0 || r.left > vw ? 1 : 0;
      cands.push({ el, r, dist, index });
    }
    const total = cands.length;
    const chosen = cands
      .slice()
      .sort((x, y) => x.dist - y.dist || x.index - y.index)
      .slice(0, limit)
      .sort((x, y) => x.index - y.index);
    const items = chosen.map(({ el, r }) => {
      const c = classify(el);
      const it: any = { ref: assignRef(el), role: c.role, name: c.name };
      if (c.tag === "input" && c.role === "textbox" && c.inputType !== "text") it.inputType = c.inputType;
      const tag = c.tag;
      if (tag === "input" || tag === "textarea") {
        const t = c.inputType;
        if (t === "checkbox" || t === "radio") it.checked = !!el.checked;
        else if (!["submit", "button", "reset", "image", "file"].includes(t)) {
          const v = String(el.value ?? "");
          if (v) it.value = isSecret(el) ? "••••••" : cut(v.replace(/\s+/g, " "), 60);
        }
      } else if (tag === "select") {
        const opts = Array.from(el.options || []);
        const sel = opts.filter((o: any) => o.selected).map((o: any) => norm(o.label || o.text));
        if (sel.length) it.value = cut(sel.join(", "), 60);
        it.options = opts.slice(0, 12).map((o: any) => cut(norm(o.label || o.text), 30));
        if (opts.length > 12) it.options.push("…+" + (opts.length - 12));
      } else if (el.isContentEditable) {
        const v = norm(el.innerText);
        if (v && v !== c.name) it.value = el.getAttribute("data-owl-secret") === "1" ? "••••••" : cut(v, 60);
      } else if (["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio"].includes(c.role)) {
        it.checked = el.getAttribute("aria-checked") === "true";
      }
      if (c.href) it.href = shortHref(c.href);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") it.disabled = true;
      if (c.submit) it.submit = true;
      if (r.bottom < 0) it.pos = "above";
      else if (r.top > vh) it.pos = "below";
      return it;
    });
    return { items, total, seq: a.seq, modal: modal ? cut(nameOf(modal), 80) || "untitled" : "" };
  }

  if (op === "info") {
    const headings: string[] = [];
    for (const h of document.querySelectorAll("h1, h2, h3")) {
      if (headings.length >= 12) break;
      const t = norm(h.innerText);
      if (t && visible(h)) headings.push("#".repeat(Number(h.tagName[1])) + " " + cut(t, 80));
    }
    const alerts: string[] = [];
    for (const al of document.querySelectorAll('[role="alert"], [aria-live="assertive"], .alert, .error')) {
      if (alerts.length >= 3) break;
      const t = norm(al.innerText);
      if (t && visible(al)) alerts.push(cut(t, 160));
    }
    let captcha = false;
    const capSel =
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha" i], ' +
      '.g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running, [class*="captcha" i], [id*="captcha" i]';
    for (const c of document.querySelectorAll(capSel)) {
      if (c.closest(".grecaptcha-badge")) continue;
      const r = c.getBoundingClientRect();
      if (r.width >= 30 && r.height >= 30 && visible(c)) {
        captcha = true;
        break;
      }
    }
    if (!captcha) {
      const sample = (document.title + " " + String((document.body && document.body.innerText) || "").slice(0, 1500)).toLowerCase();
      // Russian: "confirm that you are not a robot", "I'm not a robot", "browser check".
      captcha = /just a moment|verify you are (a )?human|are you a robot|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435, \u0447\u0442\u043e \u0432\u044b \u043d\u0435 \u0440\u043e\u0431\u043e\u0442|\u044f \u043d\u0435 \u0440\u043e\u0431\u043e\u0442|\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430/.test(sample);
    }
    const se = document.scrollingElement || document.documentElement;
    return {
      title: document.title,
      url: location.href,
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(se ? se.scrollHeight : 0),
      viewportHeight: window.innerHeight,
      headings,
      alerts,
      captcha,
    };
  }

  if (op === "text") {
    let root = document.body;
    const main = document.querySelector('main, [role="main"], article');
    if (main && norm(main.innerText).length > 200) root = main;
    const raw = String((root && root.innerText) || "");
    const text = raw
      .split("\n")
      .map((l: string) => l.replace(/[ \t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text: text.slice(0, a.maxChars), total: text.length };
  }

  if (op === "classify") {
    const el = byRef(a.ref);
    if (!el) return null;
    return classify(el);
  }

  if (op === "focus") {
    // document.hasFocus() is not used on purpose: a headed window without OS focus would report false.
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement) return { none: true };
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { frame: true };
    const c = classify(el);
    return { ref: assignRef(el), seq: a.seq, tag: c.tag, name: c.name, editable: c.editable, inForm: c.inForm, search: c.search, submit: c.submit, reason: c.reason };
  }

  if (op === "markSecret") {
    const el = byRef(a.ref);
    if (!el) return false;
    el.setAttribute("data-owl-secret", "1");
    if (String(el.type || "").toLowerCase() !== "password") el.style.setProperty("-webkit-text-security", "disc", "important");
    return true;
  }

  if (op === "scroll") {
    const se = document.scrollingElement || document.documentElement;
    return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), h: Math.round(se.scrollHeight), vh: window.innerHeight, w: Math.round(se.scrollWidth), vw: window.innerWidth };
  }

  if (op === "scrollBy") {
    window.scrollBy(a.dx, a.dy);
    return true;
  }

  throw new Error("unknown page op " + op);
}

const SRC = `(${pageScript.toString()})`;

/** Expression for frame.evaluate(): runs `op` with JSON-serializable args. */
export function pageCall(op: string, args: Record<string, unknown> = {}): string {
  return `${SRC}(${JSON.stringify(op)}, ${JSON.stringify(args)})`;
}
