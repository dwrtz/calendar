import { DateTime } from "luxon";
import {settings} from "../shared/settings";
import {groupByDate} from "../shared/slots";
import {database} from "./db";
import {makeLogic} from "./logic";
import {randomHex,HttpError} from "./security";
import {Router} from "./router";
import {COLORS} from "../shared/colors";
import {buildInvite} from "../shared/ics";
import {makeMailer,emailOn,emailProblem,provider,type Kind} from "./email";
import {makeCalendars,FeedError,pollMinutes,USE_BLOCKS_SQL} from "./calendars";
import {MissingKeyError} from "./crypto";
import {runScheduled} from "./cron";
export default { async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runScheduled(env)); },
 async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
 const db=database(env, request); const {one,all,run,nowIso}=db;
 const origin=String((env as any).SITE_URL||new URL(request.url).origin).replace(/\/$/,"");
 const mailer=makeMailer(env, db, origin);
 const calendars=makeCalendars(env, db);
 // Emails go out after the response; a send error never fails the request (R15).
 const notify=(kind: Kind, uid: string, opts: { noInvite?: boolean } = {})=>{ const p=mailer.notify(kind, uid, opts); if (ctx?.waitUntil) ctx.waitUntil(p); return p; };
 const {staleCutoff,hashPassword,checkPassword,isZone,RESERVED,createSchedule,createEventType,loadSchedule,slotsFor,seedDemo,newUid,mail}=makeLogic(env, request);
 const app=new Router();
 const wrap=(fn:any)=>fn;
 await seedDemo();
 // Deployment allowlist: ALLOWED_EMAILS is a comma-separated list. When set, only those emails can sign up,
 // sign in, keep a session or change their email. Public booking pages are unaffected.
 const allowed = String(env.ALLOWED_EMAILS ?? "").split(",").map((e: string) => e.trim().toLowerCase()).filter(Boolean);
 const emailAllowed = (e: unknown) => !allowed.length || (typeof e === "string" && allowed.includes(e.trim().toLowerCase()));
function cookie(req: any) {
    const m = (req.headers.cookie || "").split(";").map((s: string) => s.trim()).find((s: string) => s.startsWith("session=")); return m?.slice(8);
}
async function user(req: any) {
    const t = cookie(req);
    const u = t ? await one<any>("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?", t, nowIso()) : undefined;
    return u && emailAllowed(u.email) ? u : undefined;
}
async function need(req: any) { const u = await user(req); if (!u)
    throw new HttpError(401, "Sign in first"); return u; }
async function pubUser(username: string) { const u = await one<any>("SELECT * FROM users WHERE username=?", username); if (!u)
    throw new HttpError(404, "Nobody here by that name"); return u; }
async function pubEvent(username: string, slug: string) { const u = await pubUser(username); const e = await one<any>("SELECT * FROM event_types WHERE user_id=? AND slug=? AND deleted_at IS NULL", u.id, slug); if (!e)
    throw new HttpError(404, "This event type is no longer here"); return { u, e }; }
async function ownEvent(req: any) { const u = await need(req); const e = await one<any>("SELECT * FROM event_types WHERE id=? AND user_id=? AND deleted_at IS NULL", Number(req.params.id), u.id); if (!e)
    throw new HttpError(404, "Event type not found"); return { u, e }; }
async function ownSchedule(req: any) { const u = await need(req); const s = await one<any>("SELECT * FROM schedules WHERE id=? AND user_id=?", Number(req.params.id), u.id); if (!s)
    throw new HttpError(404, "Schedule not found"); return { u, s }; }
