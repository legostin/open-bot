// The app's own screens (window "setup"): how this computer is used, connecting it to a hub (also from an
// owlbot://pair link), "starting" and "did not start". The hub's UI opens in its own window and gets no app commands.

import { invoke } from "@tauri-apps/api/core";
import en from "../../../../packaging/desktop/locales/en.json";
import ru from "../../../../packaging/desktop/locales/ru.json";

type Mode = "hub" | "node";
interface UiState {
  lang: "en" | "ru";
  /** The test build ("Owlbot Test"): a strip on top says so. */
  test: boolean;
  /** "Reset Owlbot…" from the tray waits for a confirmation here. */
  reset: boolean;
  mode: Mode | null;
  starting: boolean;
  existing: { hub: string; name: string } | null;
  link: { hub: string; code: string } | null;
  error: { key: string; port: number | null } | null;
  hostname: string;
}

const catalogs: Record<string, Record<string, string>> = { en, ru };
let lang = "en";
let test = false;

/** A catalog text in the app's language, English when it has none; `{name}` placeholders from `params`. */
function t(key: string, params: Record<string, string | number> = {}): string {
  const s = catalogs[lang]?.[key] ?? catalogs.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

type Child = Node | string | null | false | undefined;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c) e.append(c);
  return e;
}

function show(...children: Child[]): void {
  const strip = test && h("p", { class: "test-build" }, t("app.testBuild"));
  document.getElementById("root")!.replaceChildren(h("main", {}, strip, ...children));
}

function button(text: string, onClick: () => void, kind = "secondary"): HTMLButtonElement {
  const b = h("button", { type: "button", class: kind }, text) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

function input(value: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const i = h("input", { spellcheck: "false", ...attrs }) as HTMLInputElement;
  i.value = value;
  return i;
}

function field(label: string, control: HTMLInputElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control, hint && h("small", {}, hint));
}

/** Runs an app command with the screen's controls disabled; a failure shows its text in `note`. */
async function run(note: HTMLElement, cmd: string, args: Record<string, unknown> = {}): Promise<void> {
  const controls = [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
  controls.forEach((c) => (c.disabled = true));
  note.textContent = "";
  try {
    await invoke(cmd, args);
  } catch (e) {
    note.textContent = String(e);
    controls.forEach((c) => (c.disabled = false));
  }
}

function choice(title: string, body: string, onClick: () => void): HTMLElement {
  const b = h("button", { type: "button", class: "choice" }, h("strong", {}, title), h("span", {}, body));
  b.addEventListener("click", onClick);
  return b;
}

function welcome(state: UiState): void {
  const note = h("p", { class: "error" });
  show(
    h("h1", {}, t("app.welcome.title")),
    choice(t("app.welcome.hub.title"), t("app.welcome.hub.body"), () => void run(note, "choose_hub")),
    choice(t("app.welcome.node.title"), t("app.welcome.node.body"), () => pairForm(state)),
    state.existing && button(t("app.pair.useExisting", { hub: state.existing.hub }), () => void run(note, "use_existing_node"), "link"),
    note,
  );
}

/** The invite link (the node CLI reads it) and the machine name; an owlbot://pair link brings the hub and code. */
function pairForm(state: UiState, link?: { hub: string; code: string }): void {
  const invite = input("", { type: "url", placeholder: "https://owlbot.example.ts.net/join/AB12CD34", required: "" });
  const name = input(state.hostname, { maxlength: "60" });
  const note = h("p", { class: "error" });
  const form = h(
    "form",
    {},
    link ? null : field(t("app.pair.link"), invite, t("app.pair.linkHint")),
    field(t("app.pair.name"), name),
    note,
    h(
      "div",
      { class: "row" },
      link ? button(t("app.link.cancel"), () => void invoke("dismiss")) : button(t("app.pair.back"), () => welcome(state)),
      h("button", { type: "submit", class: "primary" }, t("app.pair.submit")),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run(note, "pair", link ? { hub: link.hub, code: link.code, name: name.value } : { hub: invite.value, code: "", name: name.value });
  });
  if (link) {
    show(h("h1", {}, t("app.link.title", { hub: link.hub })), h("p", { class: "muted" }, t("app.link.body", { hub: link.hub })), state.mode === "hub" && h("p", {}, t("app.link.hubMode")), form);
  } else {
    show(h("h1", {}, t("app.pair.title")), form);
  }
  (link ? name : invite).focus();
}

function errorScreen(state: UiState, error: NonNullable<UiState["error"]>): void {
  const note = h("p", { class: "error" });
  show(
    h("h1", {}, t("app.error.title")),
    h("p", {}, t(error.key, { port: error.port ?? "" })),
    note,
    h("div", { class: "row" }, button(t("tray.logs"), () => void invoke("open_log")), state.mode ? button(t("app.error.retry"), () => void run(note, "retry"), "primary") : null),
  );
}

/** "Reset Owlbot…": what goes, what stays, and the two ways out. */
function resetScreen(): void {
  const note = h("p", { class: "error" });
  show(
    h("h1", {}, t("app.reset.title")),
    h("p", {}, t("app.reset.body")),
    h("p", { class: "muted" }, t("app.reset.keeps")),
    note,
    h(
      "div",
      { class: "row" },
      button(t("app.link.cancel"), () => void invoke("dismiss")),
      button(t("app.reset.quit"), () => void run(note, "reset_app", { quit: true }), "danger"),
      button(t("app.reset.startOver"), () => void run(note, "reset_app", { quit: false }), "danger-primary"),
    ),
  );
}

async function render(): Promise<void> {
  const state = await invoke<UiState>("get_state");
  lang = state.lang;
  test = state.test;
  document.documentElement.lang = lang;
  if (state.reset) resetScreen();
  else if (state.error) errorScreen(state, state.error);
  else if (state.link) pairForm(state, state.link);
  else if (state.starting) {
    show(h("h1", {}, t("tray.starting")));
    setTimeout(() => void render(), 1000);
  } else welcome(state);
}

void render();
