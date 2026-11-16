import { test, expect } from "@playwright/test";
import { login, slots, flat, book } from "./helpers";

test.describe.configure({ mode: "serial" });

test("R11 bookings list: upcoming, approve, decline, cancel, past", async ({ page, request, browser, baseURL }) => {
  const intro = flat(await slots(request, "alex", "intro"));
  const t = intro.find((x) => x === "2026-11-19T14:00:00.000Z")!; // Thu 9:00am NY
  expect((await book(request, "alex", "intro", t, { name: "Uma Upcoming", email: "uma@example.com", notes: "Agenda attached" })).status()).toBe(201);
  const dd = flat(await slots(request, "alex", "deep-dive"));
  const r1 = await book(request, "alex", "deep-dive", dd[0], { name: "Ada Approve", email: "ada@example.com" });
  const r2 = await book(request, "alex", "deep-dive", dd.at(-1)!, { name: "Dan Decline", email: "dan@example.com" });
  expect(r1.status()).toBe(201); expect(r2.status()).toBe(201);
  // pending holds its slot
  expect(flat(await slots(request, "alex", "deep-dive"))).not.toContain(dd[0]);
  await login(page);
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  const row = page.locator(".booking-row").filter({ hasText: "Intro call with Uma Upcoming" });
  await expect(row).toContainText("9:00am - 9:30am");
  await expect(row).toContainText("uma@example.com");
  await expect(page.locator(".day-head").filter({ hasText: "Thu, Nov 19" })).toBeVisible();
  await page.getByRole("link", { name: /Unconfirmed/ }).click();
  await expect(page.locator(".booking-row")).toHaveCount(2);
  await page.locator(".booking-row").filter({ hasText: "Ada Approve" }).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.locator(".booking-row").filter({ hasText: "Ada Approve" })).toHaveCount(0);
  await page.locator(".booking-row").filter({ hasText: "Dan Decline" }).getByRole("button", { name: "Decline", exact: true }).click();
  await page.getByLabel("Reason (optional)", { exact: true }).fill("Fully booked that week");
  await page.getByRole("dialog").getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByText("Nothing waiting for you")).toBeVisible();
  await page.getByRole("link", { name: /Upcoming/ }).click();
  await expect(page.locator(".booking-row").filter({ hasText: "Deep dive with Ada Approve" })).toBeVisible();
  await page.locator(".booking-row").filter({ hasText: "Uma Upcoming" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel booking", exact: true }).click();
  await page.getByRole("link", { name: /Cancelled/ }).click();
  await expect(page.locator(".booking-row").filter({ hasText: "Uma Upcoming" })).toContainText("Cancelled by host");
  await expect(page.locator(".booking-row").filter({ hasText: "Dan Decline" })).toContainText("Declined");
  await expect(page.locator(".booking-row").filter({ hasText: "Priya Visitor" }).first()).toBeVisible();
  // host reschedule link opens booker in reschedule mode
  await page.getByRole("link", { name: /Upcoming/ }).click();
  const href = await page.locator(".booking-row").filter({ hasText: "Ada Approve" }).getByRole("link", { name: "Reschedule", exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/alex\/deep-dive\?reschedule=/);

  // past: same server and D1, clock a month later via the test-only test_now cookie (TEST_CLOCK=1)
  const ctx = await browser.newContext({ baseURL, timezoneId: "America/New_York" });
  await ctx.addCookies([{ name: "test_now", value: "2026-12-20T12:00:00.000Z", url: baseURL! }]);
  try {
    const p2 = await ctx.newPage();
    await p2.goto("/login");
    await p2.getByLabel("Email", { exact: true }).fill("alex@example.com");
    await p2.getByLabel("Password", { exact: true }).fill("demo-pass-123");
    await p2.getByRole("button", { name: "Sign in", exact: true }).click();
    await p2.goto("/bookings/past");
    await expect(p2.locator(".booking-row").filter({ hasText: "Ada Approve" })).toBeVisible();
    await expect(p2.locator(".booking-row").filter({ hasText: "Ada Approve" }).getByRole("button")).toHaveCount(0);
  } finally { await ctx.close(); }
});

test("R12 settings drive week start and time format", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Alex Rivera");
  await page.getByRole("link", { name: "General", exact: true }).click();
  await page.getByLabel("Week starts on", { exact: true }).selectOption("sunday");
  await page.getByLabel("Time format", { exact: true }).selectOption("24");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.goto("/bookings/upcoming");
  await expect(page.locator(".booking-row").filter({ hasText: "Ada Approve" }).locator(".b-time")).toHaveText(/^\d{2}:\d{2} - \d{2}:\d{2}$/);
  await page.goto("/availability");
  await page.getByRole("link", { name: /Working hours/ }).click();
  await expect(page.locator(".day-name").first()).toHaveText("Sunday");
  const p2 = await page.context().newPage();
  await p2.goto("/alex/intro");
  await expect(p2.locator(".cal-grid .wd").first()).toHaveText("SUN");
  await expect(p2.locator(".time-btn").first()).toHaveText(/^\d{2}:\d{2}$/);
  await page.goto("/settings/profile");
  await page.getByLabel("Username", { exact: true }).fill("alex-r");
  await expect(page.getByText("Your public links will change")).toBeVisible();
});