async function login(res: any, uid: number) {
    const token = randomHex(32);
    await run("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)", token, uid, new Date(Date.parse(nowIso()) + 30 * 86400000).toISOString());
    res.cookie("session", token, { httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: 30 * 86400000, path: "/" });
}
function publicFields(u: any) { return { name: u.name, username: u.username, bio: u.bio, weekStart: u.week_start, timeFormat: u.time_format }; }
function withoutHash(u: any) { const { password_hash, ...rest } = u; return rest; }
function emailOk(s: any) { return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254; }
function text(s: any, max = 200) { return typeof s === "string" && s.trim().length > 0 && s.length <= max; }
async function checkUserFields(b: any, uid?: number) {
    const f: Record<string, string> = {};
    if (!text(b.name, 80))
        f.name = "Enter your name (up to 80 characters)";
    if (emailOk(b.email) && !emailAllowed(b.email))
        f.email = "This site only accepts its owner's email";
    if (!emailOk(b.email))
        f.email = "Enter a valid email";
    if (typeof b.username !== "string" || !/^[a-z0-9-]{3,30}$/.test(b.username))
        f.username = "Use 3 to 30 lower-case letters, digits or hyphens";
    else if (RESERVED.has(b.username))
        f.username = "That username is reserved";
    else if (await one("SELECT id FROM users WHERE username=? AND id<>?", b.username, uid ?? -1))
        f.username = "That username is taken";
    if (emailOk(b.email) && await one("SELECT id FROM users WHERE email=? AND id<>?", b.email.toLowerCase(), uid ?? -1))
        f.email = "That email already has an account";
    return f;
}
app.get("/api/now", (req: any, res: any) => res.json({ now: nowIso() }));
app.post("/api/auth/signup", wrap(async (req: any, res: any) => {
    // Deployment switch: set ALLOW_SIGNUP to "0" to refuse new accounts (existing accounts still sign in).
    if (String((env as any).ALLOW_SIGNUP ?? "1") === "0") throw new HttpError(403, "New accounts are turned off on this site");
    if (!emailAllowed(req.body?.email)) throw new HttpError(403, "This site doesn't accept new accounts for that email");
    const b = req.body;
    const fields = await checkUserFields(b);
    if (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 200)
        fields.password = "Use 8 to 200 characters";
    if (!isZone(b.timeZone))
        fields.timeZone = "Choose a valid time zone";
    if (Object.keys(fields).length)
        throw new HttpError(400, "Check the fields below", fields);
    const email = b.email.toLowerCase(), now = nowIso();
    const owner = "(SELECT id FROM users WHERE username=?)";
    const sched = `(SELECT id FROM schedules WHERE user_id=${owner} AND is_default=1)`;
    const et = (title: string, slug: string, dur: number, pos: number) => env.DB.prepare(`INSERT INTO event_types (user_id,title,slug,duration_min,position,schedule_id,created_at) VALUES (${owner},?,?,?,?,NULL,?)`).bind(b.username, title, slug, dur, pos, now);
    // One D1 batch = one transaction: the account and its defaults appear together or not at all.
    await env.DB.batch([
        env.DB.prepare("INSERT INTO users (email,password_hash,name,username,time_zone,created_at) VALUES (?,?,?,?,?,?)").bind(email, await hashPassword(b.password), b.name.trim(), b.username, b.timeZone, now),
        env.DB.prepare(`INSERT INTO schedules (user_id,name,time_zone,is_default) VALUES (${owner},'Working hours',?,1)`).bind(b.username, b.timeZone),
        ...[1, 2, 3, 4, 5].map((d) => env.DB.prepare(`INSERT INTO schedule_hours (schedule_id,weekday,start_min,end_min) VALUES (${sched},?,540,1020)`).bind(b.username, d)),
        et("Quick chat", "quick-chat", 15, 0), et("Meeting", "meeting", 30, 1),
    ]).catch((err: any) => { if (/UNIQUE/i.test(String(err?.message ?? err))) throw new HttpError(400, "Check the fields below", { email: "That email or username is taken" }); throw err; });
    const id = (await one<any>("SELECT id FROM users WHERE username=?", b.username)).id;
    await login(res, id);
    res.status(201).json(withoutHash(await one("SELECT * FROM users WHERE id=?", id)));
}));
app.post("/api/auth/login", wrap(async (req: any, res: any) => {
    if (!emailAllowed(req.body?.email)) throw new HttpError(403, "This email can't sign in here");
    const u = typeof req.body.email === "string" ? await one<any>("SELECT * FROM users WHERE email=?", req.body.email.toLowerCase()) : undefined;
    if (!u || typeof req.body.password !== "string" || !await checkPassword(req.body.password, u.password_hash))
        throw new HttpError(400, "Email or password is wrong");
    await login(res, u.id);
    res.json(withoutHash(u));
}));
app.post("/api/auth/logout", wrap(async (req: any, res: any) => { const t = cookie(req); if (t)
    await run("DELETE FROM sessions WHERE token=?", t); res.clearCookie("session", { path: "/" }); res.json({ ok: true }); }));
