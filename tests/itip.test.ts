// R19: calendar replies (iTIP REPLY/COUNTER over iMIP) to the organizer address, against a real SQLite database:
// declines cancel, proposed new times are checked, held, offered to the other party, and confirmed, declined or expired.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseItip, splitUid, normAddress } from "../src/shared/itip";
import { processInbound, senderMatches, REJECT } from "../src/worker/inbound";
import { organizerFor, makeMailer } from "../src/worker/email";
import { makeLogic } from "../src/worker/logic";
import { clearChanges, expireDue, makeSlotFree } from "../src/worker/changes";
import { b64 } from "../src/worker/mime";

const ORG = "bookings@calendar.example.com";
const ENV = { EMAIL_PROVIDER: "test", TEST_CLOCK: "1", EMAIL_FROM: `"Scheduler" <${ORG}>`, SITE_URL: "https://calendar.example.com" };
const NOW = "2026-11-16T12:00:00.000Z";

let clock = NOW;
/** A D1-shaped wrapper over node:sqlite, so the Worker's own slot logic (R5) runs unchanged. */
function d1(sql: DatabaseSync) {
  const stmt = (q: string, p: any[] = []) => ({
    bind: (...b: any[]) => stmt(q, b),
    first: async () => (sql.prepare(q).get(...p) as any) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...p) as any[] }),
    run: async () => { const r = sql.prepare(q).run(...p); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: (q: string) => stmt(q), batch: async (list: any[]) => Promise.all(list.map((x) => x.run())) };
}
function makeDb() {
  const sql = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort()) sql.exec(readFileSync(`migrations/${f}`, "utf8"));
  const db = {
    one: async (q: string, ...p: any[]) => (sql.prepare(q).get(...p) as any) ?? undefined,
    all: async (q: string, ...p: any[]) => sql.prepare(q).all(...p) as any[],
    run: async (q: string, ...p: any[]) => { const r = sql.prepare(q).run(...p); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    nowIso: () => clock,
  };
  // Alex hosts Monday to Friday, 9am to 5pm New York time. bk1 is Thursday Nov 19, 9:00-9:30am there.
  sql.exec(`INSERT INTO users (id,email,password_hash,name,username,time_zone,created_at) VALUES (1,'alex@example.com','x','Alex Host','alex','America/New_York','${NOW}');
    INSERT INTO schedules (id,user_id,name,time_zone,is_default) VALUES (1,1,'Working hours','America/New_York',1);
    INSERT INTO schedule_hours (schedule_id,weekday,start_min,end_min) VALUES (1,1,540,1020),(1,2,540,1020),(1,3,540,1020),(1,4,540,1020),(1,5,540,1020);
    INSERT INTO event_types (id,user_id,title,slug,duration_min,created_at) VALUES (1,1,'Intro call','intro',30,'${NOW}');
    INSERT INTO bookings (uid,event_type_id,host_id,title,start_utc,end_utc,start_ms,end_ms,status,booker_name,booker_email,booker_tz,guests,created_at,ics_uid,ics_sequence)
    VALUES ('bk1',1,1,'Intro call','2026-11-19T14:00:00.000Z','2026-11-19T14:30:00.000Z',${Date.parse("2026-11-19T14:00:00Z")},${Date.parse("2026-11-19T14:30:00Z")},'accepted','Pat Guest','pat@example.com','Europe/Berlin','["sam@example.org"]','${NOW}','bk1',0);`);
  const env = { ...ENV, NOW, DB: d1(sql) };
  const slotFree = makeSlotFree(db, makeLogic(env as any, new Request("https://calendar.example.com/")).slotsFor);
  return { sql, db, slotFree };
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

let ctx: ReturnType<typeof makeDb>;
const mailer = () => makeMailer(ENV, ctx.db as any, ENV.SITE_URL);
const run = (from: string, raw: string, to = ORG, env: any = ENV) =>
  processInbound({ from, to, raw }, { env, db: ctx.db, mailer: mailer(), slotFree: ctx.slotFree });
const rsvp = (email: string) => ctx.sql.prepare("SELECT * FROM booking_rsvps WHERE booking_uid='bk1' AND email=?").get(email) as any;
const booking = () => ctx.sql.prepare("SELECT * FROM bookings WHERE uid='bk1'").get() as any;
const outbox = () => (ctx.sql.prepare("SELECT recipient, subject, text, ics FROM test_outbox ORDER BY id").all() as any[]).map((o) => ({ ...o, ics: o.ics.replace(/\r\n /g, "") }));
const changes = () => ctx.sql.prepare("SELECT * FROM booking_changes ORDER BY id").all() as any[];
const holds = () => ctx.sql.prepare("SELECT * FROM busy_blocks WHERE source LIKE 'hold:%'").all() as any[];
/** A Google-style COUNTER proposing new UTC times ("20261120T150000Z"). */
const counter = (who: string, start: string, end: string, seq = 0, extra: string[] = []) =>
  googleMail(who, ics("COUNTER", who, "NEEDS-ACTION", extra, undefined, seq).replace("DTSTART:20261119T140000Z", `DTSTART:${start}`).replace("DTEND:20261119T143000Z", `DTEND:${end}`), "COUNTER", "New time proposed: Intro call");
const reply = (who: string, partstat: string, seq = 0, extra: string[] = []) =>
  googleMail(who, ics("REPLY", who, partstat, extra, undefined, seq), "REPLY", `${partstat}: Intro call`);
// Friday Nov 20, 10:00-10:30am New York: free. Saturday Nov 21: outside working hours.
const FRI = ["20261120T150000Z", "20261120T153000Z"] as const, SAT = ["20261121T150000Z", "20261121T153000Z"] as const;
beforeEach(() => { clock = NOW; ctx = makeDb(); });

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

describe("R19 accepted and tentative are status only", () => {
  it("the host's Google rsvpAccepted is recorded with no email sent", async () => {
    const r = await run(GOOGLE_BOUNCE, googleMail("alex@example.com", ics("REPLY", "alex@example.com", "ACCEPTED")));
    expect(r).toMatchObject({ ok: true, action: "updated", role: "host", partstat: "ACCEPTED" });
    expect(rsvp("alex@example.com")).toMatchObject({ partstat: "ACCEPTED", role: "host" });
    expect(outbox()).toEqual([]);
  });
  it("a guest's TENTATIVE is recorded without any email", async () => {
    const r = await run("sam@example.org", googleMail("sam@example.org", ics("REPLY", "sam@example.org", "TENTATIVE")));
    expect(r).toMatchObject({ ok: true, partstat: "TENTATIVE", role: "guest" });
    expect(rsvp("sam@example.org").partstat).toBe("TENTATIVE"); expect(outbox()).toEqual([]);
  });
});

describe("R19 a decline cancels the booking", () => {
  it("the guest declines: cancelled, CANCEL to everyone (their own copy too), once", async () => {
    const mail = googleMail("pat@example.com", ics("REPLY", "pat@example.com", "DECLINED", ["COMMENT:Sorry\\, can't make it"]), "REPLY", "Declined: Intro call");
    expect(await run("pat@example.com", mail)).toMatchObject({ ok: true, action: "cancelled", role: "guest", partstat: "DECLINED" });
    expect(booking()).toMatchObject({ status: "cancelled", cancelled_by: "guest", ics_sequence: 1, cancel_reason: "Declined in their calendar: Sorry, can't make it" });
    const out = outbox();
    expect(out.map((o) => o.recipient).sort()).toEqual(["alex@example.com", "pat@example.com", "sam@example.org"]);
    for (const o of out) {
      expect(o.subject).toMatch(/^Cancelled: Intro call with /);
      expect(o.ics).toContain("METHOD:CANCEL"); expect(o.ics).toContain("SEQUENCE:1"); expect(o.ics).toContain("STATUS:CANCELLED");
      expect(o.ics).toContain("UID:bk1@calendar.example.com");
    }
    expect(out.find((o) => o.recipient === "alex@example.com")!.text).toContain("Pat Guest cancelled this meeting. Reason: Declined in their calendar: Sorry, can't make it");
    // the same decline again (a retry) changes and sends nothing
    expect(await run("pat@example.com", mail)).toMatchObject({ ok: true, action: "stale" });
    expect(outbox().length).toBe(3);
  });
  it("the host declines their own copy: cancelled by the host, the guests are told", async () => {
    expect(await run(GOOGLE_BOUNCE, googleMail("alex@example.com", ics("REPLY", "alex@example.com", "DECLINED")))).toMatchObject({ ok: true, action: "cancelled", role: "host" });
    expect(booking()).toMatchObject({ status: "cancelled", cancelled_by: "host" });
    const pat = outbox().find((o) => o.recipient === "pat@example.com")!;
    expect(pat.text).toContain("Alex Host cancelled this meeting. Reason: Declined in their calendar");
    expect(pat.ics).toContain("METHOD:CANCEL");
    expect(outbox().length).toBe(3);
  });
  it("an extra guest declining is recorded only; the meeting stays", async () => {
    expect(await run("sam@example.org", googleMail("sam@example.org", ics("REPLY", "sam@example.org", "DECLINED")))).toMatchObject({ ok: true, action: "updated", party: false });
    expect(booking().status).toBe("accepted"); expect(outbox()).toEqual([]);
  });
  it("a decline for an older SEQUENCE changes nothing", async () => {
    ctx.sql.exec("UPDATE bookings SET ics_sequence=2 WHERE uid='bk1'");
    expect(await run("pat@example.com", reply("pat@example.com", "DECLINED", 1))).toMatchObject({ ok: true, action: "stale" });
    expect(rsvp("pat@example.com")).toBeUndefined(); expect(booking().status).toBe("accepted"); expect(outbox()).toEqual([]);
  });
  it("a decline older than one already recorded (same SEQUENCE, earlier DTSTAMP) changes nothing", async () => {
    const later = ics("REPLY", "pat@example.com", "ACCEPTED").replace("DTSTAMP:20261116T120000Z", "DTSTAMP:20261116T130000Z");
    await run("pat@example.com", googleMail("pat@example.com", later));
    expect(await run("pat@example.com", reply("pat@example.com", "DECLINED"))).toMatchObject({ action: "stale" });
    expect(booking().status).toBe("accepted");
  });
});

describe("R19 a proposed new time", () => {
  it("valid: held, sent to the other party only as a REQUEST asking them to answer; the booking keeps its time", async () => {
    expect(await run("pat@example.com", counter("pat@example.com", ...FRI, 0, ["COMMENT:Friday works better"]))).toMatchObject({ ok: true, action: "change_proposed", role: "guest" });
    expect(booking()).toMatchObject({ start_utc: "2026-11-19T14:00:00.000Z", ics_sequence: 0, status: "accepted" });
    expect(changes()).toMatchObject([{ status: "pending", sequence: 1, start_utc: "2026-11-20T15:00:00.000Z", proposer_role: "guest", counterpart_email: "alex@example.com", expires_at: "2026-11-19T14:00:00.000Z" }]);
    expect(holds()).toMatchObject([{ source: "hold:bk1", user_id: 1, start_ms: Date.parse("2026-11-20T15:00:00Z") }]);
    const out = outbox();
    expect(out.length).toBe(1);
    expect(out[0].recipient).toBe("alex@example.com");
    expect(out[0].subject).toBe("New time proposed: Intro call with Pat Guest on Fri, Nov 20, 10:00am");
    expect(out[0].text).toContain("Pat Guest proposed a new time: Friday, November 20, 2026, 10:00am - 10:30am (America/New_York) (it was Thursday, November 19, 2026, 9:00am - 9:30am (America/New_York)). Note: Friday works better");
    expect(out[0].text).toContain("https://calendar.example.com/booking/bk1");
    expect(out[0].ics).toContain("METHOD:REQUEST"); expect(out[0].ics).toContain("SEQUENCE:1");
    expect(out[0].ics).toContain("DTSTART:20261120T150000Z");
    expect(out[0].ics).toContain("PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alex@example.com");
    expect(out[0].ics).toContain("PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:pat@example.com");
    // the held time is no longer offered to anyone else
    const other = { ...booking(), uid: "other" };
    expect(await ctx.slotFree(other, "2026-11-20T15:00:00.000Z")).toBe(false);
    expect(await ctx.slotFree(booking(), "2026-11-20T15:00:00.000Z")).toBe(true);
    // the same COUNTER delivered twice sends nothing more
    expect(await run("pat@example.com", counter("pat@example.com", ...FRI))).toMatchObject({ action: "duplicate" });
    expect(outbox().length).toBe(1);
  });
  it("invalid (outside working hours): DECLINECOUNTER to the proposer with a note; nothing held or moved", async () => {
    expect(await run("pat@example.com", counter("pat@example.com", ...SAT))).toMatchObject({ ok: true, action: "counter_declined", reason: "That time isn't available." });
    expect(booking()).toMatchObject({ start_utc: "2026-11-19T14:00:00.000Z", ics_sequence: 0 });
    expect(holds()).toEqual([]); expect(changes()[0].status).toBe("rejected");
    const out = outbox();
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ recipient: "pat@example.com", subject: "New time not available: Intro call with Alex Host on Thu, Nov 19, 3:00pm" });
    expect(out[0].text).toContain("That time isn't available. The meeting stays at Thursday, November 19, 2026, 3:00pm - 3:30pm (Europe/Berlin).");
    expect(out[0].ics).toContain("METHOD:DECLINECOUNTER"); expect(out[0].ics).toContain("ATTENDEE;CN=Pat Guest:mailto:pat@example.com");
    expect(out[0].ics).toContain("COMMENT:That time isn't available.");
    expect(await run("pat@example.com", counter("pat@example.com", ...SAT))).toMatchObject({ action: "duplicate" });
    expect(outbox().length).toBe(1);
  });
  it("invalid: a different length, a past time, or from an extra guest", async () => {
    expect(await run("pat@example.com", counter("pat@example.com", "20261120T150000Z", "20261120T160000Z"))).toMatchObject({ action: "counter_declined", reason: "The new time has to be the same length as the meeting (30 minutes)." });
    expect(await run("pat@example.com", counter("pat@example.com", "20261116T080000Z", "20261116T083000Z"))).toMatchObject({ action: "counter_declined", reason: "That time has already passed." });
    expect(await run("sam@example.org", counter("sam@example.org", ...FRI))).toMatchObject({ action: "counter_declined", reason: "Only the host or the person who booked can move this meeting." });
    expect(holds()).toEqual([]); expect(booking().start_utc).toBe("2026-11-19T14:00:00.000Z");
  });
  it("the other party accepts: moved, original time freed, final REQUEST to everyone, reminders follow", async () => {
    ctx.sql.exec("INSERT INTO email_log (booking_uid,kind,offset_min,recipient,status,attempts,error,created_at) VALUES ('bk1','reminder',1440,'pat@example.com','sent',1,'','x')");
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    expect(await run(GOOGLE_BOUNCE, googleMail("alex@example.com", ics("REPLY", "alex@example.com", "ACCEPTED", [], undefined, 1)))).toMatchObject({ action: "change_accepted", role: "host" });
    expect(booking()).toMatchObject({ status: "accepted", start_utc: "2026-11-20T15:00:00.000Z", end_utc: "2026-11-20T15:30:00.000Z", start_ms: Date.parse("2026-11-20T15:00:00Z"), ics_sequence: 2 });
    expect(changes()[0].status).toBe("accepted"); expect(holds()).toEqual([]);
    expect(ctx.sql.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind='reminder'").get()).toEqual({ n: 0 });
    const final = outbox().slice(1);
    expect(final.map((o) => o.recipient).sort()).toEqual(["alex@example.com", "pat@example.com", "sam@example.org"]);
    for (const o of final) {
      expect(o.subject).toMatch(/^Moved: Intro call with /);
      expect(o.ics).toContain("METHOD:REQUEST"); expect(o.ics).toContain("SEQUENCE:2"); expect(o.ics).toContain("DTSTART:20261120T150000Z");
      expect(o.ics).not.toContain("NEEDS-ACTION");
    }
    expect(final[0].text).toContain("the new time Pat Guest proposed and Alex Host accepted");
    // the original time is bookable again
    expect(await ctx.slotFree({ ...booking(), uid: "other" }, "2026-11-19T14:00:00.000Z")).toBe(true);
  });
  it("the other party declines the proposed time: the meeting is cancelled for everyone", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    expect(await run("alex@example.com", googleMail("alex@example.com", ics("REPLY", "alex@example.com", "DECLINED", [], undefined, 1)))).toMatchObject({ action: "change_declined" });
    expect(booking()).toMatchObject({ status: "cancelled", cancelled_by: "host", cancel_reason: "Declined the proposed new time", ics_sequence: 2, start_utc: "2026-11-19T14:00:00.000Z" });
    expect(changes()[0].status).toBe("declined"); expect(holds()).toEqual([]);
    const cancels = outbox().slice(1);
    expect(cancels.map((o) => o.recipient).sort()).toEqual(["alex@example.com", "pat@example.com", "sam@example.org"]);
    for (const o of cancels) { expect(o.ics).toContain("METHOD:CANCEL"); expect(o.ics).toContain("SEQUENCE:2"); }
  });
  it("the host proposes: the guest is asked; the guest accepts", async () => {
    expect(await run(GOOGLE_BOUNCE, counter("alex@example.com", ...FRI))).toMatchObject({ action: "change_proposed", role: "host" });
    const ask = outbox();
    expect(ask.map((o) => o.recipient)).toEqual(["pat@example.com"]);
    expect(ask[0].ics).toContain("PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:pat@example.com");
    expect(ask[0].ics).toContain("PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:alex@example.com");
    expect(ask[0].text).toContain("Alex Host proposed a new time: Friday, November 20, 2026, 4:00pm - 4:30pm (Europe/Berlin)");
    expect(await run("pat@example.com", reply("pat@example.com", "ACCEPTED", 1))).toMatchObject({ action: "change_accepted" });
    expect(booking().start_utc).toBe("2026-11-20T15:00:00.000Z");
  });
  it("tentative from the other party, or an answer to the old version, does not resolve the proposal", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    expect(await run("alex@example.com", reply("alex@example.com", "TENTATIVE", 1))).toMatchObject({ action: "updated" });
    expect(await run("alex@example.com", reply("alex@example.com", "ACCEPTED", 1).replace(/DTSTAMP:20261116T120000Z/g, "DTSTAMP:20261116T130000Z"))).toMatchObject({ action: "change_accepted" });
    expect(booking().start_utc).toBe("2026-11-20T15:00:00.000Z");
  });
  it("an ACCEPTED for the previous SEQUENCE leaves the proposal pending", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    expect(await run("alex@example.com", reply("alex@example.com", "ACCEPTED", 0))).toMatchObject({ action: "updated" });
    expect(changes()[0].status).toBe("pending"); expect(booking().start_utc).toBe("2026-11-19T14:00:00.000Z");
  });
  it("a newer proposal replaces a pending one at a higher SEQUENCE", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    expect(await run("pat@example.com", counter("pat@example.com", "20261120T160000Z", "20261120T163000Z"))).toMatchObject({ action: "change_proposed" });
    expect(changes().map((c) => [c.status, c.sequence])).toEqual([["superseded", 1], ["pending", 2]]);
    expect(holds()).toMatchObject([{ start_ms: Date.parse("2026-11-20T16:00:00Z") }]);
    expect(outbox()[1].ics).toContain("SEQUENCE:2");
  });
  it("expires at the original start if nobody answers: the original time stands and everyone is told", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    clock = "2026-11-19T13:59:00.000Z";
    expect(await expireDue(ctx.db, mailer())).toBe(0);
    clock = "2026-11-19T14:00:00.000Z";
    expect(await expireDue(ctx.db, mailer())).toBe(1);
    expect(changes()[0].status).toBe("expired"); expect(holds()).toEqual([]);
    expect(booking()).toMatchObject({ start_utc: "2026-11-19T14:00:00.000Z", ics_sequence: 2, status: "accepted" });
    const kept = outbox().slice(1);
    expect(kept.map((o) => o.recipient).sort()).toEqual(["alex@example.com", "pat@example.com", "sam@example.org"]);
    for (const o of kept) { expect(o.subject).toMatch(/^Unchanged: /); expect(o.ics).toContain("SEQUENCE:2"); expect(o.ics).toContain("DTSTART:20261119T140000Z"); }
    expect(await expireDue(ctx.db, mailer())).toBe(0);
  });
  it("a late acceptance after expiry moves nothing", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    clock = "2026-11-19T14:05:00.000Z";
    expect(await run("alex@example.com", reply("alex@example.com", "ACCEPTED", 1))).toMatchObject({ action: "updated" });
    expect(booking().start_utc).toBe("2026-11-19T14:00:00.000Z"); expect(changes()[0].status).toBe("expired");
  });
  it("cancelling or moving from the web ends a pending proposal and outranks its SEQUENCE", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    expect(await clearChanges(ctx.db, "bk1")).toBe(1);
    expect(changes()[0].status).toBe("cancelled"); expect(holds()).toEqual([]);
  });
});

