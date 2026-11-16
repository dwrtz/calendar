// iCal (RFC 5545) reader and recurrence expansion for busy times (R17). Pure, no I/O.
import { DateTime } from "luxon";

export type Prop = { name: string; params: Record<string, string>; value: string };
type When = { ms: number; allDay: boolean; date?: string; zone: string; dt: DateTime };
export type IcsEvent = {
  uid: string; start: When; end?: When; durationMs?: number; rrule?: Record<string, string>; exdates: When[];
  recurrenceId?: When; transparent: boolean; cancelled: boolean;
};
export type BusyRange = { start_ms: number; end_ms: number };

const WINDOWS_ZONES: Record<string, string> = {
  "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix", "Pacific Standard Time": "America/Los_Angeles", "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu", "Atlantic Standard Time": "America/Halifax", "Canada Central Standard Time": "America/Regina",
  "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik", "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris", "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow", "Israel Standard Time": "Asia/Jerusalem", "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata", "China Standard Time": "Asia/Shanghai", "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo", "Korea Standard Time": "Asia/Seoul", "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane", "Cen. Australia Standard Time": "Australia/Adelaide", "W. Australia Standard Time": "Australia/Perth",
  "New Zealand Standard Time": "Pacific/Auckland", "SA Pacific Standard Time": "America/Bogota", "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires", "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo",
  "UTC": "UTC", "Coordinated Universal Time": "UTC",
};
export function resolveZone(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  let z = tzid.replace(/^"|"$/g, "").trim();
  if (WINDOWS_ZONES[z]) return WINDOWS_ZONES[z];
  const m = z.match(/([A-Za-z]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?)$/); // "/mozilla.org/.../America/New_York"
  if (m) z = m[1];
  return DateTime.local().setZone(z).isValid ? z : fallback;
}

export function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/).filter((l) => l.length);
}
export function parseLine(line: string): Prop {
  let i = 0, q = false;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ":" && !q) break; }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const bits: string[] = []; let cur = ""; q = false;
  for (const c of head) { if (c === '"') q = !q; if (c === ";" && !q) { bits.push(cur); cur = ""; } else cur += c; }
  bits.push(cur);
  const params: Record<string, string> = {};
  for (const p of bits.slice(1)) { const k = p.indexOf("="); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ""); }
  return { name: bits[0].toUpperCase(), params, value };
}

