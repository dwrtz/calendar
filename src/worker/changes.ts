// R19 booking changes driven by calendar replies: declines cancel, proposed new times (iTIP COUNTER) are held,
// offered to the other party and confirmed, declined or expired. Only D1 and the mailer; no Worker-only types.
import type { Kind } from "./email";
import { normAddress } from "../shared/itip";

type Db = { one: (sql: string, ...p: any[]) => Promise<any>; all: (sql: string, ...p: any[]) => Promise<any[]>; run: (sql: string, ...p: any[]) => Promise<{ changes: number }>; nowIso: () => string };
export type ChangeMailer = {
  notify(kind: Kind, uid: string, opts?: { noInvite?: boolean; offset?: number }): Promise<void>;
  notifyOne(kind: Kind, uid: string, to: string, audience: "host" | "guest", offset: number): Promise<void>;
};
export type Party = { email: string; name: string; role: "host" | "guest" };
export const holdSource = (uid: string) => `hold:${uid}`;
const iso = (ms: number) => new Date(ms).toISOString();

export const pendingChange = (db: Db, uid: string) => db.one("SELECT * FROM booking_changes WHERE booking_uid=? AND status='pending'", uid);

/** Resolve a booking's pending change without email (the booking is being cancelled or moved). Returns the highest SEQUENCE sent for it. */
export async function clearChanges(db: Db, uid: string, status = "cancelled"): Promise<number> {
  const ch = await pendingChange(db, uid);
  if (ch) await db.run("UPDATE booking_changes SET status=?,resolved_at=? WHERE id=? AND status='pending'", status, db.nowIso(), ch.id);
  await db.run("DELETE FROM busy_blocks WHERE source=?", holdSource(uid));
  return ch?.sequence ?? 0;
}

/** Cancel a live booking because a party declined it in their calendar; CANCEL goes to everyone, decliner included. */
export async function cancelForDecline(db: Db, mailer: ChangeMailer, b: any, by: "host" | "guest", reason: string): Promise<boolean> {
  const seq = Math.max(b.ics_sequence ?? 0, await clearChanges(db, b.uid));
  const r = await db.run("UPDATE bookings SET status='cancelled',cancel_reason=?,cancelled_by=?,ics_sequence=? WHERE uid=? AND status='accepted'", reason.slice(0, 1000), by, seq + 1, b.uid);
  if (!r.changes) return false;
  await mailer.notify("cancelled", b.uid);
  return true;
}

export type ProposeResult = { action: "change_proposed" | "counter_declined" | "duplicate"; changeId?: number; reason?: string };
/**
 * A party proposed a new time. Invalid or unavailable: DECLINECOUNTER to the proposer, booking unchanged. Valid: hold
 * the new time, send the other party a REQUEST at the new time (NEEDS-ACTION, RSVP=TRUE), keep the original time.
 */
export async function proposeChange(db: Db, mailer: ChangeMailer, b: any, proposer: Party, counterpart: Party | null,
  proposed: { startUtc: string; endUtc: string } | undefined, comment: string, slotFree: (b: any, startUtc: string) => Promise<boolean>): Promise<ProposeResult> {
  const now = db.nowIso();
  if (proposed) {
    const ps = Date.parse(proposed.startUtc), pe = Date.parse(proposed.endUtc);
    proposed = Number.isFinite(ps) && Number.isFinite(pe) ? { startUtc: iso(ps), endUtc: iso(pe) } : undefined;
  }
  const last = await db.one("SELECT * FROM booking_changes WHERE booking_uid=? ORDER BY id DESC LIMIT 1", b.uid);
  // The same proposal delivered twice (a retry) does nothing the second time.
  if (last && normAddress(last.proposer_email) === normAddress(proposer.email) && last.start_utc === (proposed?.startUtc ?? null) && last.end_utc === (proposed?.endUtc ?? null)
    && (last.status === "pending" || last.status === "rejected")) return { action: "duplicate", changeId: last.id };
  const prev = await pendingChange(db, b.uid);
  let reason = "";
  if (!counterpart) reason = "Only the host or the person who booked can move this meeting.";
  else if (!proposed) reason = "The proposal had no new time in it.";
  else if (Date.parse(proposed.endUtc) - Date.parse(proposed.startUtc) !== b.end_ms - b.start_ms) reason = `The new time has to be the same length as the meeting (${Math.round((b.end_ms - b.start_ms) / 60000)} minutes).`;
  else if (proposed.startUtc <= now) reason = "That time has already passed.";
  else if (proposed.startUtc === b.start_utc) reason = "That is already the meeting's time.";
  else if (!(await slotFree(b, proposed.startUtc))) reason = "That time isn't available.";
  const base = [b.uid, proposer.email, proposer.name, proposer.role, counterpart?.email ?? "", counterpart?.name ?? "", counterpart?.role ?? "",
    proposed?.startUtc ?? null, proposed?.endUtc ?? null, b.start_utc, b.end_utc];
  const cols = "booking_uid,proposer_email,proposer_name,proposer_role,counterpart_email,counterpart_name,counterpart_role,start_utc,end_utc,from_start_utc,from_end_utc,sequence,status,reason,comment,expires_at,created_at";
  if (reason) {
    await db.run(`INSERT INTO booking_changes (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'rejected',?,?,NULL,?)`, ...base, b.ics_sequence ?? 0, reason, comment, now);
    const id = (await db.one("SELECT MAX(id) AS id FROM booking_changes WHERE booking_uid=?", b.uid)).id;
    await mailer.notifyOne("counter_declined", b.uid, proposer.email, proposer.role, id);
    return { action: "counter_declined", changeId: id, reason };
  }
  const seq = Math.max(b.ics_sequence ?? 0, prev?.sequence ?? 0) + 1;
  if (prev) await clearChanges(db, b.uid, "superseded");
  // Pending until the earlier of the original start and the proposed start.
  const expires = proposed!.startUtc < b.start_utc ? proposed!.startUtc : b.start_utc;
  await db.run(`INSERT INTO booking_changes (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending','',?,?,?)`, ...base, seq, comment, expires, now);
  const ch = await pendingChange(db, b.uid);
  await db.run("INSERT INTO busy_blocks (user_id,source,start_ms,end_ms) VALUES (?,?,?,?)", b.host_id, holdSource(b.uid), Date.parse(proposed!.startUtc), Date.parse(proposed!.endUtc));
  await mailer.notifyOne("change_proposed", b.uid, counterpart!.email, counterpart!.role, ch.id);
  return { action: "change_proposed", changeId: ch.id };
}