describe("R19 loop guard", () => {
  it("mail from the organizer address itself is never processed", async () => {
    expect(await run(ORG, googleMail("pat@example.com", ics("REPLY", "pat@example.com", "DECLINED")))).toEqual({ ok: false, reason: REJECT.loop });
    expect(await run("pat@example.com", googleMail(ORG, ics("REPLY", "pat@example.com", "DECLINED")))).toEqual({ ok: false, reason: REJECT.loop });
    expect(booking().status).toBe("accepted"); expect(outbox()).toEqual([]);
  });
  it("nothing the app sends is a REPLY", async () => {
    await run("pat@example.com", counter("pat@example.com", ...FRI));
    await run("pat@example.com", counter("pat@example.com", ...SAT));
    await run("alex@example.com", reply("alex@example.com", "DECLINED", 1));
    expect(outbox().length).toBeGreaterThan(3);
    for (const o of outbox()) expect(o.ics).not.toContain("METHOD:REPLY");
  });
});

describe("R19 rejects what it can't use", () => {
  it("a spoofed attendee who is not on the booking", async () => {
    expect(await run("mallory@evil.test", googleMail("mallory@evil.test", ics("REPLY", "mallory@evil.test", "DECLINED")))).toEqual({ ok: false, reason: REJECT.attendee });
  });
  it("a real attendee's address sent from someone else", async () => {
    expect(await run("mallory@evil.test", googleMail("pat@example.com", ics("REPLY", "pat@example.com", "DECLINED")))).toEqual({ ok: false, reason: REJECT.sender });
    expect(rsvp("pat@example.com")).toBeUndefined(); expect(outbox()).toEqual([]);
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
