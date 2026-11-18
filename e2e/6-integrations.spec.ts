import { test, expect, type APIRequestContext } from "@playwright/test";
import { login, slots, flat, book } from "./helpers";

// R15-R17 against a server with EMAIL_PROVIDER=test (outbox in D1), a test ENCRYPTION_KEY and a fixture iCal feed.
test.describe.configure({ mode: "serial" });
const outbox = async (r: APIRequestContext) => (await (await r.get("/api/test/outbox")).json()) as any[];
const mailsFor = async (r: APIRequestContext, uid: string) => (await outbox(r)).filter((m) => m.text.includes(`/booking/${uid}`));
const prop = (ics: string, name: string) => ics.replace(/\r\n[ \t]/g, "").split("\r\n").find((l) => l.startsWith(name + ":") || l.startsWith(name + ";"))?.split(":").slice(1).join(":");
const cron = (r: APIRequestContext, now: string) => r.post(`/api/test/scheduled?now=${now}`);
const minus = (iso: string, min: number) => new Date(Date.parse(iso) - min * 60000).toISOString();

test("R15/R16 booking, moving and cancelling each email the guest and the host once, with invites", async ({ page, request }) => {
  const free = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-19"));
  const uid = (await (await book(request, "alex", "intro", free[0], { name: "Pat Guest", email: "pat@example.com" })).json()).uid;
  await expect.poll(async () => (await mailsFor(request, uid)).length).toBe(2);
  let m = await mailsFor(request, uid);
  const guest = m.find((x) => x.recipient === "pat@example.com"), host = m.find((x) => x.recipient === "alex@example.com");
  // 19 Nov 14:00Z is 3:00pm in Berlin (guest) and 9:00am in New York (host)
  expect(guest.subject).toBe("Confirmed: Intro call with Alex Rivera on Thu, Nov 19, 3:00pm");
  expect(host.subject).toBe("Confirmed: Intro call with Pat Guest on Thu, Nov 19, 9:00am");
  expect(guest.reply_to).toBe("alex@example.com");
  expect(guest.text).toContain(`Reschedule: http://127.0.0.1:3221/booking/${uid}`);
  expect(guest.text).toContain("(Europe/Berlin)"); expect(host.text).toContain("(America/New_York)");
  expect(prop(guest.ics, "METHOD")).toBe("REQUEST"); expect(prop(guest.ics, "SEQUENCE")).toBe("0"); expect(prop(guest.ics, "STATUS")).toBe("CONFIRMED");
  const UID = prop(guest.ics, "UID");
  expect(UID).toBe(`${uid}@127.0.0.1`);
  // Every emailed copy is organized by the sending address (Gmail won't load a host copy the host organizes, and
  // calendar replies must come back to the app, R19); the host is an accepted attendee
  expect(prop(guest.ics, "ORGANIZER")).toBe("mailto:bookings@example.com");
  expect(prop(host.ics, "ORGANIZER")).toBe("mailto:bookings@example.com");
  expect(host.ics.replace(/\r\n[ \t]/g, "")).toContain("PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:alex@example.com");
  expect(prop(host.ics, "UID")).toBe(UID);
  for (const x of [guest, host]) {
    expect(x.mime).toMatch(/^Content-Type: multipart\/mixed; boundary=/m);
    expect(x.mime).toMatch(/^Content-Type: multipart\/alternative; boundary=/m);
    expect(x.mime).toContain("Content-Type: text/calendar; charset=UTF-8; method=REQUEST");
    expect(x.mime).toContain('Content-Disposition: attachment; filename="invite.ics"');
    expect(x.mime.replace(/\r\n/g, "")).not.toContain("\n");
  }
  await page.goto(`/booking/${uid}`);
  await expect(page.getByText("We've emailed you the details.")).toBeVisible();
  // move it
  const r2 = await book(request, "alex", "intro", free[2], { name: "Pat Guest", email: "pat@example.com", reschedule: uid });
  const uid2 = (await r2.json()).uid;
  await expect.poll(async () => (await mailsFor(request, uid2)).length).toBe(2);
  m = await mailsFor(request, uid2);
  expect(m.map((x) => x.subject.split(":")[0]).sort()).toEqual(["Moved", "Moved"]);
  const g2 = m.find((x) => x.recipient === "pat@example.com");
  expect(prop(g2.ics, "UID")).toBe(UID); expect(prop(g2.ics, "SEQUENCE")).toBe("1"); expect(prop(g2.ics, "METHOD")).toBe("REQUEST");
  expect(prop(g2.ics, "DTSTART")).toBe(free[2].replace(/[-:]/g, "").replace(".000", ""));
  // the download uses the same UID and sequence
  const dl = await (await request.get(`/api/public/bookings/${uid2}/ics`)).text();
  expect(prop(dl, "UID")).toBe(UID); expect(prop(dl, "SEQUENCE")).toBe("1"); expect(prop(dl, "METHOD")).toBe("PUBLISH");
  expect(prop(dl, "ORGANIZER")).toBe("mailto:bookings@example.com");
  // cancel it
  await request.post(`/api/public/bookings/${uid2}/cancel`, { data: { reason: "Clash" } });
  await expect.poll(async () => (await mailsFor(request, uid2)).length).toBe(4);
  const c = (await mailsFor(request, uid2)).filter((x) => x.subject.startsWith("Cancelled:"));
  expect(c.length).toBe(2);
  const cg = c.find((x) => x.recipient === "pat@example.com");
  expect(c.find((x) => x.recipient === "alex@example.com").mime).toContain("text/calendar; charset=UTF-8; method=CANCEL");
  expect(prop(c.find((x) => x.recipient === "alex@example.com").ics, "ORGANIZER")).toBe("mailto:bookings@example.com");
  expect(prop(cg.ics, "METHOD")).toBe("CANCEL"); expect(prop(cg.ics, "STATUS")).toBe("CANCELLED"); expect(prop(cg.ics, "SEQUENCE")).toBe("2"); expect(prop(cg.ics, "UID")).toBe(UID);
  expect(cg.text).toContain("Reason: Clash");
});

