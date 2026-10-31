// Types for shop.mjs (plain JS, so the render script can run it in Node as is).
export declare const PAGES: readonly ["home", "catalogue", "product", "product2", "cart", "done"];
export declare function domainOf(locale: string): string;
export declare function titleOf(locale: string, page: string): string;
export declare function pathOf(page: string): string;
export declare function render(locale: string, page: string): string;