function parseWhen(value: string, params: Record<string, string>, hostZone: string): When | undefined {
  const v = value.trim();
  const d = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d || params.VALUE === "DATE") {
    if (!d) return undefined;
    const dt = DateTime.fromObject({ year: +d[1], month: +d[2], day: +d[3] }, { zone: hostZone });
    return dt.isValid ? { ms: dt.toMillis(), allDay: true, date: `${d[1]}-${d[2]}-${d[3]}`, zone: hostZone, dt } : undefined;
  }
  const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!t) return undefined;
  const zone = t[7] ? "UTC" : resolveZone(params.TZID, hostZone);
  const dt = DateTime.fromObject({ year: +t[1], month: +t[2], day: +t[3], hour: +t[4], minute: +t[5], second: +t[6] }, { zone });
  return dt.isValid ? { ms: dt.toMillis(), allDay: false, zone, dt } : undefined;
}
export function parseDuration(v: string): number | undefined {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return undefined;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

export function parseEvents(text: string, hostZone: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Prop[] | null = null, depth = 0;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") { cur = []; depth = 0; continue; }
    if (!cur) continue;
    if (p.name === "BEGIN") { depth++; continue; } // VALARM etc.
    if (p.name === "END" && depth > 0) { depth--; continue; }
    if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
      const ev = toEvent(cur, hostZone); if (ev) out.push(ev); cur = null; continue;
    }
    if (depth === 0) cur.push(p);
  }
  return out;
}
function toEvent(props: Prop[], hostZone: string): IcsEvent | undefined {
  const get = (n: string) => props.find((p) => p.name === n);
  const ds = get("DTSTART"); if (!ds) return undefined;
  const start = parseWhen(ds.value, ds.params, hostZone); if (!start) return undefined;
  const de = get("DTEND"); const end = de ? parseWhen(de.value, de.params, hostZone) : undefined;
  const du = get("DURATION"); const durationMs = du ? parseDuration(du.value) : undefined;
  const rr = get("RRULE");
  const rrule = rr ? Object.fromEntries(rr.value.split(";").map((kv) => { const [k, v] = kv.split("="); return [k.toUpperCase(), (v ?? "").toUpperCase()]; })) : undefined;
  const exdates: When[] = [];
  for (const p of props.filter((p) => p.name === "EXDATE")) for (const v of p.value.split(",")) { const w = parseWhen(v, p.params, hostZone); if (w) exdates.push(w); }
  const ri = get("RECURRENCE-ID");
  return {
    uid: get("UID")?.value ?? "", start, end, durationMs, rrule, exdates,
    recurrenceId: ri ? parseWhen(ri.value, ri.params, hostZone) : undefined,
    transparent: (get("TRANSP")?.value ?? "").toUpperCase() === "TRANSPARENT",
    cancelled: (get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
  };
}

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]; // luxon weekday 1..7
function untilMs(v: string | undefined, start: When, hostZone: string): number {
  if (!v) return Infinity;
  const w = parseWhen(v, start.allDay ? { VALUE: "DATE" } : start.zone === "UTC" ? {} : { TZID: start.zone }, start.zone === "UTC" ? "UTC" : hostZone)
    ?? parseWhen(v, {}, start.zone);
  if (!w) return Infinity;
  return w.allDay ? w.dt.endOf("day").toMillis() : w.ms;
}
/** Start times (as DateTimes in the event's zone) of a recurring series, up to `toMs` and at most 2000 instances. */
export function occurrences(ev: IcsEvent, toMs: number, hostZone: string): DateTime[] {
  const r = ev.rrule; const s = ev.start.dt;
  if (!r) return [s];
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = untilMs(r.UNTIL, ev.start, hostZone);
  const out: DateTime[] = [];
  const time = { hour: s.hour, minute: s.minute, second: s.second };
  const byday = (r.BYDAY ?? "").split(",").filter(Boolean).map((x) => { const m = x.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/); return m ? { n: m[1] ? Number(m[1]) : 0, wd: DAYS.indexOf(m[2]) + 1 } : null; }).filter(Boolean) as { n: number; wd: number }[];
  const bymd = (r.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number);
  const bysetpos = (r.BYSETPOS ?? "").split(",").filter(Boolean).map(Number);
  const bymonth = (r.BYMONTH ?? "").split(",").filter(Boolean).map(Number);
  let produced = 0;
  const push = (d: DateTime) => {
    if (!d.isValid || d.toMillis() < s.toMillis()) return true;
    if (produced >= count || d.toMillis() > until || d.toMillis() > toMs) return false;
    produced++; out.push(d); return produced < 2000;
  };
  const at = (y: number, m: number, day: number) => DateTime.fromObject({ year: y, month: m, day, ...time }, { zone: s.zone });
  const monthDays = (y: number, m: number): DateTime[] => {
    const first = at(y, m, 1); const n = first.daysInMonth!;
    let c: DateTime[] = [];
    if (bymd.length) c = bymd.map((d) => at(y, m, d < 0 ? n + d + 1 : d)).filter((d) => d.isValid && d.month === m);
    else if (byday.length) {
      for (const b of byday) {
        const all: DateTime[] = []; for (let d = 1; d <= n; d++) { const x = at(y, m, d); if (x.weekday === b.wd) all.push(x); }
        if (b.n === 0) c.push(...all); else { const x = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (x) c.push(x); }
      }
    } else c = [at(y, m, s.day)].filter((d) => d.isValid && d.month === m);
    c.sort((a, b) => a.toMillis() - b.toMillis());
    if (bysetpos.length) c = bysetpos.map((p) => (p > 0 ? c[p - 1] : c[c.length + p])).filter(Boolean);
    return c;
  };
  for (let i = 0; i < 3000; i++) {
    let cands: DateTime[] = [];
    if (freq === "DAILY") cands = [s.plus({ days: i * interval })];
    else if (freq === "WEEKLY") {
      const ws = s.startOf("week").plus({ weeks: i * interval });
      const wds = byday.length ? byday.map((b) => b.wd) : [s.weekday];
      cands = wds.sort((a, b) => a - b).map((wd) => { const d = ws.plus({ days: wd - 1 }); return at(d.year, d.month, d.day); });
    } else if (freq === "MONTHLY") { const m = s.startOf("month").plus({ months: i * interval }); cands = monthDays(m.year, m.month); }
    else if (freq === "YEARLY") {
      const y = s.year + i * interval;
      const months = bymonth.length ? bymonth : [s.month];
      cands = months.flatMap((m) => (bymd.length || byday.length ? monthDays(y, m) : [at(y, m, s.day)].filter((d) => d.isValid && d.month === m)));
    } else return [s];
    if (!cands.length && (freq === "DAILY" || freq === "WEEKLY")) continue;
    const first = cands[0];
    if (first && (first.toMillis() > toMs || first.toMillis() > until) && cands.every((c) => c.toMillis() > Math.min(toMs, until))) break;
    let more = true;
    for (const c of cands) { if (!push(c)) { more = false; break; } }
    if (!more) break;
  }
  return out;
}

