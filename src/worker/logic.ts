import { DateTime } from "luxon";
import { settings } from "../shared/settings";
import { database } from "./db";
import {hashPassword,checkPassword,randomHex,HttpError} from "./security";
import { computeSlots } from "../shared/slots";
import { USE_BLOCKS_SQL } from "./calendars";


export function makeLogic(env: Env, request: Request) {
 const {one,all,run,nowIso}=database(env, request);
 const newUid = () => randomHex(11);
const RESERVED = new Set(["api", "login", "signup", "logout", "event-types", "bookings", "booking", "availability", "settings", "reschedule", "assets", "static", "admin", "app", "new"]);
function isZone(z: unknown): z is string {
    return typeof z === "string" && DateTime.local().setZone(z).isValid;
}
const DEFAULT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 }));
async function createSchedule(userId: number, name: string, tz: string, isDefault: boolean, hours = DEFAULT_HOURS, overrides: { date: string; startMin: number | null; endMin: number | null }[] = []) {
    const r = await run("INSERT INTO schedules (user_id,name,time_zone,is_default) VALUES (?,?,?,?)", userId, name, tz, isDefault ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    const rows = [
        ...hours.map((h) => env.DB.prepare("INSERT INTO schedule_hours (schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?)").bind(id, h.weekday, h.startMin, h.endMin)),
        ...overrides.map((o) => env.DB.prepare("INSERT INTO date_overrides (schedule_id,date,start_min,end_min) VALUES (?,?,?,?)").bind(id, o.date, o.startMin, o.endMin)),
    ];
    if (rows.length) await env.DB.batch(rows);
    return id;
}
async function createEventType(userId: number, f: Record<string, any>) {
    const pos = ((await one<{
        m: number;
    }>("SELECT COALESCE(MAX(position),-1)+1 AS m FROM event_types WHERE user_id=? AND deleted_at IS NULL", userId))?.m) ?? 0;
    const r = await run(`INSERT INTO event_types (user_id,title,slug,description,duration_min,position,hidden,location_kind,location_value,schedule_id,
      min_notice_min,buffer_before_min,buffer_after_min,slot_step_min,max_per_day,future_days,requires_approval,hide_guests,color,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, userId, f.title, f.slug, f.description ?? "", f.duration_min, pos, f.hidden ?? 0, f.location_kind ?? "video", f.location_value ?? "", f.schedule_id ?? null, f.min_notice_min ?? 120, f.buffer_before_min ?? 0, f.buffer_after_min ?? 0, f.slot_step_min ?? null, f.max_per_day ?? null, f.future_days ?? null, f.requires_approval ?? 0, f.hide_guests ?? 0, f.color ?? "#111827", nowIso());
    return Number(r.lastInsertRowid);
}
async function loadSchedule(id: number) {
    const s = await one<any>("SELECT * FROM schedules WHERE id=?", id);
    if (!s)
        return undefined;
    const hours = (await all<any>("SELECT weekday,start_min,end_min FROM schedule_hours WHERE schedule_id=? ORDER BY weekday,start_min", id)).map((h) => ({ weekday: h.weekday, startMin: h.start_min, endMin: h.end_min }));
    const overrides = (await all<any>("SELECT date,start_min,end_min FROM date_overrides WHERE schedule_id=? ORDER BY date,start_min", id)).map((o) => ({ date: o.date, startMin: o.start_min, endMin: o.end_min }));
    return { id: s.id, userId: s.user_id, name: s.name, timeZone: s.time_zone, isDefault: !!s.is_default, hours, overrides };
}
async function scheduleFor(et: any) {
    const sid = et.schedule_id ?? (await one<any>("SELECT id FROM schedules WHERE user_id=? AND is_default=1", et.user_id))?.id;
    return sid ? await loadSchedule(sid) : undefined;
}
/** Free slots for an event type between two UTC instants. */
async function slotsFor(et: any, rangeStart: string, rangeEnd: string, excludeUid?: string | null) {
    const schedule = await scheduleFor(et);
    if (!schedule)
        return [];
    const from = new Date(Date.parse(rangeStart) - 86400000).toISOString();
    const to = new Date(Date.parse(rangeEnd) + 86400000).toISOString();
    const busyRows = await all<any>(`SELECT b.uid,b.start_utc,b.end_utc,b.event_type_id,b.buffer_before_min,b.buffer_after_min FROM bookings b
     WHERE b.host_id=? AND b.status IN ('accepted','pending') AND b.end_utc > ? AND b.start_utc < ?`, et.user_id, from, to);
    const busy = busyRows.filter((b) => b.uid !== excludeUid).map((b) => ({
        start: b.start_utc, end: b.end_utc, bufferBeforeMin: b.buffer_before_min, bufferAfterMin: b.buffer_after_min, sameEvent: b.event_type_id === et.id,
    }));
    // Busy times from the host's calendar feed (R17) count like bookings with no buffers of their own.
    // Proposed new times (R19) are held as 'hold:{uid}' blocks; a booking's own hold never blocks its own move.
    const blocks = await all<any>(`SELECT start_ms,end_ms FROM busy_blocks bb WHERE bb.user_id=? AND bb.end_ms > ? AND bb.start_ms < ?
     AND bb.source IS NOT ? AND (bb.source LIKE 'hold:%' OR ${USE_BLOCKS_SQL})`,
        et.user_id, Date.parse(from), Date.parse(to), `hold:${excludeUid ?? ""}`, staleCutoff());
    for (const k of blocks) busy.push({ start: new Date(k.start_ms).toISOString(), end: new Date(k.end_ms).toISOString(), bufferBeforeMin: 0, bufferAfterMin: 0, sameEvent: false });
    return computeSlots({
        now: nowIso(), rangeStart, rangeEnd,
        schedule: { timeZone: schedule.timeZone, hours: schedule.hours, overrides: schedule.overrides },
        event: {
            durationMin: et.duration_min, stepMin: et.slot_step_min, minNoticeMin: et.min_notice_min, bufferBeforeMin: et.buffer_before_min,
            bufferAfterMin: et.buffer_after_min, maxPerDay: et.max_per_day, futureDays: et.future_days,
        },
        busy,
    });
}
/** Feeds failing 3+ times whose last good sync is older than this are ignored. */
function staleCutoff() { return new Date(Date.parse(nowIso()) - 86400000).toISOString(); }
function mail(to: string, what: string) {
    // No mail provider is wired up; log without the full address so logs hold no guest emails.
    console.log(`[mail] to=${String(to).replace(/^(.).*(@.*)$/, "$1***$2")} ${what}`);
}
let seeded = false;
async function seedDemo() {
    // Demo data is created lazily on the first API request when seed_demo is on and the DB is empty.
    if (seeded || !settings.seedDemo) return;
    if (await one("SELECT id FROM users LIMIT 1")) { seeded = true; return; }
    const now = nowIso(), q = (sql: string, ...p: any[]) => env.DB.prepare(sql).bind(...p);
    const owner = "(SELECT id FROM users WHERE username='alex')", sched = `(SELECT id FROM schedules WHERE user_id=${owner} AND is_default=1)`;
    const et = (pos: number, f: any) => q(`INSERT INTO event_types (user_id,title,slug,description,duration_min,position,hidden,location_kind,location_value,buffer_after_min,requires_approval,color,created_at)
        VALUES (${owner},?,?,?,?,?,?,?,?,?,?,?,?)`, f.title, f.slug, f.description ?? "", f.duration_min, pos, f.hidden ?? 0, f.location_kind ?? "video", f.location_value ?? "", f.buffer_after_min ?? 0, f.requires_approval ?? 0, f.color, now);
    try {
        await env.DB.batch([
            q("INSERT INTO users (email,password_hash,name,username,bio,time_zone,time_format,week_start,created_at) VALUES (?,?,?,?,?,?,?,?,?)", "alex@example.com", await hashPassword("demo-pass-123"), "Alex Rivera", "alex", "Product designer. Happy to talk shop.", "America/New_York", 12, "monday", now),
            q(`INSERT INTO schedules (user_id,name,time_zone,is_default) VALUES (${owner},'Working hours','America/New_York',1)`),
            ...[1, 2, 3, 4, 5].flatMap((d) => [q(`INSERT INTO schedule_hours (schedule_id,weekday,start_min,end_min) VALUES (${sched},?,540,720)`, d), q(`INSERT INTO schedule_hours (schedule_id,weekday,start_min,end_min) VALUES (${sched},?,780,1020)`, d)]),
            et(0, { title: "Intro call", slug: "intro", duration_min: 30, location_kind: "video", location_value: "https://meet.example.com/alex", description: "A short first call to see how we can work together.", color: "#1d4ed8" }),
            et(1, { title: "Deep dive", slug: "deep-dive", duration_min: 60, buffer_after_min: 10, requires_approval: 1, description: "An hour on one problem. I'll confirm the request.", color: "#047857" }),
            et(2, { title: "Coffee", slug: "coffee", duration_min: 45, location_kind: "in_person", location_value: "Corner cafe, 5th Ave", hidden: 1, description: "Coffee and an open chat, in person.", color: "#b45309" }),
        ]);
        console.log("Seeded demo user alex@example.com / demo-pass-123");
    } catch (err: any) { if (!/UNIQUE/i.test(String(err?.message ?? err))) throw err; } // another request seeded first
    seeded = true;
}

return {staleCutoff,HttpError,hashPassword,checkPassword,isZone,RESERVED,createSchedule,createEventType,loadSchedule,slotsFor,seedDemo,newUid,mail};
}
