import { test, expect } from "@playwright/test";
import { login, slots, flat, book } from "./helpers";

// 0.1.1 regressions: guidance copy on every public step, guest and host rescheduling, cancel copy.
test.describe.configure({ mode: "serial" });

test("R14 profile page tells visitors to choose a meeting type", async ({ page }) => {
  await page.goto("/alex");
  await expect(page.getByRole("heading", { name: "Choose a meeting type", exact: true })).toBeVisible();
  await expect(page.getByText("Pick the kind of meeting you'd like with Alex. Next you'll choose a date and time.")).toBeVisible();
  const intro = page.getByRole("link", { name: "Intro call, 30 minutes. Choose a time", exact: true });
  await expect(intro).toContainText("A short first call to see how we can work together.");
  await expect(intro).toContainText("30 min");
  await expect(intro).toContainText("Video call");
  await expect(intro).toContainText("Choose a time");
  // the footer no longer sends guests to the host sign-in page
  await expect(page.locator(".booker-foot a")).toHaveCount(0);
});

test("R14 booking page says pick a date, then a time, then enter details", async ({ page }) => {
  await page.goto("/alex/intro");
  await expect(page.getByRole("heading", { name: "Select a date", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Select a time", exact: true })).toBeVisible();
  await page.locator(".time-btn").first().click();
  await expect(page.getByRole("heading", { name: "Enter your details", exact: true })).toBeVisible();
  await page.goto("/alex/deep-dive");
  await page.locator(".time-btn").first().click();
  await expect(page.getByText("Alex Rivera confirms requests for this meeting.")).toBeVisible();
});

test("R10 guest reschedule from the confirmation page opens on the booking's own day and moves it", async ({ page, request }) => {
  const free = flat(await slots(request, "alex", "intro"));
  const day = free.filter((s) => s.startsWith("2026-11-19"));
  const r = await book(request, "alex", "intro", day[0], { name: "Rae Reschedule", email: "rae@example.com" });
  expect(r.status()).toBe(201);
  const uid = (await r.json()).uid;
  await page.goto(`/booking/${uid}`);
  await expect(page.getByRole("heading", { name: "You're booked", exact: true })).toBeVisible();
  await expect(page.getByText("Your meeting with Alex Rivera is confirmed.")).toBeVisible();
  await expect(page.getByText("What's next")).toBeVisible();
  await expect(page.getByText("No confirmation email is sent, so keep this page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link to this page", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add to calendar", exact: true })).toHaveAttribute("href", `/api/public/bookings/${uid}/ics`);
  await expect(page.getByRole("link", { name: "https://meet.example.com/alex", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Reschedule", exact: true }).click();
  await expect(page.getByText("Rescheduling your booking")).toBeVisible();
  await expect(page.getByText("Pick a new date and time. The current time stays booked until you confirm the new one.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Select a new date", exact: true })).toBeVisible();
  // opens on the day of the booking (Thu 19th), not the first free day (Mon 16th)
  await expect(page).toHaveURL(/date=2026-11-19/);
  await page.locator(".time-btn").nth(2).click();
  await expect(page.getByRole("heading", { name: "Confirm your new time", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your name *", { exact: true })).toHaveValue("Rae Reschedule");
  await page.getByLabel("Reason for change", { exact: true }).fill("Clash");
  await page.getByRole("button", { name: "Move booking", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Booking moved", exact: true })).toBeVisible();
  await expect(page.getByText("Your meeting with Alex Rivera is now at the time below. The old time is cancelled.")).toBeVisible();
  const newUid = page.url().split("/").pop()!;
  expect(newUid).not.toBe(uid);
  const nb = await (await request.get(`/api/public/bookings/${newUid}`)).json();
  expect(nb.from_uid).toBe(uid); expect(nb.status).toBe("accepted"); expect(nb.start_utc).toBe(day[2]);
  const ob = await (await request.get(`/api/public/bookings/${uid}`)).json();
  expect(ob.status).toBe("cancelled"); expect(ob.rescheduled).toBe(1); expect(ob.cancelled_by).toBe("guest"); expect(ob.cancel_reason).toBe("Clash");
  // the old time is free again, the new one is taken
  const after = flat(await slots(request, "alex", "intro"));
  expect(after).toContain(day[0]); expect(after).not.toContain(day[2]);
  await page.goto(`/booking/${uid}`);
  await expect(page.getByRole("heading", { name: "This booking was moved", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "See the new time", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/booking/${newUid}$`));
});

test("R11 host reschedules from the bookings list without filling in the guest's details", async ({ page, request }) => {
  const free = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-20"));
  const r = await book(request, "alex", "intro", free[0], { name: "Hana Hostmove", email: "hana@example.com", notes: "keep me" });
  const uid = (await r.json()).uid;
  await login(page);
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  const row = page.locator(".booking-row").filter({ hasText: "Hana Hostmove" });
  await row.getByRole("link", { name: "Reschedule", exact: true }).click();
  await expect(page).toHaveURL(/reschedule=.*host=1/);
  await expect(page.getByText("Moving Hana Hostmove's booking")).toBeVisible();
  await expect(page).toHaveURL(/date=2026-11-20/);
  await page.locator(".time-btn").nth(3).click();
  await expect(page.getByRole("heading", { name: "Confirm the new time", exact: true })).toBeVisible();
  await expect(page.getByLabel("Your name *", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Move booking", exact: true }).click();
  await expect(page).toHaveURL(/\/bookings\/upcoming$/);
  await expect(page.locator(".booking-row").filter({ hasText: "Hana Hostmove" })).toHaveCount(1);
  const ob = await (await request.get(`/api/public/bookings/${uid}`)).json();
  expect(ob.status).toBe("cancelled"); expect(ob.cancelled_by).toBe("host"); expect(ob.movedToUid).toBeTruthy();
  const nb = await (await request.get(`/api/public/bookings/${ob.movedToUid}`)).json();
  expect(nb.booker_name).toBe("Hana Hostmove"); expect(nb.booker_email).toBe("hana@example.com"); expect(nb.notes).toBe("keep me");
  expect(nb.start_utc).toBe(free[3]); expect(nb.status).toBe("accepted");
  // the guest's old page says the host moved it
  await page.goto(`/booking/${uid}`);
  await expect(page.getByText("Alex Rivera moved this meeting to a new time.")).toBeVisible();
});

test("R11 host can reschedule a pending request; host moves need a host session", async ({ page, request, playwright, baseURL }) => {
  const dd = flat(await slots(request, "alex", "deep-dive"));
  const uid = (await (await book(request, "alex", "deep-dive", dd[1], { name: "Pia Pending", email: "pia@example.com" })).json()).uid;
  const anon = await playwright.request.newContext({ baseURL });
  const denied = await anon.post("/api/public/bookings", { data: { username: "alex", slug: "deep-dive", start: dd[2], reschedule: uid, asHost: true } });
  expect(denied.status()).toBe(401);
  await login(page);
  await page.goto("/bookings/unconfirmed");
  const row = page.locator(".booking-row").filter({ hasText: "Pia Pending" });
  await expect(row.getByRole("link", { name: "Reschedule", exact: true })).toBeVisible();
  const moved = await page.request.post("/api/public/bookings", { data: { username: "alex", slug: "deep-dive", start: dd[2], reschedule: uid, asHost: true } });
  expect(moved.status()).toBe(201);
  const nb = await (await request.get(`/api/public/bookings/${(await moved.json()).uid}`)).json();
  expect(nb.status).toBe("accepted"); expect(nb.booker_name).toBe("Pia Pending");
});

test("R10 guest cancel explains what happens and what to do next", async ({ page, request }) => {
  const free = flat(await slots(request, "alex", "intro")).filter((s) => s.startsWith("2026-11-23"));
  const uid = (await (await book(request, "alex", "intro", free[0], { name: "Cal Cancel", email: "cal@example.com" })).json()).uid;
  await page.goto(`/booking/${uid}`);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Alex Rivera will see it's cancelled and the time opens up again. This can't be undone.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel booking", exact: true }).click();
  await expect(page.getByRole("heading", { name: "This booking was cancelled", exact: true })).toBeVisible();
  await expect(page.getByText("It's cancelled, and Alex Rivera can see that in their bookings.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Book another time", exact: true })).toBeVisible();
  await expect(page.getByText("What's next")).toHaveCount(0);
});

test("R4 R14 video meetings without a link: owner is prompted, guests are told the host will share it", async ({ page, request }) => {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Nia Newhost");
  await page.getByLabel("Email", { exact: true }).fill("nia@example.com");
  await page.getByLabel("Username", { exact: true }).fill("nia");
  await page.getByLabel("Password", { exact: true }).fill("password-123");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/event-types$/);
  await expect(page.locator(".et-row").filter({ hasText: "Quick chat" }).getByText("Add a meeting link")).toBeVisible();
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  await expect(page.getByText("Share your booking page so people can pick a time.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open your booking page", exact: true })).toHaveAttribute("href", "/nia");
  const s = flat(await slots(request, "nia", "quick-chat"));
  const uid = (await (await book(request, "nia", "quick-chat", s[0])).json()).uid;
  await page.goto(`/booking/${uid}`);
  await expect(page.getByText("(Nia Newhost will share the link)")).toBeVisible();
});

test("R14 a profile with nothing to book says so", async ({ page }) => {
  await login(page, "nia@example.com", "password-123");
  for (const name of ["Quick chat", "Meeting"]) await page.getByRole("switch", { name: `Hide ${name}` }).click();
  await expect(page.locator(".badge", { hasText: "Hidden" })).toHaveCount(2);
  await page.goto("/nia");
  await expect(page.getByText("Nothing to book right now")).toBeVisible();
  await expect(page.getByText("Nia has no meeting types open for booking. Check back later.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a meeting type" })).toHaveCount(0);
});