app.get("/api/me", wrap(async (req: any, res: any) => res.json(withoutHash(await need(req)))));
app.patch("/api/me", wrap(async (req: any, res: any) => {
    const u = await need(req), b = { ...u, ...req.body };
    const fields = await checkUserFields(b, u.id);
    if ((b.bio ?? "").length > 300)
        fields.bio = "Up to 300 characters";
    if (!isZone(b.time_zone))
        fields.time_zone = "Choose a valid time zone";
    if (![12, 24].includes(Number(b.time_format)))
        fields.time_format = "Choose 12 or 24 hour";
    if (!["monday", "sunday"].includes(b.week_start))
        fields.week_start = "Choose Monday or Sunday";
    if (Object.keys(fields).length)
        throw new HttpError(400, "Check the fields below", fields);
    await run("UPDATE users SET email=?,name=?,username=?,bio=?,time_zone=?,time_format=?,week_start=? WHERE id=?", b.email.toLowerCase(), b.name.trim(), b.username, b.bio ?? "", b.time_zone, Number(b.time_format), b.week_start, u.id);
    res.json(withoutHash(await one("SELECT * FROM users WHERE id=?", u.id)));
}));
async function eventFields(b: any, uid: number, id?: number) {
    const f: Record<string, string> = {};
    if (!text(b.title, 120))
        f.title = "Enter a title (up to 120 characters)";
    if (typeof b.slug !== "string" || !/^[a-z0-9-]{1,60}$/.test(b.slug))
        f.slug = "Use lower-case letters, digits and hyphens (up to 60)";
    else if (await one("SELECT id FROM event_types WHERE user_id=? AND slug=? AND id<>? AND deleted_at IS NULL", uid, b.slug, id ?? -1))
        f.slug = "You already use that URL";
    if (!Number.isInteger(Number(b.duration_min)) || b.duration_min < 5 || b.duration_min > 720)
        f.duration_min = "Use 5 to 720 minutes";
    if (typeof b.description !== "string" || b.description.length > 2000)
        f.description = "Up to 2000 characters";
    if (!["video", "phone", "in_person", "custom"].includes(b.location_kind))
        f.location_kind = "Choose a location kind";
    if (b.location_kind === "video" && b.location_value) {
        try {
            const url = new URL(b.location_value);
            if (!["http:", "https:"].includes(url.protocol))
                throw 0;
        }
        catch {
            f.location_value = "Enter a web link";
        }
    }
    if (b.location_value?.length > 500)
        f.location_value = "Up to 500 characters";
    if (!Number.isInteger(Number(b.min_notice_min)) || b.min_notice_min < 0 || b.min_notice_min > 525600)
        f.min_notice_min = "Use 0 to 525600 minutes";
    const bufs = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
    if (!bufs.includes(Number(b.buffer_before_min)))
        f.buffer_before_min = "Choose a buffer";
    if (!bufs.includes(Number(b.buffer_after_min)))
        f.buffer_after_min = "Choose a buffer";
    if (b.slot_step_min != null && ![5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120].includes(Number(b.slot_step_min)))
        f.slot_step_min = "Choose a slot step";
    if (b.max_per_day != null && (!Number.isInteger(Number(b.max_per_day)) || b.max_per_day < 1 || b.max_per_day > 100))
        f.max_per_day = "Use a whole number from 1 to 100";
    if (b.future_days != null && (!Number.isInteger(Number(b.future_days)) || b.future_days < 1 || b.future_days > 730))
        f.future_days = "Use a whole number from 1 to 730";
    if (b.schedule_id != null && !await one("SELECT id FROM schedules WHERE id=? AND user_id=?", Number(b.schedule_id), uid))
        f.schedule_id = "Choose one of your schedules";
    if (!COLORS.includes(b.color))
        f.color = "Choose a colour";
    if (b.reminder_offsets !== undefined) {
        let r: any = b.reminder_offsets; try { if (typeof r === "string") r = JSON.parse(r); } catch { r = null; }
        if (!Array.isArray(r) || r.some((x: any) => ![10080, 1440, 60, 15].includes(Number(x)))) f.reminder_offsets = "Choose reminders from the list";
        else b.reminder_offsets = JSON.stringify([...new Set(r.map(Number))].sort((x: number, y: number) => y - x));
    }
    return f;
}
const eventDefaults = { description: "", duration_min: 30, hidden: 0, location_kind: "video", location_value: "", schedule_id: null, min_notice_min: 120, buffer_before_min: 0, buffer_after_min: 0, slot_step_min: null, max_per_day: null, future_days: null, requires_approval: 0, hide_guests: 0, color: "#111827" };
app.get("/api/event-types", wrap(async (req: any, res: any) => { const u = await need(req); res.json(await all("SELECT * FROM event_types WHERE user_id=? AND deleted_at IS NULL ORDER BY position,id", u.id)); }));
app.post("/api/event-types", wrap(async (req: any, res: any) => {
    const u = await need(req), b = { ...eventDefaults, ...req.body };
    const fields = await eventFields(b, u.id);
    if (Object.keys(fields).length)
        throw new HttpError(400, "Check the fields below", fields);
    const id = await createEventType(u.id, b);
    res.status(201).json(await one("SELECT * FROM event_types WHERE id=?", id));
}));
app.get("/api/event-types/:id", wrap(async (req: any, res: any) => res.json((await ownEvent(req)).e)));
app.patch("/api/event-types/:id", wrap(async (req: any, res: any) => {
    const { u, e } = await ownEvent(req), b = { ...e, ...req.body };
    const fields = await eventFields(b, u.id, e.id);
    if (Object.keys(fields).length)
        throw new HttpError(400, "Check the fields below", fields);
    const keys = ["title", "slug", "description", "duration_min", "hidden", "location_kind", "location_value", "schedule_id", "min_notice_min", "buffer_before_min", "buffer_after_min", "slot_step_min", "max_per_day", "future_days", "requires_approval", "hide_guests", "color", "reminder_offsets"];
    await run(`UPDATE event_types SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`, ...keys.map((k) => typeof b[k] === "boolean" ? +b[k] : b[k]), e.id);
    res.json(await one("SELECT * FROM event_types WHERE id=?", e.id));
}));
app.delete("/api/event-types/:id", wrap(async (req: any, res: any) => { const { e } = await ownEvent(req); await run("UPDATE event_types SET deleted_at=? WHERE id=?", nowIso(), e.id); res.json({ ok: true }); }));
app.post("/api/event-types/:id/duplicate", wrap(async (req: any, res: any) => {
    const { u, e } = await ownEvent(req);
    let n = 1, slug: string;
    do {
        slug = e.slug + "-copy" + (n === 1 ? "" : `-${n}`);
        n++;
    } while (await one("SELECT id FROM event_types WHERE user_id=? AND slug=? AND deleted_at IS NULL", u.id, slug));
    const id = await createEventType(u.id, { ...e, title: e.title + " (copy)", slug });
    res.status(201).json(await one("SELECT * FROM event_types WHERE id=?", id));
}));
app.post("/api/event-types/:id/move", wrap(async (req: any, res: any) => {
    const { u, e } = await ownEvent(req);
    const list = (await all<any>("SELECT id FROM event_types WHERE user_id=? AND deleted_at IS NULL ORDER BY position,id", u.id)).map((x) => x.id);
    const i = list.indexOf(e.id), j = req.body.direction === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        await env.DB.batch(list.map((id, p) => env.DB.prepare("UPDATE event_types SET position=? WHERE id=?").bind(p, id)));
    }
    res.json({ ok: true });
}));
function scheduleFields(b: any) {
    const f: Record<string, string> = {};
    if (!text(b.name, 80))
        f.name = "Enter a name";
    if (!isZone(b.timeZone))
        f.timeZone = "Choose a valid time zone";
    const validRange = (s: any, e: any) => Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= 1440 && e > s && s % 15 === 0 && e % 15 === 0;
    if (!Array.isArray(b.hours) || b.hours.some((h: any) => !Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6 || !validRange(h.startMin, h.endMin)))
        f.hours = "Check the time ranges";
    if (!Array.isArray(b.overrides) || b.overrides.some((o: any) => !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !DateTime.fromISO(o.date).isValid || !(o.startMin === null && o.endMin === null || validRange(o.startMin, o.endMin))))
        f.overrides = "Check the overrides";
    function overlapping(rows: any[]) { const a = [...rows].sort((x, y) => x.startMin - y.startMin); return a.some((r, i) => i > 0 && r.startMin < a[i - 1].endMin); }
    if (!f.hours)
        for (let d = 0; d < 7; d++)
            if (overlapping(b.hours.filter((h: any) => h.weekday === d)))
                f.hours = "Ranges on a day may not overlap";
    if (!f.overrides)
        for (const date of new Set(b.overrides.map((o: any) => o.date))) {
            const rs = b.overrides.filter((o: any) => o.date === date);
            if (rs.length > 1 && rs.some((o: any) => o.startMin === null) || overlapping(rs))
                f.overrides = "Ranges on a date may not overlap";
        }
    return f;
}
app.get("/api/schedules", wrap(async (req: any, res: any) => { const u = await need(req); res.json(await Promise.all((await all<any>("SELECT id FROM schedules WHERE user_id=? ORDER BY is_default DESC,id", u.id)).map(async (s) => await loadSchedule(s.id)))); }));
app.post("/api/schedules", wrap(async (req: any, res: any) => { const u = await need(req); if (!text(req.body.name, 100))
    throw new HttpError(400, "Enter a name", { name: "Enter a name" }); const id = await createSchedule(u.id, req.body.name.trim(), u.time_zone, false); res.status(201).json(await loadSchedule(id)); }));
