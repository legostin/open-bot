// Pages agents make (core/src/pages.ts, packages/pages-kit): what a page's code may import. The hub refuses anything
// else when it compiles a page; the kit's `require` hands these out.

export const PAGE_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "lucide-react",
  "clsx",
  "class-variance-authority",
  "tailwind-merge",
  "@/lib/utils",
  "@piomio/ui",
  "@piomio/page",
] as const;

/** shadcn's own import paths ("@/components/ui/card"): every component comes from the kit's one ui module. */
export const PAGE_UI_MODULE = /^(?:@\/components\/ui|components\/ui|@piomio\/ui)(?:\/[\w-]+)?$/;

export function pageModuleAllowed(name: string): boolean {
  return (PAGE_MODULES as readonly string[]).includes(name) || PAGE_UI_MODULE.test(name);
}
