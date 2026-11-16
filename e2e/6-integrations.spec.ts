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
  // cancel it
  await request.post(`/api/public/bookings/${uid2}/cancel`, { data: { reason: "Clash" } });
  await expect.poll(async () => (await mailsFor(request, uid2)).length).toBe(4);
  const c = (await mailsFor(request, uid2)).filter((x) => x.subject.startsWith("Cancelled:"));
  expect(c.length).toBe(2);
  const cg = c.find((x) => x.recipient === "pat@example.com");
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