test("R15 pending requests get no invite until accepted", async ({ page, request }) => {
  const dd = flat(await slots(request, "alex", "deep-dive"));
  const uid = (await (await book(request, "alex", "deep-dive", dd[0], { name: "Rita Request", email: "rita@example.com" })).json()).uid;
  await expect.poll(async () => (await mailsFor(request, uid)).length).toBe(2);
  const m = await mailsFor(request, uid);
  expect(m.find((x) => x.recipient === "rita@example.com").subject).toMatch(/^Request received: /);
  expect(m.find((x) => x.recipient === "alex@example.com").subject).toMatch(/^New request: /);
  expect(m.every((x) => x.ics === "")).toBe(true);
  await login(page);
  expect((await page.request.post(`/api/bookings/${uid}/accept`, { data: {} })).ok()).toBe(true);
  await expect.poll(async () => (await mailsFor(request, uid)).length).toBe(4);
  const acc = (await mailsFor(request, uid)).filter((x) => x.subject.startsWith("Confirmed:"));
  expect(acc.length).toBe(2); expect(prop(acc[0].ics, "STATUS")).toBe("CONFIRMED");
});

test("R15 reminders: the cron sends each once, and a moved booking only for its new time", async ({ request }) => {
  const tue = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-17"));
  const r1 = (await (await book(request, "alex", "intro", tue[0], { name: "Remy Remind", email: "remy@example.com" })).json()).uid;
  const at = minus(tue[0], 1440 - 5); // 5 minutes after the 1-day reminder was due
  expect((await cron(request, at)).ok()).toBe(true);
  expect((await cron(request, at)).ok()).toBe(true);
  let rem = (await mailsFor(request, r1)).filter((x) => x.subject.startsWith("Reminder:"));
  expect(rem.length).toBe(2);
  expect(rem.find((x) => x.recipient === "remy@example.com").subject).toBe("Reminder: Intro call with Alex Rivera starts in 1 day");
  // moved booking
  const wed = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-18"));
  const m1 = (await (await book(request, "alex", "intro", wed[0], { name: "Mo Mover", email: "mo@example.com" })).json()).uid;
  const m2 = (await (await book(request, "alex", "intro", wed[4], { name: "Mo Mover", email: "mo@example.com", reschedule: m1 })).json()).uid;
  await cron(request, minus(wed[0], 60 - 5)); // old time's 1-hour reminder would be due now
  await cron(request, minus(wed[4], 60 - 5)); // new time's 1-hour reminder is due now
  expect((await mailsFor(request, m1)).filter((x) => x.subject.startsWith("Reminder:")).length).toBe(0);
  rem = (await mailsFor(request, m2)).filter((x) => x.subject.startsWith("Reminder:"));
  expect(rem.length).toBe(2); expect(rem[0].subject).toContain("starts in 1 hour");
});