/** The other party accepted: move the booking, free the original time, send the final REQUEST to everyone. */
export async function acceptChange(db: Db, mailer: ChangeMailer, b: any, ch: any): Promise<boolean> {
  const r = await db.run("UPDATE booking_changes SET status='accepted',resolved_at=? WHERE id=? AND status='pending'", db.nowIso(), ch.id);
  if (!r.changes) return false;
  const s = Date.parse(ch.start_utc), e = Date.parse(ch.end_utc);
  await db.run("UPDATE bookings SET start_utc=?,end_utc=?,start_ms=?,end_ms=?,ics_sequence=? WHERE uid=?", iso(s), iso(e), s, e, ch.sequence + 1, b.uid);
  await db.run("DELETE FROM busy_blocks WHERE source=?", holdSource(b.uid));
  // Reminders follow the confirmed time: forget the ones sent for the old time.
  await db.run("DELETE FROM email_log WHERE booking_uid=? AND kind='reminder'", b.uid);
  await mailer.notify("change_confirmed", b.uid, { offset: ch.id });
  return true;
}

/** The other party declined the proposed time: the meeting is cancelled for everyone. */
export async function declineChange(db: Db, mailer: ChangeMailer, b: any, ch: any, by: "host" | "guest"): Promise<boolean> {
  const r = await db.run("UPDATE booking_changes SET status='declined',resolved_at=? WHERE id=? AND status='pending'", db.nowIso(), ch.id);
  if (!r.changes) return false;
  return cancelForDecline(db, mailer, { ...b, ics_sequence: Math.max(b.ics_sequence ?? 0, ch.sequence) }, by, "Declined the proposed new time");
}

/** Nobody answered before the original or the proposed time began: keep the original time and tell everyone. */
export async function expireChange(db: Db, mailer: ChangeMailer, ch: any): Promise<boolean> {
  const r = await db.run("UPDATE booking_changes SET status='expired',resolved_at=? WHERE id=? AND status='pending'", db.nowIso(), ch.id);
  if (!r.changes) return false;
  await db.run("DELETE FROM busy_blocks WHERE source=?", holdSource(ch.booking_uid));
  const b = await db.one("SELECT status,ics_sequence FROM bookings WHERE uid=?", ch.booking_uid);
  if (b?.status !== "accepted") return true;
  await db.run("UPDATE bookings SET ics_sequence=? WHERE uid=?", Math.max(b.ics_sequence ?? 0, ch.sequence) + 1, ch.booking_uid);
  await mailer.notify("change_expired", ch.booking_uid, { offset: ch.id });
  return true;
}

/** Cron and inbound: expire every pending change whose time is up. */
export async function expireDue(db: Db, mailer: ChangeMailer, uid?: string): Promise<number> {
  const rows = await db.all(`SELECT * FROM booking_changes WHERE status='pending' AND expires_at <= ?${uid ? " AND booking_uid=?" : ""}`, db.nowIso(), ...(uid ? [uid] : []));
  let n = 0; for (const ch of rows) if (await expireChange(db, mailer, ch)) n++;
  return n;
}

/** Is a proposed start a bookable slot for this booking's event type right now (hours, notice, buffers, limits, busy)? */
export function makeSlotFree(db: Db, slotsFor: (et: any, from: string, to: string, excludeUid?: string | null) => Promise<string[]>) {
  return async (b: any, startUtc: string) => {
    const et = await db.one("SELECT * FROM event_types WHERE id=?", b.event_type_id);
    if (!et) return false;
    const s = Date.parse(startUtc);
    return (await slotsFor(et, iso(s - 12 * 3600000), iso(s + 12 * 3600000), b.uid)).includes(iso(s));
  };
}
