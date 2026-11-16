// RFC 5545 invites (R16). Pure: no I/O, so tests can parse what it builds.
export type InviteBooking = {
  uid: string; icsUid?: string | null; title: string; startUtc: string; endUtc: string; location: string; notes: string;
  hostName: string; hostEmail: string; bookerName: string; bookerEmail: string; guests: string[];
};
export type InviteKind = "request" | "cancel" | "publish";
export type InviteContext = { origin: string; appName: string; now: string; audience: "host" | "guest"; organizer?: { name: string; email: string } };

export function escapeText(s: string): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}
/** Quote a parameter value (CN) when it has characters that need it; drop double quotes. */
function param(s: string): string {
  const v = String(s ?? "").replace(/["\r\n]/g, "");
  return /[;:,]/.test(v) ? `"${v}"` : v;
}
/** Fold a content line at 75 octets (UTF-8), continuation lines start with one space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "", curLen = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curLen + n > limit) { parts.push(cur); cur = ""; curLen = 0; limit = 74; }
    cur += ch; curLen += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}
export const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function buildInvite(b: InviteBooking, kind: InviteKind, sequence: number, ctx: InviteContext): string {
  const host = (() => { try { return new URL(ctx.origin).hostname; } catch { return "scheduler"; } })();
  const page = `${ctx.origin}/booking/${b.uid}`;
  const method = kind === "cancel" ? "CANCEL" : kind === "publish" ? "PUBLISH" : "REQUEST";
  const summary = `${b.title} with ${ctx.audience === "host" ? b.bookerName : b.hostName}`;
  const isLink = /^https?:\/\//i.test(b.location);
  const desc = [b.notes ? `Notes: ${b.notes}` : "", isLink ? `Join: ${b.location}` : "", `Reschedule: ${page}`, `Cancel: ${page}`].filter(Boolean).join("\n");
  const attendees = [b.bookerEmail, ...(b.guests ?? [])].filter((e, i, a) => e && a.indexOf(e) === i);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${escapeText(ctx.appName)}//Scheduler//EN`, "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${b.icsUid || b.uid}@${host}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${icsTime(ctx.now)}`,
    `DTSTART:${icsTime(b.startUtc)}`,
    `DTEND:${icsTime(b.endUtc)}`,
    `SUMMARY:${escapeText(summary)}`,
    ctx.organizer ? `ORGANIZER;CN=${param(ctx.organizer.name)}:mailto:${ctx.organizer.email}` : `ORGANIZER;CN=${param(b.hostName)}:mailto:${b.hostEmail}`,
    `ATTENDEE;CN=${param(b.hostName)};ROLE=${ctx.organizer ? "REQ-PARTICIPANT" : "CHAIR"};PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${b.hostEmail}`,
    ...attendees.map((e) => `ATTENDEE;CN=${param(e === b.bookerEmail ? b.bookerName : e)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${e}`),
    `STATUS:${kind === "cancel" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    `LOCATION:${escapeText(b.location)}`,
    `URL:${page}`,
    `DESCRIPTION:${escapeText(desc)}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
