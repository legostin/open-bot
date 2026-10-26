// Markdown renderer for messages. Raw HTML is never rendered: HTML nodes are turned into plain text.

import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon, Lock } from "lucide-react";
import { t } from "../i18n";
import { mediaSrc } from "../lib/media";
import { remarkUserText } from "../lib/user-markdown";
import { CopyButton, cx } from "./ui";

type MdNode = { type: string; value?: string; children?: MdNode[] };

/** remark plugin: show raw HTML as literal text instead of dropping or rendering it. */
function remarkHtmlAsText() {
  return (tree: MdNode) => {
    const walk = (n: MdNode) => {
      if (n.type === "html") n.type = "text";
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  // The page CSP loads images from the hub only (img-src 'self' data: blob:): web images come through its proxy.
  // Anything else (another scheme, a relative path) stays a link.
  img: ({ src, alt }) => {
    const s = typeof src === "string" ? src : "";
    const shown = s ? mediaSrc(s) : undefined;
    if (shown) return <img src={shown} alt={alt ?? ""} className="my-2 inline-block max-h-96 max-w-full rounded-xl border border-border" loading="lazy" decoding="async" />;
    return (
      <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1">
        <ImageIcon className="inline size-4" />
        {alt || t("common.image")}
      </a>
    );
  },
  pre: ({ children }) => (
    <div className="group relative">
      <pre>{children}</pre>
      <CopyButton text={textOf(children).replace(/\n$/, "")} label="" className="absolute top-1.5 right-1.5 bg-surface/80 opacity-0 transition group-hover:opacity-100 focus:opacity-100" />
    </div>
  ),
  input: ({ checked, type }) => (type === "checkbox" ? <input type="checkbox" checked={!!checked} readOnly disabled /> : null),
  // A secret the hub took out of the user's message (lib/user-markdown.ts).
  span: ({ className, children }) =>
    className === "vault-ref" ? (
      <span className="vault-ref">
        <Lock className="size-3" />
        {children}
      </span>
    ) : (
      <span className={className}>{children}</span>
    ),
};

const ASSISTANT_PLUGINS = [remarkGfm, remarkHtmlAsText];
const USER_PLUGINS = [remarkGfm, remarkHtmlAsText, remarkUserText];

/** `user`: what the user typed (line breaks kept, vault chips) rather than an agent's reply. */
export const Markdown = memo(function Markdown({ text, className, user }: { text: string; className?: string; user?: boolean }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown remarkPlugins={user ? USER_PLUGINS : ASSISTANT_PLUGINS} components={components} skipHtml={false}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
