import { describe, it, expect } from "vitest";
import { buildMime, encodeWord } from "../src/worker/mime";
import { buildInvite } from "../src/shared/ics";

// Minimal RFC 2045/2046 parser, enough to check structure the way a mail client sees it.
type Part = { headers: Record<string, string>; body: string; parts: Part[] };
function parse(raw: string): Part {
  const i = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, i).replace(/\r\n[ \t]+/g, " "), body = raw.slice(i + 4);
  const headers: Record<string, string> = {};
  for (const l of head.split("\r\n")) { const k = l.indexOf(":"); headers[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); }
  const ct = headers["content-type"] ?? "";
  const bd = ct.match(/boundary="([^"]+)"/)?.[1];
  const parts = bd ? body.split(`--${bd}`).slice(1, -1).map((p) => parse(p.replace(/^\r\n/, ""))) : [];
  if (bd) expect(body).toContain(`--${bd}--`);
  return { headers, body, parts };
}
const decode = (p: Part) => new TextDecoder().decode(Uint8Array.from(atob(p.body.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const prop = (ics: string, name: string) => ics.replace(/\r\n[ \t]/g, "").split("\r\n").find((l) => l.startsWith(name + ":") || l.startsWith(name + ";"));

const booking = { uid: "meeting-1", icsUid: "meeting-1", title: "Meeting", startUtc: "2026-11-18T06:30:00.000Z", endUtc: "2026-11-18T07:00:00.000Z",
  location: "Video call", notes: "rescheduling our lunch call", hostName: "Alex Host", hostEmail: "alex@example.com", bookerName: "Pat Guest", bookerEmail: "pat@example.com", guests: [] };
const ctx = { origin: "https://calendar.example.com", appName: "Scheduler", now: "2026-11-16T14:14:25.000Z" };

describe("R16 invite email (MIME)", () => {
  const hostIcs = buildInvite(booking, "request", 0, { ...ctx, audience: "host", organizer: { name: "Scheduler", email: "bookings@calendar.example.com" } });
  const raw = buildMime({ from: { email: "bookings@calendar.example.com", name: "Scheduler" }, to: "alex@example.com", replyTo: "pat@example.com",
    subject: "Confirmed: Meeting with Pat Guest on Wed, Nov 18, 12:00pm", text: "plain ✓", html: "<p>html ✓</p>", ics: hostIcs, icsMethod: "REQUEST" });

  it("uses CRLF only and short lines", () => {
    expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const l of raw.split("\r\n")) expect(l.length).toBeLessThanOrEqual(78);
  });
  it("is mixed(alternative(text, html, text/calendar method=REQUEST), invite.ics)", () => {
    const m = parse(raw);
    expect(m.headers.from).toBe('"Scheduler" <bookings@calendar.example.com>');
    expect(m.headers.to).toBe("<alex@example.com>"); expect(m.headers["reply-to"]).toBe("<pat@example.com>");
    expect(m.headers["mime-version"]).toBe("1.0"); expect(m.headers["message-id"]).toMatch(/^<[0-9a-f]+@calendar\.example\.com>$/);
    expect(m.headers.subject).toBe("Confirmed: Meeting with Pat Guest on Wed, Nov 18, 12:00pm");
    expect(m.headers["content-type"]).toMatch(/^multipart\/mixed;/);
    expect(m.parts.length).toBe(2);
    const [alt, att] = m.parts;
    expect(alt.headers["content-type"]).toMatch(/^multipart\/alternative;/);
    expect(alt.parts.map((p) => p.headers["content-type"])).toEqual(["text/plain; charset=UTF-8", "text/html; charset=UTF-8", "text/calendar; charset=UTF-8; method=REQUEST"]);
    expect(decode(alt.parts[0])).toBe("plain ✓"); expect(decode(alt.parts[1])).toBe("<p>html ✓</p>");
    expect(decode(alt.parts[2])).toBe(hostIcs);
    expect(att.headers["content-disposition"]).toBe('attachment; filename="invite.ics"');
    expect(att.headers["content-type"]).toBe('application/ics; name="invite.ics"');
    expect(decode(att)).toBe(hostIcs);
  });
  it("host copy: organized by the sender, host is an accepted attendee (Gmail won't load an invite the recipient organizes)", () => {
    expect(prop(hostIcs, "ORGANIZER")).toBe("ORGANIZER;CN=Scheduler:mailto:bookings@calendar.example.com");
    expect(prop(hostIcs, "ATTENDEE;CN=Alex Host")).toBe("ATTENDEE;CN=Alex Host;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:alex@example.com");
    for (const [k, v] of [["METHOD", "METHOD:REQUEST"], ["STATUS", "STATUS:CONFIRMED"], ["DTSTART", "DTSTART:20261118T063000Z"], ["DTEND", "DTEND:20261118T070000Z"],
      ["UID", "UID:meeting-1@calendar.example.com"], ["SEQUENCE", "SEQUENCE:0"], ["DTSTAMP", "DTSTAMP:20261116T141425Z"]]) expect(prop(hostIcs, k)).toBe(v);
  });
  it("with no organizer given (email off, the download) the host organizes", () => {
    const g = buildInvite(booking, "request", 0, { ...ctx, audience: "guest" });
    expect(prop(g, "ORGANIZER")).toBe("ORGANIZER;CN=Alex Host:mailto:alex@example.com");
    expect(prop(g, "ATTENDEE;CN=Pat Guest")).toContain("mailto:pat@example.com");
  });
  it("encodes non-ASCII headers and sends CANCEL as such; no invite means plain alternative", () => {
    expect(encodeWord("Réunion")).toBe("=?UTF-8?B?UsOpdW5pb24=?=");
    const c = buildMime({ from: { email: "a@x.co", name: "Zoë" }, to: "b@y.co", subject: "Cancelled: Réunion", text: "t", html: "h", ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", icsMethod: "CANCEL" });
    expect(c).toContain("Subject: =?UTF-8?B?"); expect(c).toContain("From: =?UTF-8?B?"); expect(c).toContain("method=CANCEL");
    const p = parse(buildMime({ from: { email: "a@x.co" }, to: "b@y.co", subject: "Reminder", text: "t", html: "h" }));
    expect(p.headers["content-type"]).toMatch(/^multipart\/alternative;/); expect(p.parts.length).toBe(2);
  });
});
