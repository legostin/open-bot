// Where the pictures and maps of a message come from. The page CSP loads images from the hub only (img-src 'self'),
// so web images go through the hub's proxy and workspace files through /api/files.

/** OpenStreetMap tiles, fetched and cached by the hub. */
export const TILE_URL = "/api/map/tiles/{z}/{x}/{y}.png";
export const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

/** Sources the page may load as they are: same-origin paths, inline images and blobs. */
export function isLocalSrc(src: string): boolean {
  return (src.startsWith("/") && !src.startsWith("//")) || src.startsWith("data:image/") || src.startsWith("blob:");
}

/** The address the page loads an image part's `src` from, or undefined when it cannot be shown. */
export function mediaSrc(src: string): string | undefined {
  const s = src.trim();
  if (s.startsWith("file:")) return s.length > 5 ? `/api/files?path=${encodeURIComponent(s.slice(5))}` : undefined;
  if (/^https?:\/\//i.test(s)) return `/api/media?url=${encodeURIComponent(s)}`;
  return isLocalSrc(s) ? s : undefined;
}

/** Where "open the original" leads: the page the picture is on the web, or a download of the workspace file. */
export function originalHref(src: string): { href: string; download: boolean } | undefined {
  const s = src.trim();
  if (/^https?:\/\//i.test(s)) return { href: s, download: false };
  if (s.startsWith("file:") && s.length > 5) return { href: `/api/files?path=${encodeURIComponent(s.slice(5))}&download=1`, download: true };
  return undefined;
}

/** The same place on openstreetmap.org, with a marker. */
export function osmLink(lat: number, lon: number, zoom = 16): string {
  const z = Math.max(1, Math.min(19, Math.round(zoom)));
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${z}/${lat}/${lon}`;
}

/** "48.8584, 2.2945": coordinates for people, five decimals at most. */
export function formatCoords(lat: number, lon: number): string {
  const f = (n: number) => String(Math.round(n * 1e5) / 1e5);
  return `${f(lat)}, ${f(lon)}`;
}

/** Index of the slide a carousel shows: the one whose left edge is nearest the scroll position (the last at the end). */
export function activeSlide(slideLefts: number[], scrollLeft: number, maxScroll: number): number {
  if (!slideLefts.length) return 0;
  if (maxScroll > 0 && scrollLeft >= maxScroll - 2) return slideLefts.length - 1;
  let best = 0;
  for (let i = 1; i < slideLefts.length; i++) if (Math.abs(slideLefts[i] - scrollLeft) < Math.abs(slideLefts[best] - scrollLeft)) best = i;
  return best;
}

/** i moved by `step`, wrapping around n items. */
export function wrapIndex(i: number, step: number, n: number): number {
  return n > 0 ? (((i + step) % n) + n) % n : 0;
}
