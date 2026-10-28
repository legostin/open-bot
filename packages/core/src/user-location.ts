// Where the user is, as their phone says (the Owlbot app, once they turn location sharing on there): only the last
// place, kept in the settings store. Agents see it in their `[You now]` block and ask for the exact point with
// user_location. Turning sharing off forgets it, and so does unpairing the phone.
import type { ISODate } from "@owlbot/shared";
import type { Settings } from "./settings.ts";

export interface UserLocation {
  lat: number;
  lon: number;
  /** How far off the point may be, in metres. */
  accuracyM?: number;
  /** The phone's own name for the place: "Dostyk Ave 52, Medeu District, Almaty, Kazakhstan". */
  place?: string;
  at: ISODate;
  deviceId: string;
  deviceName: string;
}

const KEY = "userLocation";
/** Older than this, the place is "last known" and may be out of date. */
const FRESH_MS = 6 * 3600_000;

const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

export class UserLocations {
  settings: Settings;
  /** The phone is still paired: a place from a phone that was unpaired since does not count. */
  paired: (deviceId: string) => boolean;

  constructor(settings: Settings, paired: (deviceId: string) => boolean) {
    this.settings = settings;
    this.paired = paired;
  }

  get(): UserLocation | undefined {
    const l = this.settings.getKey<UserLocation | null>(KEY, null);
    if (l && !this.paired(l.deviceId)) {
      this.settings.setKey(KEY, null);
      return undefined;
    }
    return l ?? undefined;
  }

  /** What the phone sent (POST /api/devices/location), checked; undefined when it is not a place. */
  set(device: { id: string; name: string }, body: unknown, now = new Date()): UserLocation | undefined {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const lat = num(b.lat, -90, 90);
    const lon = num(b.lon, -180, 180);
    if (lat === undefined || lon === undefined) return undefined;
    const accuracy = num(b.accuracy, 0, 1_000_000);
    const at = typeof b.at === "string" && !Number.isNaN(Date.parse(b.at)) && Date.parse(b.at) <= now.getTime() + 60_000 ? new Date(b.at).toISOString() : now.toISOString();
    const place = typeof b.place === "string" ? b.place.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const l: UserLocation = { lat, lon, ...(accuracy !== undefined ? { accuracyM: Math.round(accuracy) } : {}), ...(place ? { place } : {}), at, deviceId: device.id, deviceName: device.name };
    // A phone's late report does not replace a newer one from another phone.
    const cur = this.get();
    if (cur && cur.deviceId !== device.id && cur.at > at) return cur;
    this.settings.setKey(KEY, l);
    return l;
  }

  /** Sharing turned off on this phone: its place goes. */
  forget(deviceId: string): void {
    if (this.get()?.deviceId === deviceId) this.settings.setKey(KEY, null);
  }

  /** The `[You now]` line: "Dostyk Ave 52, Almaty (from the phone “iPhone”, as of 23:05)". */
  line(time: (iso: string) => string, now = Date.now()): string | undefined {
    const l = this.get();
    if (!l) return undefined;
    const where = l.place ?? `${l.lat}, ${l.lon}`;
    const stale = now - Date.parse(l.at) > FRESH_MS;
    return `${stale ? "last known near " : ""}${where} (from the phone “${l.deviceName}”, as of ${time(l.at)}${stale ? "; may be out of date" : ""})`;
  }
}
