// What the build baked into the page (scripts/build.mjs → vite.config.ts → __SITE_DATA__).

export interface SiteData {
  /** Where the site lives: "/" with a domain, "/piomio/" on GitHub Pages. */
  base: string;
  /** The site's own address, for canonical links and Open Graph (no trailing slash). */
  origin: string;
  release: {
    version?: string;
    /** Direct links to the latest installers, when the build could ask GitHub. */
    mac?: string;
    win?: string;
    page: string;
  };
  stars?: number;
  testflightUrl: string;
  repo: string;
}

declare const __SITE_DATA__: SiteData;

export const data: SiteData = __SITE_DATA__;
