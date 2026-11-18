// Inbound calendar replies (R19): iTIP (RFC 5546) over iMIP (RFC 6047), delivered by Cloudflare Email Routing to
// the Worker's email() handler at the organizer address (EMAIL_FROM). Nothing here ever sends mail to the sender.
import PostalMime from "postal-mime";
import { parseItip, splitUid, normAddress, type Itip } from "../shared/itip";
export { normAddress };
import { organizerFor } from "./email";

type Db = { one: (sql: string, ...p: any[]) => Promise<any>; all: (sql: string, ...p: any[]) => Promise<any[]>; run: (sql: string, ...p: any[]) => Promise<{ changes: number }>; nowIso: () => string };
export type InboundMail = { from: string; to: string; raw: ArrayBuffer | Uint8Array | string; size?: number };
export type InboundResult =
  | { ok: true; action: "updated" | "counter" | "stale"; uid: string; email: string; partstat?: string; role: "host" | "guest"; notified?: boolean; prompt?: boolean }
  | { ok: false; reason: string };
export const MAX_INBOUND_BYTES = 1_000_000;
export const REJECT = {
  off: "Calendar replies are not accepted here",
  mailbox: "No such mailbox",
  big: "Message too large",
  notCalendar: "This address only accepts calendar replies",
  method: "Only calendar replies (iTIP REPLY or COUNTER) are accepted",
  unknown: "Unknown event",
  attendee: "The reply's attendee is not on this event",
  sender: "The sender does not match the reply's attendee",
} as const;

/** Envelope senders that calendar services use for replies they send on a person's behalf. */
export const CALENDAR_BOUNCE_DOMAINS = ["calendar-server.bounces.google.com"];
/**
 * Does the SMTP envelope sender (trustworthy, set by Email Routing) belong to the attendee who replied? Accepted when it
 * is the attendee (or their SENT-BY), or when the From header is the attendee and the envelope is the attendee's own
 * domain (or a subdomain of it, for bounce addresses) or a known calendar service's bounce domain (Google Calendar
 * sends RSVPs from one of those).
 */
export function senderMatches(envelope: string, headerFrom: string, attendee: string, sentBy = ""): boolean {
  const e = normAddress(envelope), h = normAddress(headerFrom), a = normAddress(attendee), s = normAddress(sentBy);
  if (!e || !a) return false;
  if (e === a || (s && e === s)) return true;
  if (!(h === a || (s && h === s))) return false;
  const ed = e.split("@")[1], ad = a.split("@")[1];
  // A bounce subdomain of the attendee's own domain (bounces.example.com for pat@example.com) counts as theirs.
  return ed === ad || ed.endsWith("." + ad) || CALENDAR_BOUNCE_DOMAINS.some((d) => ed === d || ed.endsWith("." + d));
}

/** The calendar objects in a message: text/calendar parts first, then .ics attachments. */
export async function calendarParts(raw: InboundMail["raw"]): Promise<{ parts: string[]; from: string }> {
  const parsed = await PostalMime.parse(raw as any, { attachmentEncoding: "utf8" } as any);
  const parts: string[] = [];
  const atts = [...(parsed.attachments ?? [])].sort((x: any, y: any) => Number(y.mimeType === "text/calendar") - Number(x.mimeType === "text/calendar"));
  for (const a of atts as any[]) {
    const type = String(a.mimeType || "").toLowerCase();
    if (type === "text/calendar" || type === "application/ics" || /\.ics$/i.test(a.filename || "")) {
      parts.push(typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content));
    }
  }
  return { parts, from: parsed.from?.address ?? "" };
}

