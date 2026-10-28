// The kit every page runs on: one classic script (build.mjs) the hub serves at /p/kit/<hash>/kit.js. The hub compiles
// a page's TSX to CommonJS and serves it wrapped as `owlbotPage(function (require, exports, module) { … })`; `require`
// hands out React, the shadcn/ui components, lucide icons and Owlbot's blocks (the names in shared/src/pages.ts), and
// the kit renders the page's default export. In the page's JSX, pictures from other sites go through the page's image
// route and outside links open outside the page.
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as icons from "lucide-react";
import * as clsx from "clsx";
import * as cva from "class-variance-authority";
import * as twMerge from "tailwind-merge";
import { AlertTriangle } from "lucide-react";
import { pageModuleAllowed, PAGE_UI_MODULE } from "../../shared/src/pages.ts";
import * as ui from "./ui";
import * as utils from "./lib/utils";
import * as runtime from "./runtime";
import { Map } from "./blocks/map";
import { useWeather, Weather, weatherKind } from "./blocks/weather";
import { Gallery, Hero, Video } from "./blocks/media";
import { directionsUrl, Place, Stat } from "./blocks/place";
import { setLocale, t } from "./i18n";
import "./kit.css";

const EXTERNAL = /^https?:\/\//i;

/** Props of a host element as the page's JSX gives them, made to work inside the page. */
function fix(type: unknown, props: any): any {
  if (typeof type !== "string" || !props) return props;
  if (type === "img" && typeof props.src === "string" && EXTERNAL.test(props.src)) return { ...props, src: runtime.proxied(props.src), srcSet: undefined };
  if (type === "video" && typeof props.poster === "string" && EXTERNAL.test(props.poster)) return { ...props, poster: runtime.proxied(props.poster) };
  if (type === "a" && typeof props.href === "string" && /^(https?:|mailto:|tel:)/i.test(props.href)) {
    const href: string = props.href;
    const own = props.onClick as ((e: React.MouseEvent) => void) | undefined;
    return {
      ...props,
      target: "_blank",
      rel: "noopener noreferrer",
      onClick: (e: React.MouseEvent) => {
        own?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        runtime.openLink(href);
      },
    };
  }
  return props;
}

const jsx = (type: any, props: any, key?: any) => jsxRuntime.jsx(type, fix(type, props), key);
const jsxs = (type: any, props: any, key?: any) => jsxRuntime.jsxs(type, fix(type, props), key);
const jsxForPages = { Fragment: jsxRuntime.Fragment, jsx, jsxs, jsxDEV: jsx };
const reactForPages = { ...React, createElement: (type: any, props: any, ...children: any[]) => React.createElement(type, fix(type, props), ...children) };

const uiForPages = {
  ...ui,
  AvatarImage: ({ src, ...props }: React.ComponentProps<typeof ui.AvatarImage>) => <ui.AvatarImage src={runtime.proxied(src)} {...props} />,
};

const page = {
  useData: runtime.useData,
  ask: runtime.ask,
  openLink: runtime.openLink,
  proxied: runtime.proxied,
  getJson: runtime.getJson,
  useJson: runtime.useJson,
  useStored: runtime.useStored,
  pageInfo: runtime.pageInfo,
  Map,
  Weather,
  useWeather,
  weatherKind,
  Gallery,
  Video,
  Hero,
  Place,
  Stat,
  directionsUrl,
};

const modules: Record<string, unknown> = {
  react: reactForPages,
  "react/jsx-runtime": jsxForPages,
  "react/jsx-dev-runtime": jsxForPages,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "lucide-react": icons,
  clsx,
  "class-variance-authority": cva,
  "tailwind-merge": twMerge,
  "@/lib/utils": utils,
  "@owlbot/ui": uiForPages,
  "@owlbot/page": page,
};

function require(name: string): unknown {
  if (name in modules) return modules[name];
  if (PAGE_UI_MODULE.test(name)) return uiForPages;
  if (!pageModuleAllowed(name)) throw new Error(`"${name}" is not available on pages`);
  throw new Error(`"${name}" is missing from the kit`);
}

function ErrorScreen({ message }: { message: string }) {
  const title = runtime.pageInfo().title;
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" />
      </span>
      <h1 className="text-lg font-semibold">{t("error.title")}</h1>
      <pre className="max-w-full overflow-auto rounded-lg bg-muted px-3 py-2 text-left font-mono text-xs whitespace-pre-wrap text-muted-foreground">{message}</pre>
      <ui.Button onClick={() => runtime.ask(t("error.ask", { title, message }))}>{t("error.fix")}</ui.Button>
    </div>
  );
}

class Boundary extends React.Component<{ children: React.ReactNode }, { message?: string }> {
  state: { message?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { message: runtime.reportError(error) };
  }
  render() {
    return this.state.message ? <ErrorScreen message={this.state.message} /> : this.props.children;
  }
}

/** Light or dark: the chat says which in the URL's hash (#dark, #light); alone, the page follows the system. */
function theme(): void {
  const pinned = /\b(dark|light)\b/.exec(location.hash)?.[1];
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);
  apply(pinned ? pinned === "dark" : media.matches);
  if (!pinned) media.addEventListener("change", (e) => apply(e.matches));
  window.addEventListener("message", (e) => {
    if (e.source === window.parent && e.data?.owlbot && typeof e.data.dark === "boolean") apply(e.data.dark);
  });
}

function start(factory: (require: (name: string) => unknown, exports: Record<string, unknown>, module: { exports: Record<string, unknown> }) => void): void {
  const holder = document.getElementById("owlbot-page");
  const info = JSON.parse(holder?.textContent || "{}") as runtime.PageInfo;
  runtime.setPageInfo({ ...info, state: info.state ?? {} });
  setLocale(info.locale ?? "en");
  theme();
  window.addEventListener("error", (e) => runtime.reportError(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => runtime.reportError(e.reason));

  const root = ReactDOMClient.createRoot(document.getElementById("root")!);
  let content: React.ReactNode;
  try {
    const module = { exports: {} as Record<string, unknown> };
    factory(require, module.exports, module);
    const Page = (module.exports.default ?? module.exports.Page) as React.ComponentType<{ data: unknown }> | undefined;
    if (typeof Page !== "function") throw new Error("The page has no default export: export default function Page() { … }");
    content = (
      <Boundary>
        <Page data={info.data} />
      </Boundary>
    );
  } catch (e) {
    content = <ErrorScreen message={runtime.reportError(e)} />;
  }
  root.render(<ui.TooltipProvider>{content}</ui.TooltipProvider>);
  runtime.post({ type: "ready", title: info.title });
}

(window as unknown as { owlbotPage: typeof start }).owlbotPage = start;