app.get("/api/schedules/:id", wrap(async (req: any, res: any) => { const { s } = await ownSchedule(req); res.json(await loadSchedule(s.id)); }));
app.patch("/api/schedules/:id", wrap(async (req: any, res: any) => {
    const { u, s } = await ownSchedule(req);
    const b = { ...await loadSchedule(s.id), ...req.body };
    const fields = scheduleFields(b);
    if (Object.keys(fields).length)
        throw new HttpError(400, "Check the fields below", fields);
    const today = DateTime.fromISO(nowIso(), { zone: b.timeZone }).toISODate()!;
    const q = (sql: string, ...p: any[]) => env.DB.prepare(sql).bind(...p);
    await env.DB.batch([
        ...(b.isDefault ? [q("UPDATE schedules SET is_default=0 WHERE user_id=?", u.id)] : []),
        q("UPDATE schedules SET name=?,time_zone=?,is_default=? WHERE id=?", b.name.trim(), b.timeZone, b.isDefault ? 1 : (s.is_default ? 1 : 0), s.id),
        q("DELETE FROM schedule_hours WHERE schedule_id=?", s.id),
        ...b.hours.map((h: any) => q("INSERT INTO schedule_hours (schedule_id,weekday,start_min,end_min) VALUES (?,?,?,?)", s.id, h.weekday, h.startMin, h.endMin)),
        q("DELETE FROM date_overrides WHERE schedule_id=?", s.id),
        ...b.overrides.filter((o: any) => o.date >= today).map((o: any) => q("INSERT INTO date_overrides (schedule_id,date,start_min,end_min) VALUES (?,?,?,?)", s.id, o.date, o.startMin, o.endMin)),
    ]);
    res.json(await loadSchedule(s.id));
}));
app.delete("/api/schedules/:id", wrap(async (req: any, res: any) => { const { s } = await ownSchedule(req); if (s.is_default)
    throw new HttpError(400, "You can't delete the default schedule"); await run("DELETE FROM schedules WHERE id=?", s.id); res.json({ ok: true }); }));