test("R15 a failing sender leaves the booking stored and shows the error", async ({ page, request }) => {
  const free = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-20"));
  const r = await book(request, "alex", "intro", free[0], { name: "Fay Fail", email: "fail@example.com" });
  expect(r.status()).toBe(201);
  const uid = (await r.json()).uid;
  expect((await (await request.get(`/api/public/bookings/${uid}`)).json()).status).toBe("accepted");
  await login(page);
  await expect.poll(async () => (await (await page.request.get("/api/integrations")).json()).email.lastError).toBe("Test sender refused this address");
  await page.goto("/settings/integrations");
  await expect(page.getByText("Last error: Test sender refused this address")).toBeVisible();
});

test("R17 secret iCal address blocks busy times, syncs by cron and is never shown again", async ({ page, request }) => {
  const FEED = "http://127.0.0.1:3221/api/test/feed.ics";
  const before = flat(await slots(request, "alex", "intro", "UTC", "2026-11-23T00:00:00.000Z", "2026-12-10T00:00:00.000Z"));
  expect(before).toContain("2026-11-24T15:00:00.000Z"); expect(before).toContain("2026-12-01T15:00:00.000Z");
  await login(page);
  await page.goto("/settings/calendars");
  await expect(page.getByText("open 'Integrate calendar', and copy 'Secret address in iCal format'")).toBeVisible();
  // a dead address is refused in plain words
  await page.getByLabel("Secret iCal address").fill(FEED + "?status=404");
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText("The address returned 404. It may have been reset in Google Calendar.")).toBeVisible();
  await page.getByLabel("Secret iCal address").fill(FEED);
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByText(/Last synced/)).toBeVisible();
  await expect(page.getByText("2 busy times in the next 60 days")).toBeVisible();
  await expect(page.getByLabel("Secret iCal address")).toHaveCount(0);
  const after = flat(await slots(request, "alex", "intro", "UTC", "2026-11-23T00:00:00.000Z", "2026-12-10T00:00:00.000Z"));
  for (const t of ["15:00", "15:30", "16:00", "16:30"]) { expect(after).not.toContain(`2026-11-24T${t}:00.000Z`); expect(after).not.toContain(`2026-12-08T${t}:00.000Z`); }
  expect(after).toContain("2026-12-01T15:00:00.000Z"); // EXDATE
  expect(after).toContain("2026-11-24T14:30:00.000Z");
  // the booking guard refuses a busy time too
  expect((await book(request, "alex", "intro", "2026-11-24T15:30:00.000Z")).status()).toBe(409);
  // the cron re-syncs it
  const run = await (await cron(request, "2026-11-15T12:30:00.000Z")).json();
  expect(run.ical.polled).toBe(1); expect(run.ical.ok).toBe(1);
  // the saved address is in no API response
  for (const path of ["/api/integrations", "/api/me", "/api/event-types"]) expect(await (await page.request.get(path)).text()).not.toContain("/api/test/feed.ics");
  const st = await (await page.request.get("/api/integrations")).json();
  expect(st.ical.hint).toBe("127.0.0.1/…/feed.ics ending …pitest"); expect(st.ical.state).toBe("on");
  // remove it and the times come back
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByLabel("Secret iCal address")).toBeVisible();
  expect(flat(await slots(request, "alex", "intro", "UTC", "2026-11-23T00:00:00.000Z", "2026-12-10T00:00:00.000Z"))).toContain("2026-11-24T15:00:00.000Z");
});

test("R15 event reminders are editable on the Limits tab", async ({ page }) => {
  await login(page);
  await page.getByText("Intro call", { exact: true }).first().click();
  await page.getByRole("tab", { name: "Limits" }).or(page.getByRole("button", { name: "Limits", exact: true })).first().click();
  await expect(page.getByLabel("1 day before")).toBeChecked(); await expect(page.getByLabel("1 hour before")).toBeChecked();
  await page.getByLabel("15 minutes before").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get("/api/event-types")).json()).find((e: any) => e.slug === "intro").reminder_offsets).toBe("[1440,60,15]");
});

