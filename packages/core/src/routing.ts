// Routes along roads and paths for show_map. The hub asks OSRM (by default the public servers of OpenStreetMap
// Germany, FOSSGIS: car, bike and foot profiles) for the line, its length and time. Public transport has no free
// router: its line is straight between the stops, and the map's "Open in…" links let a maps app plan it.
import type { RouteMode } from "@piomio/shared";

const PROFILE: Record<Exclude<RouteMode, "transit">, string> = { walk: "routed-foot", drive: "routed-car", bike: "routed-bike" };
/** Points kept in a route's line: enough for a smooth line at street level, small enough for a message. */
const MAX_POINTS = 400;
const TIMEOUT_MS = 10_000;

export interface RoadRoute {
  path: Array<[number, number]>;
  distanceM: number;
  durationS: number;
}

/** The route through `stops` ([lat, lon]) along roads or paths, or why there is none. */
export async function roadRoute(base: string, mode: Exclude<RouteMode, "transit">, stops: Array<[number, number]>, fetchImpl: typeof fetch = fetch): Promise<RoadRoute | { error: string }> {
  const coords = stops.map(([lat, lon]) => `${lon},${lat}`).join(";");
  const url = `${base}/${PROFILE[mode]}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    const r = await fetchImpl(url, { headers: { "user-agent": "Piomio (self-hosted personal agent hub)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { error: `the router answered ${r.status}` };
    const j = (await r.json()) as { code?: string; message?: string; routes?: Array<{ distance: number; duration: number; geometry?: { coordinates?: Array<[number, number]> } }> };
    const best = j.routes?.[0];
    const line = best?.geometry?.coordinates;
    if (j.code !== "Ok" || !best || !line?.length) return { error: j.message ?? j.code ?? "no route" };
    const path = line.map(([lon, lat]) => [round(lat), round(lon)] as [number, number]);
    return { path: simplify(path, MAX_POINTS), distanceM: Math.round(best.distance), durationS: Math.round(best.duration) };
  } catch (e) {
    return { error: (e as Error).name === "TimeoutError" ? "the router did not answer" : (e as Error).message };
  }
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Douglas–Peucker with a growing tolerance until the line has at most `max` points; the ends always stay. A line that
 * wiggles evenly collapses all at once at some tolerance: then every n-th point of the last version that was too long.
 */
export function simplify(path: Array<[number, number]>, max: number): Array<[number, number]> {
  let prev = path;
  for (let tol = 0.00001; prev.length > max; tol *= 2) {
    const next = dp(path, tol);
    if (next.length <= max) return next.length >= max / 4 ? next : sample(prev, max);
    prev = next;
  }
  return prev;
}

function sample(path: Array<[number, number]>, max: number): Array<[number, number]> {
  const step = (path.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => path[Math.round(i * step)]);
}

function dp(path: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (path.length < 3) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let dist = tol;
    for (let i = a + 1; i < b; i++) {
      const d = offLine(path[i], path[a], path[b]);
      if (d > dist) {
        dist = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return path.filter((_, i) => keep[i]);
}

/** How far p is from the segment a–b, in degrees (good enough at the scale of a route). */
function offLine(p: [number, number], a: [number, number], b: [number, number]): number {
  const [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