/** Validate one inbound message and apply it. Pure apart from `db` and `notifyDeclined`; never sends to the sender. */
export async function processInbound(m: InboundMail, deps: { env: any; db: Db; notifyDeclined: (uid: string, rsvpId: number) => Promise<void> }): Promise<InboundResult> {
  const { env, db } = deps;
  const org = organizerFor(env);
  if (!org) return { ok: false, reason: REJECT.off };
  if (normAddress(m.to) !== normAddress(org.email)) return { ok: false, reason: REJECT.mailbox };
  const size = m.size ?? (typeof m.raw === "string" ? m.raw.length : m.raw.byteLength);
  if (size > MAX_INBOUND_BYTES) return { ok: false, reason: REJECT.big };
  let found: { parts: string[]; from: string };
  try { found = await calendarParts(m.raw); } catch { return { ok: false, reason: REJECT.notCalendar }; }
  const itips = found.parts.map(parseItip).filter((x): x is Itip => !!x);
  if (!itips.length) return { ok: false, reason: REJECT.notCalendar };
  const it = itips.find((x) => x.method === "REPLY" || x.method === "COUNTER");
  if (!it) return { ok: false, reason: REJECT.method };

  // Match the UID to a booking: "{first booking uid}@{site host}" (R16). A moved booking shares the first one's UID.
  const { id, host } = splitUid(it.uid);
  const siteHost = (() => { try { return new URL(String(env.SITE_URL || "")).hostname.toLowerCase(); } catch { return ""; } })();
  if (!id || (siteHost && host !== siteHost)) return { ok: false, reason: REJECT.unknown };
  const b = await db.one(`SELECT b.*,u.email AS host_email FROM bookings b JOIN users u ON u.id=b.host_id
    WHERE b.ics_uid=?1 OR b.uid=?1 ORDER BY (b.status IN ('accepted','pending')) DESC, b.id DESC LIMIT 1`, id);
  if (!b) return { ok: false, reason: REJECT.unknown };

  // The attendee must be on the booking, and the envelope sender must be that attendee (iTIP REPLY has one ATTENDEE).
  const people = new Map<string, "host" | "guest">();
  for (const g of [b.booker_email, ...JSON.parse(b.guests || "[]")]) if (g) people.set(normAddress(g), "guest");
  people.set(normAddress(b.host_email), "host");
  const att = it.attendees.filter((a) => a.email);
  if (att.length !== 1 || !people.has(normAddress(att[0].email))) return { ok: false, reason: REJECT.attendee };
  const a = att[0], role = people.get(normAddress(a.email))!;
  if (!senderMatches(m.from, found.from, a.email, a.sentBy)) return { ok: false, reason: REJECT.sender };

  // Older replies than the event's current version, or than one already recorded, change nothing (RFC 5546 2.1.5).
  const key = normAddress(a.email);
  const prev = await db.one("SELECT * FROM booking_rsvps WHERE booking_uid=? AND email=?", b.uid, key);
  const stale = it.sequence < (b.ics_sequence ?? 0) || (prev && (prev.sequence > it.sequence || (prev.sequence === it.sequence && prev.dtstamp && it.dtstamp && prev.dtstamp > it.dtstamp)));
  if (stale) return { ok: true, action: "stale", uid: b.uid, email: key, role };
  const now = db.nowIso();
  const live = b.status === "accepted" && b.end_utc > now;
  const name = (a.name || "").slice(0, 200);

  if (it.method === "COUNTER") {
    // A proposed new time is shown to the host only; nothing is moved (R19).
    await db.run(`INSERT INTO booking_rsvps (booking_uid,email,name,role,partstat,sequence,dtstamp,comment,counter_start,counter_end,counter_at,host_prompt,updated_at)
      VALUES (?,?,?,?,'',?,?,?,?,?,?,0,?) ON CONFLICT(booking_uid,email) DO UPDATE SET name=excluded.name,sequence=excluded.sequence,dtstamp=excluded.dtstamp,
      comment=excluded.comment,counter_start=excluded.counter_start,counter_end=excluded.counter_end,counter_at=excluded.counter_at,updated_at=excluded.updated_at`,
      b.uid, key, name, role, it.sequence, it.dtstamp, it.comment, it.proposed?.startUtc ?? null, it.proposed?.endUtc ?? null, now, now);
    return { ok: true, action: "counter", uid: b.uid, email: key, role };
  }

  const partstat = ["ACCEPTED", "TENTATIVE", "DECLINED", "NEEDS-ACTION", "DELEGATED"].includes(a.partstat) ? a.partstat : "NEEDS-ACTION";
  // The host declining their own copy flags the booking with a "cancel it?" prompt; it is never cancelled for them.
  const prompt = role === "host" && partstat === "DECLINED" && live ? 1 : 0;
  await db.run(`INSERT INTO booking_rsvps (booking_uid,email,name,role,partstat,sequence,dtstamp,comment,host_prompt,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_uid,email) DO UPDATE SET name=excluded.name,role=excluded.role,partstat=excluded.partstat,
    sequence=excluded.sequence,dtstamp=excluded.dtstamp,comment=excluded.comment,host_prompt=excluded.host_prompt,updated_at=excluded.updated_at`,
    b.uid, key, name, role, partstat, it.sequence, it.dtstamp, it.comment, prompt, now);
  let notified = false;
  if (role === "guest" && partstat === "DECLINED" && prev?.partstat !== "DECLINED" && live) {
    const row = await db.one("SELECT id FROM booking_rsvps WHERE booking_uid=? AND email=?", b.uid, key);
    await deps.notifyDeclined(b.uid, row.id); notified = true;
  }
  return { ok: true, action: "updated", uid: b.uid, email: key, partstat, role, notified, prompt: !!prompt };
}
