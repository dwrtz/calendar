import { DateTime } from "luxon";

export type HoursRow = { weekday: number; startMin: number; endMin: number };
export type OverrideRow = { date: string; startMin: number | null; endMin: number | null };
export type SlotInput = {
  now: string;
  rangeStart: string;
  rangeEnd: string;
  schedule: { timeZone: string; hours: HoursRow[]; overrides: OverrideRow[] };
  event: {
    durationMin: number; stepMin: number | null; minNoticeMin: number;
    bufferBeforeMin: number; bufferAfterMin: number; maxPerDay: number | null; futureDays: number | null;
  };
  busy: { start: string; end: string; bufferBeforeMin: number; bufferAfterMin: number; sameEvent: boolean }[];
};

const MIN = 60_000;

/** Build a wall-clock instant in a zone. endMin 1440 = next day 00:00. */
function wall(date: DateTime, minutes: number, zone: string): number {
  let d = date;
  let m = minutes;
  if (m >= 1440) { d = d.plus({ days: 1 }); m -= 1440; }
  return DateTime.fromObject(
    { year: d.year, month: d.month, day: d.day, hour: Math.floor(m / 60), minute: m % 60 },
    { zone },
  ).toMillis();
}

export function computeSlots(input: SlotInput): string[] {
  const { schedule, event } = input;
  const zone = schedule.timeZone;
  const now = Date.parse(input.now);
  const rs = Date.parse(input.rangeStart);
  const re = Date.parse(input.rangeEnd);
  if (!(re > rs)) return [];

  // 1. Windows
  const first = DateTime.fromMillis(rs, { zone }).startOf("day").minus({ days: 1 });
  const last = DateTime.fromMillis(re, { zone }).startOf("day").plus({ days: 1 });
  const byDate = new Map<string, OverrideRow[]>();
  for (const o of schedule.overrides) {
    const list = byDate.get(o.date) ?? [];
    list.push(o);
    byDate.set(o.date, list);
  }
  let windows: [number, number][] = [];
  for (let d = first; d <= last; d = d.plus({ days: 1 }).startOf("day")) {
    const key = d.toISODate()!;
    const weekday = d.weekday % 7; // luxon: 1=Mon..7=Sun -> 0=Sun
    const ov = byDate.get(key);
    const rows = ov
      ? ov.filter((o) => o.startMin !== null && o.endMin !== null).map((o) => ({ startMin: o.startMin!, endMin: o.endMin! }))
      : schedule.hours.filter((h) => h.weekday === weekday);
    for (const r of rows) {
      const s = wall(d, r.startMin, zone);
      const e = wall(d, r.endMin, zone);
      if (e > s) windows.push([s, e]);
    }
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of windows) {
    const lastW = merged[merged.length - 1];
    if (lastW && w[0] <= lastW[1]) lastW[1] = Math.max(lastW[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  windows = merged;

  const dur = event.durationMin * MIN;
  const step = (event.stepMin ?? event.durationMin) * MIN;
  const earliest = now + event.minNoticeMin * MIN;
  let horizon = Infinity;
  if (event.futureDays != null) {
    horizon = DateTime.fromMillis(now, { zone }).startOf("day").plus({ days: event.futureDays }).toMillis();
  }
  const busy = input.busy.map((b) => ({ ...b, s: Date.parse(b.start), e: Date.parse(b.end) }));

  // 5. per-day counts
  const fullDays = new Set<string>();
  if (event.maxPerDay != null) {
    const counts = new Map<string, number>();
    for (const b of busy) {
      if (!b.sameEvent) continue;
      const k = DateTime.fromMillis(b.s, { zone }).toISODate()!;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) if (n >= event.maxPerDay) fullDays.add(k);
  }

  const out: string[] = [];
  for (const [ws, we] of windows) {
    for (let s = ws; s + dur <= we; s += step) {
      const e = s + dur;
      if (s < earliest) continue;
      if (s >= horizon) continue;
      if (s < rs || s >= re) continue;
      const clash = busy.some(
        (b) => s - event.bufferBeforeMin * MIN - b.bufferAfterMin * MIN < b.e &&
               e + event.bufferAfterMin * MIN + b.bufferBeforeMin * MIN > b.s,
      );
      if (clash) continue;
      if (fullDays.size && fullDays.has(DateTime.fromMillis(s, { zone }).toISODate()!)) continue;
      out.push(new Date(s).toISOString());
    }
  }
  return Array.from(new Set(out)).sort();
}

export function groupByDate(slots: string[], tz: string): Record<string, string[]> {
  const g: Record<string, string[]> = {};
  for (const s of slots) {
    const k = DateTime.fromISO(s, { zone: tz }).toISODate()!;
    (g[k] ??= []).push(s);
  }
  return g;
}
