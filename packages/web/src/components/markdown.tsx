// Markdown renderer for messages. Raw HTML is never rendered: HTML nodes are turned into plain text.

import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon } from "lucide-react";
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

function isLocalSrc(src: string): boolean {
  return src.startsWith("/") && !src.startsWith("//") ? true : src.startsWith("data:image/") || src.startsWith("blob:");
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
  // External images would violate the page CSP (img-src 'self' data: blob:): show them as links.
  img: ({ src, alt }) => {
    const s = typeof src === "string" ? src : "";
    if (s && isLocalSrc(s)) return <img src={s} alt={alt ?? ""} className="my-2 max-h-96 max-w-full rounded-lg border border-border" loading="lazy" />;
    return (
      <a href={s} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1">
        <ImageIcon className="inline size-4" />
        {alt || "изображение"}
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
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} components={components} skipHtml={false}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
