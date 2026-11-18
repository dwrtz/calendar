// Email (R15) and invite attachments (R16). Off unless EMAIL_PROVIDER is set.
import { DateTime } from "luxon";
import { settings } from "../shared/settings";
import { buildDeclineCounter, buildInvite, type InviteKind } from "../shared/ics";
import { b64, buildMime } from "./mime";
import { normAddress } from "../shared/itip";

export type Mail = { from: string; to: string; replyTo?: string; subject: string; text: string; html: string;
  ics?: string; icsMethod?: "REQUEST" | "CANCEL" | "DECLINECOUNTER" };
export type Sender = { name: string; send(m: Mail): Promise<void> };
export type Kind = "confirmed" | "requested" | "accepted" | "declined" | "moved" | "cancelled" | "reminder" | "rsvp_declined"
  | "change_proposed" | "change_confirmed" | "change_expired" | "counter_declined";
type Db = { one: (sql: string, ...p: any[]) => Promise<any>; all: (sql: string, ...p: any[]) => Promise<any[]>; run: (sql: string, ...p: any[]) => Promise<{ changes: number }>; nowIso: () => string };

export const mask = (to: string) => String(to).replace(/^(.).*(@.*)$/, "$1***$2");

export function provider(env: any): "" | "cloudflare" | "resend" | "test" {
  const p = String(env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (p === "test") return env.TEST_CLOCK === "1" ? "test" : "";
  return p === "cloudflare" || p === "resend" ? p : "";
}
/** Why email is not working, or "" when it is ready. */
export function emailProblem(env: any): string {
  const p = provider(env);
  if (!p) return "";
  if (p !== "test" && !String(env.EMAIL_FROM ?? "").includes("@")) return "Set EMAIL_FROM to an address on your verified domain.";
  if (p === "cloudflare" && !env.EMAIL?.send) return "Add the send_email binding named EMAIL.";
  if (p === "resend" && !env.RESEND_API_KEY) return "Set the RESEND_API_KEY secret.";
  return "";
}
export const emailOn = (env: any) => !!provider(env) && !emailProblem(env);
/** The address that sends mail; the default is a placeholder that only the log and test senders use. */
export const fromHeader = (env: any) => String(env.EMAIL_FROM || `"${settings.appName}" <bookings@example.com>`);
export const addressOf = (from: string) => ((f) => (typeof f === "string" ? f : f.email))(parseFrom(from)).toLowerCase();
/**
 * iTIP organizer for every invite this deployment emails (R16, R19): the sending address (EMAIL_FROM), so calendar
 * replies come back to the app's own mailbox. Undefined while email is off; the download then names the host.
 */
export function organizerFor(env: any): { name: string; email: string } | undefined {
  if (!emailOn(env)) return undefined;
  return { name: settings.appName, email: addressOf(fromHeader(env)) };
}

/** '"Name" <addr@x>' -> { email, name }; a bare address stays a string. */
export function parseFrom(from: string): string | { email: string; name: string } {
  const m = String(from).trim().match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  return m ? (m[1].trim() ? { email: m[2].trim(), name: m[1].trim() } : m[2].trim()) : String(from).trim();
}
export function makeSender(env: any, db: Db): Sender {
  const p = provider(env);
  if (p === "cloudflare") return { name: p, async send(m) {
    // Raw MIME (EmailMessage) so the invite is an inline text/calendar part, which Gmail needs for its event card.
    const f = parseFrom(m.from); const from = typeof f === "string" ? { email: f } : f;
    const { EmailMessage } = await import("cloudflare:email");
    await env.EMAIL.send(new EmailMessage(from.email, m.to, buildMime({ ...m, from })));
  } };
  if (p === "resend") return { name: p, async send(m) {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: m.from, to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text, html: m.html,
        attachments: m.ics ? [{ filename: "invite.ics", content: b64(m.ics), content_type: `text/calendar; charset=utf-8; method=${m.icsMethod}` }] : undefined }) });
    if (!r.ok) throw new Error(`Resend answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } };
  if (p === "test") return { name: p, async send(m) {
    if (/^fail@/i.test(m.to)) throw new Error("Test sender refused this address");
    const f = parseFrom(m.from); const from = typeof f === "string" ? { email: f } : f;
    await db.run("INSERT INTO test_outbox (recipient,reply_to,subject,text,html,ics,mime,created_at) VALUES (?,?,?,?,?,?,?,?)", m.to, m.replyTo ?? "", m.subject, m.text, m.html, m.ics ?? "", buildMime({ ...m, from }), db.nowIso());
  } };
  return { name: "log", async send(m) { console.log(`[mail] to=${mask(m.to)} ${m.subject.split(":")[0]}`); } };
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function when(startUtc: string, endUtc: string, zone: string) {
  const s = DateTime.fromISO(startUtc, { zone: "utc" }).setZone(zone), e = DateTime.fromISO(endUtc, { zone: "utc" }).setZone(zone);
  const t = (d: DateTime) => d.toFormat("h:mma").toLowerCase();
  return { day: s.toFormat("cccc, LLLL d, yyyy"), short: `${s.toFormat("ccc, LLL d")}, ${t(s)}`, range: `${t(s)} - ${t(e)} (${zone})` };
}
export function offsetText(min: number) {
  if (min % 10080 === 0) return min === 10080 ? "1 week" : `${min / 10080} weeks`;
  if (min % 1440 === 0) return min === 1440 ? "1 day" : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return `${min} minutes`;
}

export type MailBooking = { uid: string; title: string; start_utc: string; end_utc: string; location: string; notes: string; status: string;
  booker_name: string; booker_email: string; booker_tz: string; guests: string[]; host_name: string; host_email: string; host_tz: string;
  cancel_reason?: string; cancelled_by?: string | null; reschedule_reason?: string; ics_uid?: string | null; ics_sequence?: number;
  /** For rsvp_declined: who declined in their calendar (R19). */
  decliner?: { name: string; email: string; comment?: string };
  /** For change_* and counter_declined: the proposed new time (R19). Times are the proposal's; from_* the original. */
  change?: { proposer_name: string; proposer_email: string; counterpart_name: string; start_utc: string | null; end_utc: string | null;
    from_start_utc: string; from_end_utc: string; reason: string; comment: string; sequence: number } };

/** Subject, plain text and HTML for one recipient. */
export function render(kind: Kind, b: MailBooking, audience: "guest" | "host", origin: string, offsetMin = 0) {
  const zone = audience === "host" ? b.host_tz : b.booker_tz;
  const other = audience === "host" ? b.booker_name : b.host_name;
  const w = when(b.start_utc, b.end_utc, zone);
  const page = `${origin}/booking/${b.uid}`;
  const tail = `${b.title} with ${other} on ${w.short}`;
  const subjects: Record<Kind, string> = {
    confirmed: `Confirmed: ${tail}`, accepted: `Confirmed: ${tail}`, moved: `Moved: ${tail}`, cancelled: `Cancelled: ${tail}`,
    requested: audience === "host" ? `New request: ${tail}` : `Request received: ${tail}`, declined: `Declined: ${tail}`,
    reminder: `Reminder: ${b.title} with ${other} starts in ${offsetText(offsetMin)}`,
    rsvp_declined: `Declined: ${b.title} with ${b.decliner?.name || other} on ${w.short}`,
    change_proposed: `New time proposed: ${tail}`, change_confirmed: `Moved: ${tail}`, change_expired: `Unchanged: ${tail}`,
    counter_declined: `New time not available: ${tail}`,
  };
  const c = b.change;
  const at = (s?: string | null, e?: string | null) => (s && e ? ((x) => `${x.day}, ${x.range}`)(when(s, e, zone)) : "the time you proposed");
  const by = b.cancelled_by === "host" ? b.host_name : b.booker_name;
  const lead: Record<Kind, string> = {
    confirmed: audience === "host" ? `${b.booker_name} booked a meeting with you.` : `Your meeting with ${b.host_name} is confirmed.`,
    accepted: audience === "host" ? `You accepted ${b.booker_name}'s request.` : `${b.host_name} accepted your request. Your meeting is confirmed.`,
    requested: audience === "host" ? `${b.booker_name} asked for a meeting. Accept or decline it in your bookings.` : `${b.host_name} will confirm your request. We'll email you when they do.`,
    declined: audience === "host" ? `You declined ${b.booker_name}'s request.` : `${b.host_name} can't make this time.${b.cancel_reason ? ` Reason: ${b.cancel_reason}` : ""}`,
    moved: `This meeting moved to a new time. The old time is cancelled.${b.reschedule_reason ? ` Reason: ${b.reschedule_reason}` : ""}`,
    cancelled: `${by} cancelled this meeting.${b.cancel_reason ? ` Reason: ${b.cancel_reason}` : ""}`,
    reminder: `Your meeting starts in ${offsetText(offsetMin)}.`,
    rsvp_declined: `${b.decliner?.name || "A guest"} declined this meeting in their calendar.${b.decliner?.comment ? ` Note: ${b.decliner.comment}` : ""} The booking is still on: cancel or reschedule it from your bookings if it isn't happening.`,
    change_proposed: `${c?.proposer_name || other} proposed a new time: ${at(c?.start_utc, c?.end_utc)} (it was ${at(c?.from_start_utc, c?.from_end_utc)}).${c?.comment ? ` Note: ${c.comment}` : ""} Accept or decline it in your calendar. Accepting moves the meeting; declining cancels it. Until then the original time stays booked.`,
    change_confirmed: `This meeting moved to ${w.day}, ${w.range}, the new time ${c?.proposer_name || "a participant"} proposed and ${c?.counterpart_name || "the other party"} accepted. The old time is cancelled.`,
    change_expired: `The proposed new time (${at(c?.start_utc, c?.end_utc)}) wasn't accepted in time, so this meeting stays at its original time.`,
    counter_declined: `Your proposed new time (${at(c?.start_utc, c?.end_utc)}) didn't go through. ${c?.reason || "That time isn't available."} The meeting stays at ${w.day}, ${w.range}. Pick another time in your calendar or on the booking page.`,
  };
  const isLink = /^https?:\/\//i.test(b.location);
  const rows: [string, string][] = [["What", b.title], ["When", `${w.day}\n${w.range}`], ["Who", `${b.host_name} (host)\n${b.booker_name} <${b.booker_email}>${b.guests?.length ? "\n" + b.guests.join("\n") : ""}`]];
  if (b.location) rows.push(["Where", b.location]);
  if (b.notes) rows.push(["Notes", b.notes]);
  const live = !["cancelled", "declined", "rsvp_declined"].includes(kind);
  const actions = audience === "guest" && live ? `Need a change? Reschedule: ${page}\nCancel: ${page}` : `Booking page: ${page}`;
  const text = [lead[kind], "", ...rows.map(([k, v]) => `${k}: ${v.replace(/\n/g, "\n  ")}`), "", actions, "", `Sent by ${settings.appName}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;background:#f9fafb;padding:24px">
<div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
<p style="font-size:16px;margin:0 0 16px">${esc(lead[kind])}</p>
<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;font-weight:600;vertical-align:top">${k}</td><td style="padding:4px 0">${k === "Where" && isLink ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>
<p style="margin:20px 0 0;font-size:14px">${audience === "guest" && live ? `Need a change? <a href="${esc(page)}">Reschedule</a> or <a href="${esc(page)}">Cancel</a>` : `<a href="${esc(page)}">Open the booking page</a>`}</p>
</div><p style="text-align:center;color:#6b7280;font-size:12px">Sent by ${esc(settings.appName)}</p></body></html>`;
  return { subject: subjects[kind], text, html };
}

