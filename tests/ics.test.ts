import { describe, it, expect } from "vitest";
import { buildInvite, type InviteBooking } from "../src/shared/ics";

// A small RFC 5545 reader: unfold, then split name;params:value.
type P = { name: string; params: Record<string, string>; value: string };
function parse(ics: string) {
  const unfolded = ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
  return unfolded.map((l): P => {
    let i = 0, q = false; for (; i < l.length; i++) { if (l[i] === '"') q = !q; else if (l[i] === ":" && !q) break; }
    const [name, ...ps] = l.slice(0, i).split(";");
    return { name, params: Object.fromEntries(ps.map((p) => p.split("=") as [string, string])), value: l.slice(i + 1) };
  });
}
const get = (ps: P[], n: string) => ps.filter((p) => p.name === n);
const one = (ps: P[], n: string) => get(ps, n)[0]?.value;

const ctx = { origin: "https://calendar.example.com", appName: "Scheduler", now: "2026-11-15T12:00:00.000Z", audience: "guest" as const };
const first: InviteBooking = { uid: "aaa111", icsUid: "aaa111", title: "Intro call", startUtc: "2026-11-17T15:00:00.000Z", endUtc: "2026-11-17T15:30:00.000Z",
  location: "https://meet.example.com/alex", notes: "Bring the deck; and, notes\nline two", hostName: "Alex Rivera", hostEmail: "alex@example.com",
  bookerName: "Pat Guest, Jr.", bookerEmail: "pat@example.com", guests: ["sam@example.com"] };
const moved: InviteBooking = { ...first, uid: "bbb222", icsUid: "aaa111", startUtc: "2026-11-18T16:00:00.000Z", endUtc: "2026-11-18T16:30:00.000Z" };

describe("R16 invites", () => {
  const raw = [buildInvite(first, "request", 0, ctx), buildInvite(moved, "request", 1, ctx), buildInvite(moved, "cancel", 2, ctx)];
  const cals = raw.map(parse);
  it("keeps one UID across booking, reschedule and cancel; bumps SEQUENCE", () => {
    expect(cals.map((c) => one(c, "UID"))).toEqual(["aaa111@calendar.example.com", "aaa111@calendar.example.com", "aaa111@calendar.example.com"]);
    expect(cals.map((c) => one(c, "SEQUENCE"))).toEqual(["0", "1", "2"]);
    expect(cals.map((c) => one(c, "METHOD"))).toEqual(["REQUEST", "REQUEST", "CANCEL"]);
    expect(cals.map((c) => one(c, "STATUS"))).toEqual(["CONFIRMED", "CONFIRMED", "CANCELLED"]);
  });
  it("has UTC times matching the booking, organizer and accepted host", () => {
    expect(one(cals[0], "DTSTART")).toBe("20261117T150000Z"); expect(one(cals[0], "DTEND")).toBe("20261117T153000Z");
    expect(one(cals[1], "DTSTART")).toBe("20261118T160000Z"); expect(one(cals[1], "DTEND")).toBe("20261118T163000Z");
    expect(one(cals[0], "DTSTAMP")).toBe("20261115T120000Z");
    for (const c of cals) {
      const org = get(c, "ORGANIZER")[0];
      expect(org.value).toBe("mailto:alex@example.com"); expect(org.params.CN).toBe("Alex Rivera");
      const host = get(c, "ATTENDEE").find((a) => a.value === "mailto:alex@example.com")!;
      expect(host.params).toMatchObject({ PARTSTAT: "ACCEPTED", RSVP: "FALSE", ROLE: "CHAIR" });
      const guest = get(c, "ATTENDEE").find((a) => a.value === "mailto:pat@example.com")!;
      expect(guest.params.CN).toBe('"Pat Guest, Jr."'); expect(guest.params.PARTSTAT).toBe("ACCEPTED");
      expect(get(c, "ATTENDEE").some((a) => a.value === "mailto:sam@example.com")).toBe(true);
      expect(one(c, "TRANSP")).toBe("OPAQUE");
      expect(one(c, "PRODID")).toBe("-//Scheduler//Scheduler//EN"); expect(one(c, "VERSION")).toBe("2.0"); expect(one(c, "CALSCALE")).toBe("GREGORIAN");
    }
  });
  it("holds reschedule and cancel links and escapes text", () => {
    const d = one(cals[1], "DESCRIPTION");
    expect(d).toContain("Reschedule: https://calendar.example.com/booking/bbb222");
    expect(d).toContain("Cancel: https://calendar.example.com/booking/bbb222");
    expect(one(cals[0], "DESCRIPTION")).toContain("Bring the deck\\; and\\, notes\\nline two");
    expect(one(cals[0], "URL")).toBe("https://calendar.example.com/booking/aaa111");
    expect(one(cals[0], "SUMMARY")).toBe("Intro call with Alex Rivera");
    expect(one(parse(buildInvite(first, "request", 0, { ...ctx, audience: "host" })), "SUMMARY")).toBe("Intro call with Pat Guest\\, Jr.");
  });
  it("folds at 75 octets with CRLF line ends", () => {
    for (const r of raw) {
      expect(r.endsWith("\r\n")).toBe(true);
      expect(r.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      for (const line of r.split("\r\n").filter(Boolean)) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const long = buildInvite({ ...first, notes: "é".repeat(120) }, "request", 0, ctx);
    for (const line of long.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(one(parse(long), "DESCRIPTION")).toContain("é".repeat(120));
  });
  it("uses PUBLISH for the download", () => {
    expect(one(parse(buildInvite(first, "publish", 0, ctx)), "METHOD")).toBe("PUBLISH");
  });
});
