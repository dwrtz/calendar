// R19: calendar replies (iTIP REPLY/COUNTER over iMIP) to the organizer address, against a real SQLite database.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseItip, splitUid, normAddress } from "../src/shared/itip";
import { processInbound, senderMatches, REJECT } from "../src/worker/inbound";
import { organizerFor, makeMailer } from "../src/worker/email";
import { b64 } from "../src/worker/mime";

const ORG = "bookings@calendar.example.com";
const ENV = { EMAIL_PROVIDER: "test", TEST_CLOCK: "1", EMAIL_FROM: `"Scheduler" <${ORG}>`, SITE_URL: "https://calendar.example.com" };
const NOW = "2026-11-16T12:00:00.000Z";

function makeDb() {
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort()) sql.exec(readFileSync(`migrations/${f}`, "utf8"));
  const db = {
    one: async (q: string, ...p: any[]) => (sql.prepare(q).get(...p) as any) ?? undefined,
    all: async (q: string, ...p: any[]) => sql.prepare(q).all(...p) as any[],
    run: async (q: string, ...p: any[]) => { const r = sql.prepare(q).run(...p); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    nowIso: () => NOW,
  };
  sql.exec(`INSERT INTO users (id,email,password_hash,name,username,time_zone,created_at) VALUES (1,'alex@example.com','x','Alex Host','alex','America/New_York','${NOW}');
    INSERT INTO event_types (id,user_id,title,slug,duration_min,created_at) VALUES (1,1,'Intro call','intro',30,'${NOW}');
    INSERT INTO bookings (uid,event_type_id,host_id,title,start_utc,end_utc,start_ms,end_ms,status,booker_name,booker_email,booker_tz,guests,created_at,ics_uid,ics_sequence)
    VALUES ('bk1',1,1,'Intro call','2026-11-19T14:00:00.000Z','2026-11-19T14:30:00.000Z',0,0,'accepted','Pat Guest','pat@example.com','Europe/Berlin','["sam@example.org"]','${NOW}','bk1',0);`);
  return { sql, db };
}
const ics = (method: string, attendee: string, partstat: string, extra: string[] = [], uid = "bk1@calendar.example.com", seq = 0) => [
  "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`, "BEGIN:VEVENT",
  "DTSTART:20261119T140000Z", "DTEND:20261119T143000Z", "DTSTAMP:20261116T120000Z", `ORGANIZER;CN=Scheduler:mailto:${ORG}`, `UID:${uid}`,
  `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};CN=Some One;X-NUM-GUESTS=0:mailto:${attendee}`,
  "CREATED:20261116T110000Z", "LAST-MODIFIED:20261116T120000Z", `SEQUENCE:${seq}`, "STATUS:CONFIRMED", "SUMMARY:Intro call with Pat Guest", "TRANSP:OPAQUE",
  ...extra, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
/** A reply shaped like Google Calendar's: inline text/calendar; method=REPLY plus an invite.ics attachment, base64. */
const googleMail = (from: string, cal: string, method = "REPLY", subject = "Accepted: Intro call") => [
  `From: Some One <${from}>`, `To: ${ORG}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="mx"', "",
  "--mx", 'Content-Type: multipart/alternative; boundary="alt"', "",
  "--alt", 'Content-Type: text/plain; charset="UTF-8"', "", "Some One has accepted this invitation.", "",
  "--alt", `Content-Type: text/calendar; charset="UTF-8"; method=${method}`, "Content-Transfer-Encoding: base64", "", b64(cal), "",
  "--alt--", "", "--mx", 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', "Content-Transfer-Encoding: base64", "", b64(cal), "", "--mx--", ""].join("\r\n");
const GOOGLE_BOUNCE = "3abc-reply@calendar-server.bounces.google.com";

let ctx: ReturnType<typeof makeDb>; let notified: [string, number][];
const run = (from: string, raw: string, to = ORG, env: any = ENV) =>
  processInbound({ from, to, raw }, { env, db: ctx.db, notifyDeclined: async (uid, id) => { notified.push([uid, id]); } });
const rsvp = (email: string) => ctx.sql.prepare("SELECT * FROM booking_rsvps WHERE booking_uid='bk1' AND email=?").get(email) as any;
beforeEach(() => { ctx = makeDb(); notified = []; });

describe("R16/R19 organizer address", () => {
  it("every emailed invite is organized by the sending address; off without email", () => {
    expect(organizerFor(ENV)).toEqual({ name: "Scheduler", email: ORG });
    expect(organizerFor({ ...ENV, EMAIL_FROM: "Bookings@Example.COM" })).toEqual({ name: "Scheduler", email: "bookings@example.com" });
    expect(organizerFor({})).toBeUndefined();
    expect(organizerFor({ EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: ORG })).toBeUndefined(); // no binding: email is off
  });
  it("the guest and the host copies both name the organizer address, with the host as an accepted attendee", async () => {
    await makeMailer(ENV, ctx.db as any, ENV.SITE_URL).notify("confirmed", "bk1");
    const out = ctx.sql.prepare("SELECT recipient, ics FROM test_outbox").all() as any[];
    expect(out.map((o) => o.recipient).sort()).toEqual(["alex@example.com", "pat@example.com", "sam@example.org"]);
    for (const o of out) {
      expect(o.ics).toContain(`ORGANIZER;CN=Scheduler:mailto:${ORG}`);
      expect(o.ics.replace(/\r\n /g, "")).toContain("PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:alex@example.com");
    }
  });
});

describe("R19 iTIP parsing", () => {
  it("reads a Google-style REPLY", () => {
    const it = parseItip(ics("REPLY", "Alex@Example.com", "ACCEPTED"))!;
    expect(it.method).toBe("REPLY"); expect(it.uid).toBe("bk1@calendar.example.com"); expect(it.sequence).toBe(0);
    expect(it.attendees).toEqual([{ email: "alex@example.com", name: "Some One", partstat: "ACCEPTED", sentBy: "" }]);
    expect(it.organizer).toBe(ORG);
    expect(splitUid(it.uid)).toEqual({ id: "bk1", host: "calendar.example.com" });
  });
  it("reads a COUNTER's proposed time and ignores non-calendar text", () => {
    const c = parseItip(ics("COUNTER", "pat@example.com", "NEEDS-ACTION").replace("DTSTART:20261119T140000Z", "DTSTART;TZID=Europe/Berlin:20261120T100000").replace("DTEND:20261119T143000Z", "DTEND;TZID=Europe/Berlin:20261120T103000"))!;
    expect(c.proposed).toEqual({ startUtc: "2026-11-20T09:00:00.000Z", endUtc: "2026-11-20T09:30:00.000Z" });
    expect(parseItip("hello")).toBeUndefined();
  });
  it("matches the same mailbox written differently", () => {
    expect(normAddress("mailto:D.J.Smith+cal@googlemail.com")).toBe("djsmith@gmail.com");
    expect(senderMatches("pat@example.com", "", "PAT@example.com")).toBe(true);
    expect(senderMatches(GOOGLE_BOUNCE, "pat@example.com", "pat@example.com")).toBe(true);
    expect(senderMatches("mallory@evil.test", "pat@example.com", "pat@example.com")).toBe(false);
    expect(senderMatches(GOOGLE_BOUNCE, "mallory@evil.test", "pat@example.com")).toBe(false);
    expect(senderMatches("b-123@bounces.example.com", "pat@example.com", "pat@example.com")).toBe(true);
    expect(senderMatches("b-123@example.com.evil.test", "pat@example.com", "pat@example.com")).toBe(false);
  });
});

describe("R19 replies update the booking", () => {
  it("the host's Google rsvpAccepted is recorded with no email sent", async () => {
    const r = await run(GOOGLE_BOUNCE, googleMail("alex@example.com", ics("REPLY", "alex@example.com", "ACCEPTED")));
    expect(r).toMatchObject({ ok: true, action: "updated", role: "host", partstat: "ACCEPTED", notified: false, prompt: false });
    expect(rsvp("alex@example.com")).toMatchObject({ partstat: "ACCEPTED", role: "host", host_prompt: 0 });
    expect(notified).toEqual([]);
  });
  it("a guest's TENTATIVE is recorded without any email", async () => {
    const r = await run("sam@example.org", googleMail("sam@example.org", ics("REPLY", "sam@example.org", "TENTATIVE")));
    expect(r).toMatchObject({ ok: true, partstat: "TENTATIVE", role: "guest", notified: false });
    expect(rsvp("sam@example.org").partstat).toBe("TENTATIVE"); expect(notified).toEqual([]);
  });
  it("a guest's decline notifies the host once and never cancels", async () => {
    const mail = googleMail("pat@example.com", ics("REPLY", "pat@example.com", "DECLINED", ["COMMENT:Sorry\\, can't make it"]), "REPLY", "Declined: Intro call");
    expect(await run("pat@example.com", mail)).toMatchObject({ ok: true, partstat: "DECLINED", notified: true });
    expect(await run("pat@example.com", mail)).toMatchObject({ ok: true, notified: false });
    expect(notified.length).toBe(1);
    expect((ctx.sql.prepare("SELECT status FROM bookings WHERE uid='bk1'").get() as any).status).toBe("accepted");
    // the host email goes to the host only, links to the booking and carries the guest's note
    await makeMailer(ENV, ctx.db as any, ENV.SITE_URL).notifyHost("rsvp_declined", "bk1", notified[0][1]);
    const out = ctx.sql.prepare("SELECT recipient, subject, text, ics FROM test_outbox").all() as any[];
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ recipient: "alex@example.com", subject: "Declined: Intro call with Pat Guest on Thu, Nov 19, 9:00am", ics: "" });
    expect(out[0].text).toContain("Pat Guest declined this meeting in their calendar. Note: Sorry, can't make it");
    expect(out[0].text).toContain("https://calendar.example.com/booking/bk1");
  });
  it("the host declining their own copy flags the booking for a cancel prompt, and accepting clears it", async () => {
    expect(await run("alex@example.com", googleMail("alex@example.com", ics("REPLY", "alex@example.com", "DECLINED")))).toMatchObject({ ok: true, prompt: true, notified: false });
    expect(rsvp("alex@example.com").host_prompt).toBe(1);
    expect((ctx.sql.prepare("SELECT status FROM bookings WHERE uid='bk1'").get() as any).status).toBe("accepted");
    const later = ics("REPLY", "alex@example.com", "ACCEPTED").replace("DTSTAMP:20261116T120000Z", "DTSTAMP:20261116T130000Z");
    await run("alex@example.com", googleMail("alex@example.com", later));
    expect(rsvp("alex@example.com")).toMatchObject({ partstat: "ACCEPTED", host_prompt: 0 });
  });
  it("a COUNTER is stored for the host and moves nothing", async () => {
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("COUNTER", "pat@example.com", "NEEDS-ACTION").replace("DTSTART:20261119T140000Z", "DTSTART:20261120T090000Z").replace("DTEND:20261119T143000Z", "DTEND:20261120T093000Z"), "COUNTER"))).toMatchObject({ ok: true, action: "counter" });
    expect(rsvp("pat@example.com")).toMatchObject({ counter_start: "2026-11-20T09:00:00.000Z", counter_end: "2026-11-20T09:30:00.000Z", partstat: "" });
    expect((ctx.sql.prepare("SELECT start_utc FROM bookings WHERE uid='bk1'").get() as any).start_utc).toBe("2026-11-19T14:00:00.000Z");
  });
  it("a reply for an older SEQUENCE changes nothing", async () => {
    ctx.sql.exec("UPDATE bookings SET ics_sequence=2 WHERE uid='bk1'");
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "DECLINED")))).toMatchObject({ ok: true, action: "stale" });
    expect(rsvp("pat@example.com")).toBeUndefined(); expect(notified).toEqual([]);
  });
});

describe("R19 rejects what it can't use", () => {
  it("a spoofed attendee who is not on the booking", async () => {
    expect(await run("mallory@evil.test", googleMail("mallory@evil.test", ics("REPLY", "mallory@evil.test", "DECLINED")))).toEqual({ ok: false, reason: REJECT.attendee });
  });
  it("a real attendee's address sent from someone else", async () => {
    expect(await run("mallory@evil.test", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "DECLINED")))).toEqual({ ok: false, reason: REJECT.sender });
    expect(rsvp("pat@example.com")).toBeUndefined(); expect(notified).toEqual([]);
  });
  it("a plain email with no calendar part", async () => {
    const plain = [`From: <pat@example.com>`, `To: ${ORG}`, "Subject: hi", "Content-Type: text/plain", "", "Thanks for the meeting!", ""].join("\r\n");
    expect(await run("pat@example.com", plain)).toEqual({ ok: false, reason: REJECT.notCalendar });
  });
  it("other iTIP methods, unknown events, other mailboxes, and email turned off", async () => {
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("REQUEST", "pat@example.com", "ACCEPTED"), "REQUEST"))).toEqual({ ok: false, reason: REJECT.method });
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "ACCEPTED", [], "nope@calendar.example.com")))).toEqual({ ok: false, reason: REJECT.unknown });
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "ACCEPTED", [], "bk1@other.example.net")))).toEqual({ ok: false, reason: REJECT.unknown });
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "ACCEPTED")), "someone@calendar.example.com")).toEqual({ ok: false, reason: REJECT.mailbox });
    expect(await run("pat@example.com", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "ACCEPTED")), ORG, {})).toEqual({ ok: false, reason: REJECT.off });
  });
});