app.post("/api/schedules/:id/duplicate", wrap(async (req: any, res: any) => {
    const { u, s } = await ownSchedule(req), data = (await loadSchedule(s.id))!;
    const id = await createSchedule(u.id, s.name + " (copy)", s.time_zone, false, data.hours, data.overrides);
    res.status(201).json(await loadSchedule(id));
}));
app.get("/api/public/users/:username", wrap(async (req: any, res: any) => {
    const u = await pubUser(req.params.username);
    res.json({ user: publicFields(u), eventTypes: await all<any>("SELECT title,slug,description,duration_min AS durationMin,location_kind AS locationKind FROM event_types WHERE user_id=? AND hidden=0 AND deleted_at IS NULL ORDER BY position,id", u.id) });
}));
app.get("/api/public/users/:username/events/:slug", wrap(async (req: any, res: any) => { const { u, e } = await pubEvent(req.params.username, req.params.slug); res.json({ ...e, user: publicFields(u) }); }));
async function loadMovable(uid: string) { const b = await one<any>("SELECT * FROM bookings WHERE uid=?", uid); if (!b)
    throw new HttpError(404, "Booking not found"); if (!["accepted", "pending"].includes(b.status))
    throw new HttpError(409, "This booking was cancelled, so it can't be moved."); if (b.start_utc <= nowIso())
    throw new HttpError(409, "This booking has already started"); return b; }
