import { DateTime } from "luxon";
import { settings } from "../shared/settings";

export type ApiError = Error & { status?: number; fields?: Record<string, string> };
export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`) as ApiError;
    e.status = res.status; e.fields = data.fields; throw e;
  }
  return data as T;
}

let serverOffset = 0;
export async function syncNow() {
  try { const { now } = await api<{ now: string }>("/api/now"); serverOffset = Date.parse(now) - Date.now(); } catch { /* keep 0 */ }
}
export const nowMs = () => Date.now() + serverOffset;

export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export function allZones(): string[] {
  const s = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf("timeZone") as string[] : [browserTz()];
  return s.includes("UTC") ? s : ["UTC", ...s];
}
export function zoneLabel(z: string) {
  const o = DateTime.fromMillis(nowMs(), { zone: z }).offset;
  const h = Math.trunc(Math.abs(o) / 60), m = Math.abs(o) % 60;
  return `${z} (GMT${o === 0 ? "" : (o < 0 ? "-" : "+") + h + (m ? ":" + String(m).padStart(2, "0") : "")})`;
}
export function fmtTime(iso: string | number, tz: string, f: 12 | 24) {
  const d = typeof iso === "number" ? DateTime.fromMillis(iso, { zone: tz }) : DateTime.fromISO(iso, { zone: tz });
  return f === 24 ? d.toFormat("HH:mm") : d.toFormat("h:mma").toLowerCase();
}
export function fmtMin(min: number, f: 12 | 24, end = false) {
  if (end && min === 1440) return f === 24 ? "24:00" : "12:00am (end of day)";
  const h = Math.floor(min / 60) % 24, m = min % 60;
  if (f === 24) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}
export const fmtDay = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).toFormat("cccc, LLLL d, yyyy");
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekOrder = (ws: string) => (ws === "sunday" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0]);
export const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export const LOCATION_LABEL: Record<string, string> = { video: "Video call", phone: "Phone call", in_person: "In person", custom: "Custom" };

export function summarize(hours: { weekday: number; startMin: number; endMin: number }[], f: 12 | 24, ws = "monday") {
  if (!hours.length) return "No hours set";
  const order = weekOrder(ws);
  const key = (d: number) => hours.filter((h) => h.weekday === d).sort((a, b) => a.startMin - b.startMin).map((h) => `${fmtMin(h.startMin, f)} - ${fmtMin(h.endMin, f, true)}`).join(", ");
  const groups = new Map<string, number[][]>();
  for (const d of order) {
    const k = key(d); if (!k) continue;
    const runs = groups.get(k) ?? [];
    const last = runs[runs.length - 1];
    if (last && order.indexOf(last[last.length - 1]) === order.indexOf(d) - 1) last.push(d); else runs.push([d]);
    groups.set(k, runs);
  }
  return [...groups.entries()].map(([k, runs]) => runs.map((r) => (r.length > 2 ? `${SHORT[r[0]]} - ${SHORT[r[r.length - 1]]}` : r.map((d) => SHORT[d]).join(", "))).join(", ") + ", " + k).join("; ");
}
export { settings };
export function isZoneOk(z: string) { try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return true; } catch { return false; } }