/** Which invite (if any) goes with an email. Pending requests and declines get none. */
function inviteKind(kind: Kind, b: MailBooking): InviteKind | null {
  if (kind === "cancelled") return b.cancelled_by === "host" || b.cancelled_by === "guest" ? "cancel" : null;
  if (["confirmed", "accepted", "moved", "change_proposed", "change_confirmed", "change_expired"].includes(kind) && b.status === "accepted") return "request";
  return null;
}

export function makeMailer(env: any, db: Db, origin: string) {
  const sender = makeSender(env, db);
  const from = fromHeader(env);
  // Every emailed invite names the sending address as ORGANIZER (R16), so calendar replies come back to the
  // app (R19). Gmail also won't load an invite whose ORGANIZER is the recipient, which rules out the host.
  const organizer = { name: settings.appName, email: addressOf(from) };
  async function load(uid: string): Promise<MailBooking | undefined> {
    const b = await db.one(`SELECT b.*,u.name AS host_name,u.email AS host_email,u.time_zone AS host_tz FROM bookings b JOIN users u ON u.id=b.host_id WHERE b.uid=?`, uid);
    if (b) b.guests = JSON.parse(b.guests || "[]");
    return b;
  }
  function recipients(b: MailBooking) {
    const g = [b.booker_email, ...(b.guests ?? [])].filter((e, i, a) => e && a.indexOf(e) === i).map((to) => ({ to, audience: "guest" as const }));
    return [...g, { to: b.host_email, audience: "host" as const }];
  }
  /** Claim (uid, kind, offset, recipient) in email_log; true when this caller should send. */
  async function claim(uid: string, kind: Kind, offset: number, to: string) {
    const ins = await db.run("INSERT OR IGNORE INTO email_log (booking_uid,kind,offset_min,recipient,status,attempts,error,created_at) VALUES (?,?,?,?, 'sending',1,'',?)", uid, kind, offset, to, db.nowIso());
    if (ins.changes) return true;
    const upd = await db.run("UPDATE email_log SET status='sending',attempts=attempts+1 WHERE booking_uid=? AND kind=? AND offset_min=? AND recipient=? AND status='failed' AND attempts<3", uid, kind, offset, to);
    return upd.changes > 0;
  }
  async function deliver(kind: Kind, b: MailBooking, to: string, audience: "guest" | "host", offset: number, noInvite = false) {
    if (sender.name === "log") { console.log(`[mail] to=${mask(to)} ${kind} ${b.uid}`); return; }
    if (!(await claim(b.uid, kind, offset, to))) return;
    try {
      if (kind === "rsvp_declined") {
        // offset_min holds the booking_rsvps row id, so a retry can rebuild the same email.
        const r = await db.one("SELECT email,name,comment FROM booking_rsvps WHERE id=? AND booking_uid=?", offset, b.uid);
        if (!r) throw new Error("RSVP row not found");
        b = { ...b, decliner: { email: r.email, name: r.email === normAddress(b.booker_email) ? b.booker_name : r.name || r.email, comment: r.comment } };
      }
      let needsAction = "", declineCounter = false;
      if (kind.startsWith("change_") || kind === "counter_declined") {
        // offset_min holds the booking_changes row id, so a retry rebuilds the same email.
        const ch = await db.one("SELECT * FROM booking_changes WHERE id=? AND booking_uid=?", offset, b.uid);
        if (!ch) throw new Error("Change row not found");
        b = { ...b, change: ch };
        if (kind === "change_proposed") {
          // The other party sees the proposed time, at the proposal's SEQUENCE, with an answer requested of them.
          b = { ...b, start_utc: ch.start_utc, end_utc: ch.end_utc, ics_sequence: ch.sequence };
          needsAction = to;
        }
        declineCounter = kind === "counter_declined";
      }
      const r = render(kind, b, audience, origin, kind === "reminder" ? offset : 0);
      const ik = noInvite ? null : inviteKind(kind, b);
      const ics = declineCounter ? buildDeclineCounter({ uid: b.uid, icsUid: b.ics_uid, title: b.title, startUtc: b.start_utc, endUtc: b.end_utc },
        b.ics_sequence ?? 0, { origin, now: db.nowIso(), organizer, attendee: { email: to, name: b.change?.proposer_name || "" }, comment: b.change?.reason || "" })
        : ik ? buildInvite({ uid: b.uid, icsUid: b.ics_uid, title: b.title, startUtc: b.start_utc, endUtc: b.end_utc, location: b.location, notes: b.notes,
        hostName: b.host_name, hostEmail: b.host_email, bookerName: b.booker_name, bookerEmail: b.booker_email, guests: b.guests }, ik, b.ics_sequence ?? 0,
        { origin, appName: settings.appName, now: db.nowIso(), audience, organizer, needsAction }) : null;
      await sender.send({ from, to, replyTo: audience === "guest" ? b.host_email : b.booker_email, ...r,
        ics: ics ?? undefined, icsMethod: declineCounter ? "DECLINECOUNTER" : ik === "cancel" ? "CANCEL" : "REQUEST" });
      await db.run("UPDATE email_log SET status='sent',sent_at=?,error='' WHERE booking_uid=? AND kind=? AND offset_min=? AND recipient=?", db.nowIso(), b.uid, kind, offset, to);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      console.error(JSON.stringify({ mail: "failed", kind, uid: b.uid, to: mask(to), error: msg }));
      await db.run("UPDATE email_log SET status='failed',error=? WHERE booking_uid=? AND kind=? AND offset_min=? AND recipient=?", msg, b.uid, kind, offset, to);
    }
  }
  /** Email every recipient about a booking change. Never throws. */
  async function notify(kind: Kind, uid: string, opts: { noInvite?: boolean; offset?: number } = {}) {
    try {
      const b = await load(uid); if (!b) return;
      for (const r of recipients(b)) await deliver(kind, b, r.to, r.audience, opts.offset ?? 0, !!opts.noInvite);
    } catch (e: any) { console.error(JSON.stringify({ mail: "notify failed", kind, error: String(e?.message ?? e) })); }
  }
  /** Email only the host, for example when a guest declines in their calendar (R19). Never throws. */
  async function notifyHost(kind: Kind, uid: string, offset: number) {
    try {
      const b = await load(uid); if (!b) return;
      await deliver(kind, b, b.host_email, "host", offset, true);
    } catch (e: any) { console.error(JSON.stringify({ mail: "notifyHost failed", kind, error: String(e?.message ?? e) })); }
  }
  /** Email one person (R19: a proposed time goes to the other party, a refusal to the proposer). Never throws. */
  async function notifyOne(kind: Kind, uid: string, to: string, audience: "host" | "guest", offset: number) {
    try {
      const b = await load(uid); if (!b) return;
      await deliver(kind, b, to, audience, offset);
    } catch (e: any) { console.error(JSON.stringify({ mail: "notifyOne failed", kind, error: String(e?.message ?? e) })); }
  }
  /** Cron: reminders whose send time fell in the last `windowMin` minutes (and after the booking was made), and retries. */
  async function runReminders(windowMin = 15) {
    if (sender.name === "log") return { reminders: 0, retried: 0 };
    const now = Date.parse(db.nowIso()), lower = now - windowMin * 60000;
    const rows = await db.all(`SELECT b.uid,b.start_ms,b.created_at,e.reminder_offsets FROM bookings b JOIN event_types e ON e.id=b.event_type_id
      WHERE b.status='accepted' AND b.start_ms > ? AND b.start_ms <= ?`, now, now + 10080 * 60000 + 60000);
    let reminders = 0;
    for (const r of rows) {
      let offsets: number[] = []; try { offsets = JSON.parse(r.reminder_offsets || "[]"); } catch {}
      const made = Date.parse(r.created_at);
      for (const off of offsets) {
        const due = r.start_ms - off * 60000;
        if (due > now || due <= Math.max(lower, made)) continue;
        const b = await load(r.uid); if (!b) continue;
        for (const x of recipients(b)) { await deliver("reminder", b, x.to, x.audience, off); reminders++; }
      }
    }
    const failed = await db.all("SELECT booking_uid,kind,offset_min,recipient FROM email_log WHERE status='failed' AND attempts<3 LIMIT 50");
    for (const f of failed) {
      const b = await load(f.booking_uid); if (!b) continue;
      const audience = f.recipient === b.host_email ? "host" : "guest";
      await deliver(f.kind, b, f.recipient, audience, f.offset_min);
    }
    return { reminders, retried: failed.length };
  }
  return { notify, notifyHost, notifyOne, runReminders, sender };
}
