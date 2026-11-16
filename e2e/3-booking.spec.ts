import { test, expect } from "@playwright/test";
import { slots, flat, book } from "./helpers";

test.describe.configure({ mode: "serial" });
let firstUid = "";

test("R6 profile lists visible event types", async ({ page }) => {
  await page.goto("/alex");
  await expect(page.getByRole("heading", { name: "Alex Rivera", exact: true })).toBeVisible();
  await expect(page.locator(".profile-list strong")).toHaveText(["Intro call", "Deep dive"]);
  await page.getByRole("link", { name: /Deep dive/ }).click();
  await expect(page).toHaveURL(/\/alex\/deep-dive/);
  await expect(page.getByText("Needs approval")).toBeVisible();
  await page.goto("/nobody-at-all");
  await expect(page.getByText("Nobody here by that name")).toBeVisible();
  const r = await page.request.get("/api/public/users/nobody-at-all");
  expect(r.status()).toBe(404);
});

test.describe("visitor in Kolkata", () => {
  test.use({ timezoneId: "Asia/Kolkata" });
  test("R7 R10 book, reschedule and cancel from another time zone", async ({ page, request }) => {
    await page.goto("/alex/intro");
    await expect(page.getByRole("button", { name: /Your time zone: Asia\/(Kolkata|Calcutta)/ })).toBeVisible();
    await expect(page).toHaveURL(/month=2026-11&date=2026-11-16/);
    await expect(page.getByRole("button", { name: "Monday, November 16, 2026", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Previous month", exact: true })).toBeDisabled();
    await expect(page.locator(".time-btn").first()).toHaveText("7:30pm");
    await page.getByRole("button", { name: "24h", exact: true }).click();
    await expect(page.locator(".time-btn").first()).toHaveText("19:30");
    await page.getByRole("button", { name: "12h", exact: true }).click();
    await page.getByRole("button", { name: "7:30pm, Monday, November 16, 2026", exact: true }).click();
    await expect(page).toHaveURL(/slot=2026-11-16T14%3A00%3A00.000Z|slot=2026-11-16T14:00:00.000Z/);
    await page.reload();
    await expect(page.getByText("7:30pm - 8:00pm")).toBeVisible();
    await page.getByLabel("Your name *", { exact: true }).fill("Priya Visitor");
    await page.getByLabel("Email *", { exact: true }).fill("not-an-email");
    await page.getByRole("button", { name: "Book it", exact: true }).click();
    await expect(page.getByText("Enter a valid email")).toBeVisible();
    await page.getByLabel("Email *", { exact: true }).fill("priya@example.com");
    await page.getByLabel("Anything we should know?", { exact: true }).fill("Let's talk about the launch.");
    await page.getByRole("button", { name: "+ Add guests", exact: true }).click();
    await page.getByLabel("Guest email 1", { exact: true }).fill("ravi@example.com");
    await page.getByRole("button", { name: "Book it", exact: true }).click();
    await expect(page).toHaveURL(/\/booking\/[A-Za-z0-9_-]{22}$/);
    await expect(page.getByRole("heading", { name: "You're booked", exact: true })).toBeVisible();
    await expect(page.getByText("7:30pm - 8:00pm")).toBeVisible();
    await expect(page.getByText("ravi@example.com")).toBeVisible();
    firstUid = page.url().split("/").pop()!;
    const b = await (await request.get(`/api/public/bookings/${firstUid}`)).json();
    expect(b.start_utc).toBe("2026-11-16T14:00:00.000Z");
    expect(b.booker_tz).toMatch(/Asia\/(Kolkata|Calcutta)/);
    const ics = await request.get(`/api/public/bookings/${firstUid}/ics`);
    expect(await ics.text()).toContain("DTSTART:20261116T140000Z");
    expect(flat(await slots(request, "alex", "intro"))).not.toContain("2026-11-16T14:00:00.000Z");

    // reschedule
    await page.getByRole("link", { name: "Reschedule", exact: true }).click();
    await expect(page).toHaveURL(/reschedule=/);
    await expect(page.locator(".was s")).toContainText("7:30pm - 8:00pm");
    // own slot is free while moving
    await expect(page.getByRole("button", { name: "7:30pm, Monday, November 16, 2026", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Tuesday, November 17, 2026", exact: true }).click();
    await page.getByRole("button", { name: "8:00pm, Tuesday, November 17, 2026", exact: true }).click();
    await expect(page.getByLabel("Your name *", { exact: true })).toHaveValue("Priya Visitor");
    await page.getByLabel("Reason for change", { exact: true }).fill("Clash came up");
    await page.getByRole("button", { name: "Move booking", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Booking moved", exact: true })).toBeVisible();
    const newUid = page.url().split("/").pop()!;
    const nb = await (await request.get(`/api/public/bookings/${newUid}`)).json();
    expect(nb.start_utc).toBe("2026-11-17T14:30:00.000Z");
    expect(nb.from_uid).toBe(firstUid);
    const ob = await (await request.get(`/api/public/bookings/${firstUid}`)).json();
    expect(ob.status).toBe("cancelled"); expect(ob.rescheduled).toBe(1);
    const free = flat(await slots(request, "alex", "intro"));
    expect(free).toContain("2026-11-16T14:00:00.000Z");
    expect(free).not.toContain("2026-11-17T14:30:00.000Z");

    // cancel
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByLabel("Reason (optional)", { exact: true }).fill("No longer needed");
    await page.getByRole("button", { name: "Cancel booking", exact: true }).click();
    await expect(page.getByRole("heading", { name: "This booking was cancelled", exact: true })).toBeVisible();
    await expect(page.getByText("No longer needed")).toBeVisible();
    await expect(page.getByRole("link", { name: "Book another time", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Reschedule", exact: true })).toHaveCount(0);
    expect(flat(await slots(request, "alex", "intro"))).toContain("2026-11-17T14:30:00.000Z");
    // cancelled booking cannot be moved
    await page.goto(`/alex/intro?reschedule=${newUid}`);
    await expect(page.getByText("This booking was cancelled, so it can't be moved.")).toBeVisible();
  });

  test("R13 keyboard-only booking", async ({ page }) => {
    await page.goto("/alex/intro?month=2026-11&date=2026-11-18");
    await page.getByRole("button", { name: /Your time zone/ }).focus();
    let found = false;
    for (let i = 0; i < 80 && !found; i++) {
      await page.keyboard.press("Tab");
      found = await page.evaluate(() => document.activeElement?.classList.contains("time-btn") ?? false);
    }
    expect(found).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Your name *", { exact: true })).toBeVisible();
    await page.keyboard.press("Tab"); // may land on name already focused or next
    await page.getByLabel("Your name *", { exact: true }).focus();
    await page.keyboard.type("Kim Keys");
    await page.keyboard.press("Tab");
    await page.keyboard.type("kim@example.com");
    await page.getByRole("button", { name: "Book it", exact: true }).focus();
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(ring).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "You're booked", exact: true })).toBeVisible();
  });
});

test("R9 double booking and bad starts", async ({ request }) => {
  const s = flat(await slots(request, "alex", "intro"));
  const start = s[5];
  const [a, b] = await Promise.all([book(request, "alex", "intro", start, { email: "a@example.com" }), book(request, "alex", "intro", start, { email: "b@example.com" })]);
  expect([a.status(), b.status()].sort()).toEqual([201, 409]);
  expect((await book(request, "alex", "intro", "2026-11-16T14:07:00.000Z")).status()).toBe(409);
  expect((await book(request, "alex", "intro", "2026-11-16T03:00:00.000Z")).status()).toBe(409);
  expect((await book(request, "alex", "intro", "2026-11-10T14:00:00.000Z")).status()).toBe(409);
  const bad = await book(request, "alex", "intro", s[6], { name: "" });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).fields.name).toBeTruthy();
});

test("R9 concurrent overlapping requests across event types: exactly one wins", async ({ request }) => {
  const dd = flat(await slots(request, "alex", "deep-dive"));
  const intro = new Set(flat(await slots(request, "alex", "intro")));
  const t = dd.find((x) => intro.has(x) && x > "2026-11-20T00:00:00.000Z")!; // Friday or later, away from other tests
  const half = new Date(Date.parse(t) + 30 * 60000).toISOString(); // inside the 60-minute deep dive
  const reqs = [
    ...[0, 1, 2].map((i) => book(request, "alex", "intro", t, { email: `r${i}@example.com` })),
    ...[3, 4].map((i) => book(request, "alex", "intro", half, { email: `r${i}@example.com` })),
    ...[5, 6, 7].map((i) => book(request, "alex", "deep-dive", t, { email: `r${i}@example.com` })),
  ];
  const codes = (await Promise.all(reqs)).map((r) => r.status());
  // at most one booking at t, at most one at t+30; a deep dive at t blocks both intros
  const ok = codes.filter((c) => c === 201).length;
  expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
  expect(ok === 1 || ok === 2).toBe(true);
  if (codes.slice(5).includes(201)) expect(ok).toBe(1);
  expect(codes.slice(0, 3).filter((c) => c === 201).length).toBeLessThanOrEqual(1);
  expect(codes.slice(3, 5).filter((c) => c === 201).length).toBeLessThanOrEqual(1);
});

test("R10 reschedule onto the same start is allowed and moves the booking", async ({ request }) => {
  const t = "2026-11-24T15:00:00.000Z"; // Tue 10:00am New York
  expect(flat(await slots(request, "alex", "intro"))).toContain(t);
  const r = await book(request, "alex", "intro", t, { email: "same@example.com" });
  expect(r.status()).toBe(201);
  const { uid } = await r.json();
  expect(flat(await slots(request, "alex", "intro", "UTC", undefined, undefined, uid))).toContain(t);
  const m = await book(request, "alex", "intro", t, { email: "same@example.com", reschedule: uid });
  expect(m.status()).toBe(201);
  const moved = await (await request.get(`/api/public/bookings/${uid}`)).json();
  expect(moved.status).toBe("cancelled");
  expect(moved.rescheduled).toBe(1);
  const fresh = await (await request.get(`/api/public/bookings/${(await m.json()).uid}`)).json();
  expect(fresh.from_uid).toBe(uid);
  expect(flat(await slots(request, "alex", "intro"))).not.toContain(t);
  // the old booking can't be moved again
  expect((await book(request, "alex", "intro", "2026-11-24T16:00:00.000Z", { reschedule: uid })).status()).toBe(409);
});
