// iTIP (RFC 5546) replies as they arrive by iMIP (RFC 6047). Pure, no I/O, so tests can feed it any message.
import { unfold, parseLine, parseEvents, type Prop } from "./ical-parse";

export type PartStat = "ACCEPTED" | "TENTATIVE" | "DECLINED" | "NEEDS-ACTION" | "DELEGATED";
export type ItipAttendee = { email: string; name: string; partstat: PartStat | string; sentBy: string };
export type Itip = {
  method: string; uid: string; sequence: number; dtstamp: string; comment: string;
  attendees: ItipAttendee[]; organizer: string;
  /** For METHOD:COUNTER, the proposed time in UTC ISO. */
  proposed?: { startUtc: string; endUtc: string };
};

/** "mailto:Pat@Example.com" -> "pat@example.com"; anything that is not an address -> "". */
export function mailto(v: string): string {
  const s = String(v ?? "").trim().replace(/^mailto:/i, "").trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s) ? s : "";
}
const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

/** Reads the METHOD and the first VEVENT of an iCalendar object. Undefined when it is not one. */
export function parseItip(text: string): Itip | undefined {
  if (!/BEGIN:VCALENDAR/i.test(text)) return undefined;
  const lines = unfold(text).map(parseLine);
  const method = (lines.find((p) => p.name === "METHOD")?.value ?? "").trim().toUpperCase();
  const ev: Prop[] = []; let inEvent = false, depth = 0, seen = false;
  for (const p of lines) {
    if (!inEvent) { if (!seen && p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") { inEvent = true; seen = true; } continue; }
    if (p.name === "BEGIN") { depth++; continue; }
    if (p.name === "END") { if (depth > 0) { depth--; continue; } if (p.value.toUpperCase() === "VEVENT") { inEvent = false; continue; } }
    if (depth === 0) ev.push(p);
  }
  if (!seen) return undefined;
  const get = (n: string) => ev.find((p) => p.name === n);
  const attendees = ev.filter((p) => p.name === "ATTENDEE").map((p) => ({
    email: mailto(p.value), name: p.params.CN ?? "", partstat: (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase(), sentBy: mailto(p.params["SENT-BY"] ?? ""),
  }));
  const out: Itip = {
    method, uid: (get("UID")?.value ?? "").trim(), sequence: Number.parseInt(get("SEQUENCE")?.value ?? "0", 10) || 0,
    dtstamp: (get("DTSTAMP")?.value ?? "").trim(), comment: unescapeText(get("COMMENT")?.value ?? "").slice(0, 1000),
    attendees, organizer: mailto(get("ORGANIZER")?.value ?? ""),
  };
  if (method === "COUNTER") {
    const e = parseEvents(text, "UTC")[0];
    if (e && !e.start.allDay) {
      const endMs = e.end ? e.end.ms : e.durationMs !== undefined ? e.start.ms + e.durationMs : undefined;
      if (endMs !== undefined && endMs > e.start.ms) out.proposed = { startUtc: new Date(e.start.ms).toISOString(), endUtc: new Date(endMs).toISOString() };
    }
  }
  return out;
}

/** "abc123@calendar.example.com" -> { id: "abc123", host: "calendar.example.com" }. */
export function splitUid(uid: string): { id: string; host: string } {
  const i = uid.lastIndexOf("@");
  return i < 0 ? { id: uid, host: "" } : { id: uid.slice(0, i), host: uid.slice(i + 1).toLowerCase() };
}

/** Lowercase, drop +tags, and fold Gmail's dots and googlemail.com, so the same mailbox compares equal. */
export function normAddress(a: string): string {
  const s = mailto(a); if (!s) return "";
  let [local, domain] = [s.slice(0, s.lastIndexOf("@")), s.slice(s.lastIndexOf("@") + 1)];
  local = local.replace(/\+.*$/, "");
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