/** Busy ranges overlapping [fromMs, toMs]. All-day events block whole days in hostZone. */
export function expandBusy(text: string, hostZone: string, fromMs: number, toMs: number): BusyRange[] {
  const events = parseEvents(text, hostZone);
  const overrides = new Map<string, IcsEvent[]>();
  for (const e of events) if (e.recurrenceId) (overrides.get(e.uid) ?? overrides.set(e.uid, []).get(e.uid)!).push(e);
  const out: BusyRange[] = [];
  const add = (e: IcsEvent, startDt: DateTime) => {
    if (e.transparent || e.cancelled) return;
    let s: number, en: number;
    if (e.start.allDay) {
      const days = e.end?.allDay ? Math.max(1, Math.round(e.end.dt.diff(e.start.dt, "days").days)) : Math.max(1, Math.round((e.durationMs ?? 86400000) / 86400000));
      const d0 = DateTime.fromObject({ year: startDt.year, month: startDt.month, day: startDt.day }, { zone: hostZone });
      s = d0.toMillis(); en = d0.plus({ days }).toMillis();
    } else {
      const len = e.end ? e.end.ms - e.start.ms : e.durationMs ?? 0;
      s = startDt.toMillis(); en = s + Math.max(0, len);
    }
    if (en > fromMs && s < toMs && en > s) out.push({ start_ms: s, end_ms: en });
  };
  for (const e of events) {
    if (e.recurrenceId) { add(e, e.start.dt); continue; }
    const moved = new Set((overrides.get(e.uid) ?? []).map((o) => o.recurrenceId!.ms));
    const movedDates = new Set((overrides.get(e.uid) ?? []).map((o) => o.recurrenceId!.dt.toISODate()));
    const ex = new Set(e.exdates.map((x) => x.ms));
    const exDates = new Set(e.exdates.filter((x) => x.allDay).map((x) => x.date));
    for (const occ of occurrences(e, toMs, hostZone)) {
      const ms = occ.toMillis();
      if (ex.has(ms) || exDates.has(occ.toISODate()!)) continue;
      if (moved.has(ms) || (e.start.allDay && movedDates.has(occ.toISODate()))) continue;
      add(e, occ);
    }
  }
  out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  return out.filter((r, i) => !i || r.start_ms !== out[i - 1].start_ms || r.end_ms !== out[i - 1].end_ms);
}