// R19: calendar replies arrive at the Worker's email() handler (wrangler dev's local email endpoint).
const ORG = "bookings@example.com";
const icsTime = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60000).toISOString();
/** A Google-style iTIP message (REPLY or COUNTER) from one attendee, as one text/calendar body. */
const itipMail = (from: string, uidAt: string, method: "REPLY" | "COUNTER", partstat: string, o: { seq?: number; start?: string; stamp?: string } = {}) => {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", `METHOD:${method}`, "BEGIN:VEVENT", `UID:${uidAt}`, `SEQUENCE:${o.seq ?? 0}`,
    `DTSTAMP:${o.stamp ?? "20261115T120000Z"}`, ...(o.start ? [`DTSTART:${icsTime(o.start)}`, `DTEND:${icsTime(plus(o.start, 30))}`] : []),
    `ORGANIZER;CN=Scheduler:mailto:${ORG}`, `ATTENDEE;PARTSTAT=${partstat};CN=Someone:mailto:${from}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  return [`From: <${from}>`, `To: <${ORG}>`, `Subject: ${method} ${partstat}`, "Message-ID: <" + Math.random().toString(16).slice(2) + "@example.com>", "MIME-Version: 1.0",
    `Content-Type: text/calendar; charset=UTF-8; method=${method}`, "", ics].join("\r\n");
};
const replyMail = (from: string, uidAt: string, partstat: string, seq = 0) => itipMail(from, uidAt, "REPLY", partstat, { seq });
const deliverMail = (r: APIRequestContext, from: string, raw: string) => r.post(`/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(ORG)}`, { data: raw, headers: { "content-type": "message/rfc822" } });
const status = async (r: APIRequestContext, uid: string) => (await (await r.get(`/api/public/bookings/${uid}`)).json());
const subjects = async (r: APIRequestContext, uid: string, prefix: string) => (await mailsFor(r, uid)).filter((m) => m.subject.startsWith(prefix));

test("R19 accepted is status only; a guest's decline cancels the booking and tells everyone", async ({ page, request }) => {
  const free = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-23"));
  const uid = (await (await book(request, "alex", "intro", free[0], { name: "Rae Reply", email: "rae@example.com" })).json()).uid;
  await expect.poll(async () => (await mailsFor(request, uid)).length).toBe(2);
  const UID = prop((await mailsFor(request, uid))[0].ics, "UID")!;
  expect((await deliverMail(request, "alex@example.com", replyMail("alex@example.com", UID, "ACCEPTED"))).ok()).toBe(true);
  await login(page);
  await page.goto("/bookings/upcoming");
  const row = page.locator(`[data-uid="${uid}"]`);
  await expect(row.getByRole("list", { name: "Replies" })).toContainText("You Accepted");
  expect((await mailsFor(request, uid)).length).toBe(2);
  // the guest declines in their calendar: cancelled, CANCEL to both (the guest's own copy too)
  expect((await deliverMail(request, "rae@example.com", replyMail("rae@example.com", UID, "DECLINED"))).ok()).toBe(true);
  await expect.poll(async () => (await subjects(request, uid, "Cancelled:")).map((m) => m.recipient).sort()).toEqual(["alex@example.com", "rae@example.com"]);
  for (const m of await subjects(request, uid, "Cancelled:")) {
    expect(prop(m.ics, "METHOD")).toBe("CANCEL"); expect(prop(m.ics, "SEQUENCE")).toBe("1"); expect(prop(m.ics, "STATUS")).toBe("CANCELLED"); expect(prop(m.ics, "UID")).toBe(UID);
  }
  expect((await subjects(request, uid, "Cancelled:")).find((m) => m.recipient === "alex@example.com").text).toContain("Rae Reply cancelled this meeting. Reason: Declined in their calendar");
  expect(await status(request, uid)).toMatchObject({ status: "cancelled", cancelled_by: "guest" });
  // the slot is free again, and nothing was sent back as a reply
  expect(flat(await slots(request, "alex", "intro"))).toContain(free[0]);
  await page.goto("/bookings/cancelled");
  await expect(page.locator(`[data-uid="${uid}"]`)).toBeVisible();
  expect((await mailsFor(request, uid)).every((m) => !/METHOD:REPLY/.test(m.ics))).toBe(true);
});

test("R19 a proposed new time: held, offered to the other party, accepted, refused when unavailable, declined", async ({ page, request }) => {
  const day = flat(await slots(request, "alex", "intro"));
  const t0 = day.filter((s) => s.startsWith("2026-11-25"))[0], t1 = day.filter((s) => s.startsWith("2026-11-26"))[2], t2 = day.filter((s) => s.startsWith("2026-11-26"))[6];
  const uid = (await (await book(request, "alex", "intro", t0, { name: "Cora Counter", email: "cora@example.com" })).json()).uid;
  await expect.poll(async () => (await mailsFor(request, uid)).length).toBe(2);
  const UID = prop((await mailsFor(request, uid))[0].ics, "UID")!;
  // the guest proposes t1: only the host is asked, at SEQUENCE 1, with an answer requested
  expect((await deliverMail(request, "cora@example.com", itipMail("cora@example.com", UID, "COUNTER", "NEEDS-ACTION", { start: t1 }))).ok()).toBe(true);
  await expect.poll(async () => (await subjects(request, uid, "New time proposed:")).map((m) => m.recipient)).toEqual(["alex@example.com"]);
  const ask = (await subjects(request, uid, "New time proposed:"))[0];
  expect(prop(ask.ics, "METHOD")).toBe("REQUEST"); expect(prop(ask.ics, "SEQUENCE")).toBe("1"); expect(prop(ask.ics, "DTSTART")).toBe(icsTime(t1));
  expect(ask.ics.replace(/\r\n[ \t]/g, "")).toContain("PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alex@example.com");
  expect(ask.text).toContain("Cora Counter proposed a new time");
  // both times are held until the host answers
  expect((await status(request, uid)).start_utc).toBe(t0);
  const now = flat(await slots(request, "alex", "intro"));
  expect(now).not.toContain(t0); expect(now).not.toContain(t1);
  await login(page);
  await page.goto("/bookings/upcoming");
  await expect(page.locator(`[data-uid="${uid}"]`).getByRole("status")).toContainText("Cora Counter proposed a new time");
  // the host accepts the proposal in their calendar: moved, final REQUEST to both at SEQUENCE 2, old time freed
  expect((await deliverMail(request, "alex@example.com", replyMail("alex@example.com", UID, "ACCEPTED", 1))).ok()).toBe(true);
  await expect.poll(async () => (await subjects(request, uid, "Moved:")).map((m) => m.recipient).sort()).toEqual(["alex@example.com", "cora@example.com"]);
  for (const m of await subjects(request, uid, "Moved:")) { expect(prop(m.ics, "SEQUENCE")).toBe("2"); expect(prop(m.ics, "DTSTART")).toBe(icsTime(t1)); }
  expect((await status(request, uid)).start_utc).toBe(t1);
  expect(flat(await slots(request, "alex", "intro"))).toContain(t0);
  await page.reload();
  await expect(page.locator(`[data-uid="${uid}"]`).getByRole("status")).toHaveCount(0);
  // a time outside working hours (Sunday) is refused with DECLINECOUNTER; nothing changes
  expect((await deliverMail(request, "cora@example.com", itipMail("cora@example.com", UID, "COUNTER", "NEEDS-ACTION", { seq: 2, start: "2026-11-22T15:00:00.000Z" }))).ok()).toBe(true);
  await expect.poll(async () => (await subjects(request, uid, "New time not available:")).map((m) => m.recipient)).toEqual(["cora@example.com"]);
  const no = (await subjects(request, uid, "New time not available:"))[0];
  expect(prop(no.ics, "METHOD")).toBe("DECLINECOUNTER"); expect(no.mime).toContain("method=DECLINECOUNTER"); expect(no.text).toContain("That time isn't available.");
  expect((await status(request, uid)).start_utc).toBe(t1);
  // the host proposes t2; the guest declines it: the meeting is cancelled for both
  expect((await deliverMail(request, "alex@example.com", itipMail("alex@example.com", UID, "COUNTER", "NEEDS-ACTION", { seq: 2, start: t2 }))).ok()).toBe(true);
  await expect.poll(async () => (await subjects(request, uid, "New time proposed:")).map((m) => m.recipient)).toEqual(["alex@example.com", "cora@example.com"]);
  expect((await deliverMail(request, "cora@example.com", replyMail("cora@example.com", UID, "DECLINED", 3))).ok()).toBe(true);
  await expect.poll(async () => (await subjects(request, uid, "Cancelled:")).map((m) => m.recipient).sort()).toEqual(["alex@example.com", "cora@example.com"]);
  for (const m of await subjects(request, uid, "Cancelled:")) { expect(prop(m.ics, "METHOD")).toBe("CANCEL"); expect(prop(m.ics, "SEQUENCE")).toBe("4"); }
  expect(await status(request, uid)).toMatchObject({ status: "cancelled", cancelled_by: "guest", cancel_reason: "Declined the proposed new time" });
  const after = flat(await slots(request, "alex", "intro"));
  expect(after).toContain(t1); expect(after).toContain(t2);
});

test("R19 mail from the organizer address itself is refused (loop guard)", async ({ request }) => {
  const r = await request.post(`/cdn-cgi/handler/email?from=${encodeURIComponent(ORG)}&to=${encodeURIComponent(ORG)}`, { data: replyMail(ORG, "x@127.0.0.1", "DECLINED"), headers: { "content-type": "message/rfc822" } });
  expect(r.ok()).toBe(false);
});