app.get("/api/public/slots", wrap(async (req: any, res: any) => {
    const q = req.query as Record<string, string>;
    const { u, e } = await pubEvent(q.username, q.slug);
    const s = DateTime.fromISO(q.start || ""), en = DateTime.fromISO(q.end || "");
    if (!s.isValid || !en.isValid || en.toMillis() <= s.toMillis() || en.diff(s, "days").days > 45 || !isZone(q.tz))
        throw new HttpError(400, "Bad slot range or time zone");
    if (q.reschedule) {
        const b = await loadMovable(q.reschedule);
        if (b.host_id !== u.id || b.event_type_id !== e.id)
            throw new HttpError(400, "Wrong event type");
    }
    res.json({ slots: groupByDate(await slotsFor(e, s.toUTC().toISO()!, en.toUTC().toISO()!, q.reschedule), q.tz) });
}));
app.post("/api/public/bookings", wrap(async (req: any, res: any) => {
    const b = req.body;
    // Host reschedule: the signed-in host moves one of their own bookings. The guest's details are kept,
    // the new booking is confirmed straight away, and the old one is marked as moved by the host.
    let hostMove: any = null;
    if (b.asHost) {
        const me = await need(req);
        hostMove = await loadMovable(String(b.reschedule ?? ""));
        if (hostMove.host_id !== me.id)
            throw new HttpError(404, "Booking not found");
        Object.assign(b, { name: hostMove.booker_name, email: hostMove.booker_email, phone: hostMove.booker_phone || undefined, notes: hostMove.notes, guests: JSON.parse(hostMove.guests || "[]"), timeZone: hostMove.booker_tz });
    }
    const { u, e } = await pubEvent(b.username, b.slug);
    const fields: Record<string, string> = {};
    if (!text(b.name, 80))
        fields.name = "Enter your name";
    if (!emailOk(b.email))
        fields.email = "Enter a valid email";
    if (e.location_kind === "phone" && !text(b.phone, 50))
        fields.phone = "Enter your phone number";
    if ((b.notes ?? "").length > 1000)
        fields.notes = "Up to 1000 characters";
    if (!isZone(b.timeZone))
        fields.timeZone = "Choose a valid time zone";
    if (!Array.isArray(b.guests ?? []) || (b.guests?.length ?? 0) > 10 || (b.guests ?? []).some((x: any) => !emailOk(x)))
        fields.guests = "Up to 10 valid email addresses";
    const dt = DateTime.fromISO(b.start || "", { zone: "utc" });
    if (!dt.isValid)
        fields.start = "Pick a time";
    if (Object.keys(fields).length)
        throw new HttpError(400, "Check the fields below", fields);
    const start = dt.toUTC().toISO()!;
    let old: any;
    if (b.reschedule) {
        old = await loadMovable(b.reschedule);
        if (old.host_id !== u.id || old.event_type_id !== e.id)
            throw new HttpError(400, "Wrong event type");
    }
    // Fast path: the time must be a slot right now (hours, notice, horizon, buffers, daily limit).
    const free = await slotsFor(e, dt.minus({ hours: 12 }).toISO()!, dt.plus({ hours: 12 }).toISO()!, old?.uid);
    if (!free.includes(start))
        throw new HttpError(409, "Someone just took this time. Pick another.");
    const uid = newUid();
    const sMs = dt.toMillis(), eMs = sMs + e.duration_min * 60000;
    const end = new Date(eMs).toISOString();
    const location = e.location_kind === "phone" ? b.phone : e.location_value || "Video call";
    const zone = (await loadSchedule(e.schedule_id ?? (await one<any>("SELECT id FROM schedules WHERE user_id=? AND is_default=1", e.user_id)).id))!.timeZone;
    const day = DateTime.fromMillis(sMs, { zone }).startOf("day");
    // Race guard: one conditional INSERT. D1 runs each statement (and each batch) atomically,
    // so two requests for overlapping times can never both insert.
    const insert = env.DB.prepare(`INSERT INTO bookings (uid,event_type_id,host_id,title,start_utc,end_utc,start_ms,end_ms,buffer_before_min,buffer_after_min,status,
        booker_name,booker_email,booker_phone,booker_tz,notes,guests,location,from_uid,reschedule_reason,created_at,ics_uid,ics_sequence)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?25,?26
      WHERE NOT EXISTS (SELECT 1 FROM bookings x WHERE x.host_id=?3 AND x.status IN ('accepted','pending') AND x.uid IS NOT ?19
              AND ?7 - ?9*60000 - x.buffer_after_min*60000 < x.end_ms AND ?8 + ?10*60000 + x.buffer_before_min*60000 > x.start_ms)
        AND (?22 IS NULL OR (SELECT COUNT(*) FROM bookings y WHERE y.event_type_id=?2 AND y.status IN ('accepted','pending') AND y.uid IS NOT ?19
              AND y.start_ms >= ?23 AND y.start_ms < ?24) < ?22)
        AND (?19 IS NULL OR EXISTS (SELECT 1 FROM bookings z WHERE z.uid=?19 AND z.status IN ('accepted','pending')))
        AND NOT EXISTS (SELECT 1 FROM busy_blocks bb WHERE bb.user_id=?3 AND ?7 - ?9*60000 < bb.end_ms AND ?8 + ?10*60000 > bb.start_ms
              AND ${USE_BLOCKS_SQL.replace("?", "?27")})`).bind(
        uid, e.id, u.id, e.title, start, end, sMs, eMs, e.buffer_before_min, e.buffer_after_min, e.requires_approval && !hostMove ? "pending" : "accepted",
        b.name.trim(), b.email.toLowerCase(), b.phone ?? "", b.timeZone, b.notes ?? "", JSON.stringify(e.hide_guests ? [] : b.guests ?? []), location,
        old?.uid ?? null, b.rescheduleReason ?? "", nowIso(), e.max_per_day ?? null, day.toMillis(), day.plus({ days: 1 }).toMillis(),
        old ? (old.ics_uid || old.uid) : uid, old ? (old.ics_sequence ?? 0) + 1 : 0, staleCutoff());
    const stmts = [insert];
    if (old) stmts.push(env.DB.prepare("UPDATE bookings SET status='cancelled',rescheduled=1,cancelled_by=?,cancel_reason=? WHERE uid=? AND EXISTS (SELECT 1 FROM bookings WHERE uid=?)").bind(hostMove ? "host" : "guest", b.rescheduleReason ?? "", old.uid, uid));
    let inserted = 0;
    try { inserted = (await env.DB.batch(stmts))[0].meta.changes; }
    catch (err: any) { if (!/UNIQUE/i.test(String(err?.message ?? err))) throw err; }
    if (!inserted)
        throw new HttpError(409, "Someone just took this time. Pick another.");
    notify(old ? "moved" : e.requires_approval && !hostMove ? "requested" : "confirmed", uid);
    res.status(201).json({ uid });
}));
async function bookingFull(uid: string) {
    const b = await one<any>(`SELECT b.*,u.name AS host_name,u.email AS host_email,u.username AS host_username,u.time_zone AS host_tz,e.slug AS event_slug,e.duration_min,e.deleted_at AS event_deleted
    FROM bookings b JOIN users u ON u.id=b.host_id JOIN event_types e ON e.id=b.event_type_id WHERE b.uid=?`, uid);
    if (!b)
        throw new HttpError(404, "Booking not found");
    b.guests = JSON.parse(b.guests);
    b.movedToUid = (await one<any>("SELECT uid FROM bookings WHERE from_uid=?", uid))?.uid ?? null;
    return b;
}
app.get("/api/public/bookings/:uid", wrap(async (req: any, res: any) => res.json({ ...(await bookingFull(req.params.uid)), emailEnabled: emailOn(env) })));
async function cancelBooking(uid: string, who: "guest" | "host", reason = "") {
    const b = await loadMovable(uid);
    if (reason.length > 1000)
        throw new HttpError(400, "Reason is too long");
    await run("UPDATE bookings SET status='cancelled',cancel_reason=?,cancelled_by=?,ics_sequence=ics_sequence+1 WHERE uid=?", reason, who, uid);
    // Only an accepted booking had an invite, so only it gets a METHOD:CANCEL one.
    notify("cancelled", uid, { noInvite: b.status !== "accepted" });
    return await bookingFull(uid);
}
app.post("/api/public/bookings/:uid/cancel", wrap(async (req: any, res: any) => res.json(await cancelBooking(req.params.uid, "guest", req.body.reason ?? ""))));
app.get("/api/public/bookings/:uid/ics", wrap(async (req: any, res: any) => {
    const b = await bookingFull(req.params.uid);
    const ics = buildInvite({ uid: b.uid, icsUid: b.ics_uid, title: b.title, startUtc: b.start_utc, endUtc: b.end_utc, location: b.location, notes: b.notes,
        hostName: b.host_name, hostEmail: b.host_email, bookerName: b.booker_name, bookerEmail: b.booker_email, guests: b.guests },
        b.status === "cancelled" || b.status === "rejected" ? "cancel" : "publish", b.ics_sequence ?? 0, { origin, appName: settings.appName, now: nowIso(), audience: "guest" });
    res.set({ "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="booking-${b.uid}.ics"` }).send(ics);
}));
app.get("/api/bookings", wrap(async (req: any, res: any) => {
    const u = await need(req), status = String(req.query.status || "upcoming"), now = nowIso();
    const clauses: Record<string, string> = { upcoming: "b.status='accepted' AND b.end_utc>?", unconfirmed: "b.status='pending' AND b.end_utc>?", past: "b.status IN ('accepted','pending') AND b.end_utc<=?", cancelled: "b.status IN ('cancelled','rejected')" };
    if (!clauses[status])
        throw new HttpError(400, "Unknown tab");
    const counts: Record<string, number> = {};
    for (const [k, w] of Object.entries(clauses))
        counts[k] = (await one<any>(`SELECT COUNT(*) AS n FROM bookings b WHERE b.host_id=? AND ${w}`, u.id, ...(k === "cancelled" ? [] : [now])))!.n;
    const offset = Math.max(0, Number(req.query.cursor) || 0);
    const items = await all<any>(`SELECT b.*,e.color,e.slug AS event_slug FROM bookings b JOIN event_types e ON e.id=b.event_type_id WHERE b.host_id=? AND ${clauses[status]} ORDER BY b.start_utc ${["upcoming", "unconfirmed"].includes(status) ? "ASC" : "DESC"},b.id LIMIT 21 OFFSET ?`, u.id, ...(status === "cancelled" ? [] : [now]), offset);
    const more = items.length > 20;
    if (more)
        items.pop();
    res.json({ items: items.map((b) => ({ ...b, guests: JSON.parse(b.guests) })), nextCursor: more ? String(offset + 20) : null, counts });
}));
app.post("/api/bookings/:uid/:action", wrap(async (req: any, res: any) => {
    const u = await need(req), b = await bookingFull(req.params.uid);
    if (b.host_id !== u.id)
        throw new HttpError(404, "Booking not found");
    const action = req.params.action;
    if (action === "cancel") {
        res.json(await cancelBooking(b.uid, "host", req.body.reason ?? ""));
        return;
    }
    if (!["accept", "decline"].includes(action))
        throw new HttpError(404, "No such action");
    if (b.status !== "pending" || b.start_utc <= nowIso())
        throw new HttpError(409, "That request can no longer be changed");
    await run("UPDATE bookings SET status=?,cancel_reason=?,cancelled_by=? WHERE uid=?", action === "accept" ? "accepted" : "rejected", req.body.reason ?? "", action === "decline" ? "host" : null, b.uid);
    notify(action === "accept" ? "accepted" : "declined", b.uid);
    res.json(await bookingFull(b.uid));
}));
app.get("/api/integrations", wrap(async (req: any, res: any) => {
    const u = await need(req), e: any = env;
    const p = provider(e), problem = emailProblem(e);
    const lastFail = p ? await one<any>("SELECT error,created_at FROM email_log WHERE status='failed' ORDER BY id DESC LIMIT 1") : undefined;
    res.json({
        email: { provider: p || "off", from: p ? String(e.EMAIL_FROM || "") : "", state: !p ? "off" : problem ? "attention" : "on", reason: problem, lastError: lastFail?.error ?? "" },
        ical: { ...(await calendars.status(u.id)), pollMinutes: pollMinutes(e) },
        google: { state: "off", connected: false },
        configured: { encryptionKey: !!e.ENCRYPTION_KEY, siteUrl: !!e.SITE_URL, cron: true },
    });
}));
app.put("/api/integrations/ical", wrap(async (req: any, res: any) => {
    const u = await need(req);
    try { await calendars.save(u, req.body?.url); }
    catch (err: any) {
        if (err instanceof MissingKeyError) throw new HttpError(400, "Set ENCRYPTION_KEY first", { url: "Set ENCRYPTION_KEY first" });
        if (err instanceof FeedError) throw new HttpError(400, err.message, { url: err.message });
        throw err;
    }
    res.json(await calendars.status(u.id));
}));
app.delete("/api/integrations/ical", wrap(async (req: any, res: any) => { const u = await need(req); await calendars.remove(u.id); res.json(await calendars.status(u.id)); }));
app.post("/api/integrations/ical/sync", wrap(async (req: any, res: any) => {
    const u = await need(req); const f = await one<any>("SELECT * FROM calendar_feeds WHERE user_id=?", u.id);
    if (!f) throw new HttpError(404, "No calendar address saved");
    await calendars.sync(f); res.json(await calendars.status(u.id));
}));
// Test-only helpers (TEST_CLOCK="1"): an outbox for the test sender and a fixture feed.
app.get("/api/test/outbox", wrap(async (req: any, res: any) => {
    if (env.TEST_CLOCK !== "1") throw new HttpError(404, "Not found");
    res.json(await all("SELECT * FROM test_outbox ORDER BY id"));
}));
app.get("/api/test/feed.ics", wrap(async (req: any, res: any) => {
    if (env.TEST_CLOCK !== "1") throw new HttpError(404, "Not found");
    if (req.query.status) { res.status(Number(req.query.status)).send("gone"); return; }
    // Tue 24 Nov 2026 10:00-12:00 New York (15:00-17:00Z), weekly on Tuesdays x3 with the 2nd (1 Dec) removed.
    res.set({ "Content-Type": "text/calendar; charset=utf-8", ETag: '"fixture-1"' }).send(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
        "BEGIN:VEVENT", "UID:busy-1@test", "DTSTAMP:20261101T000000Z", "DTSTART;TZID=America/New_York:20261124T100000", "DTEND;TZID=America/New_York:20261124T120000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3", "EXDATE;TZID=America/New_York:20261201T100000", "SUMMARY:Private", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
}));
app.post("/api/test/scheduled", wrap(async (req: any, res: any) => {
    if (env.TEST_CLOCK !== "1") throw new HttpError(404, "Not found");
    res.json(await runScheduled(req.query.now ? { ...env, NOW: String(req.query.now) } : env));
}));

return app.handle(request,env);
} };
