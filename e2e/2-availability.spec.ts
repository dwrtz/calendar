import { test, expect } from "@playwright/test";
import { login, slots } from "./helpers";

test("R5 schedule editing, copy, overrides, and the booking page follows", async ({ page, request }) => {
  await login(page, "sam@example.com", "password-123");
  await page.getByRole("link", { name: "Availability", exact: true }).click();
  await page.getByRole("link", { name: /Working hours/ }).click();
  await page.getByRole("switch", { name: "Wednesday", exact: true }).click();
  await expect(page.locator(".day-row").filter({ hasText: "Wednesday" }).getByText("Unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Add range to Monday", exact: true }).click();
  await expect(page.getByLabel("Monday start 2", { exact: true })).toHaveValue(String(18 * 60));
  await page.getByLabel("Monday start 2", { exact: true }).selectOption(String(17 * 60 + 30));
  await page.getByLabel("Monday end 2", { exact: true }).selectOption(String(19 * 60));
  // overlap is flagged
  await page.getByLabel("Monday start 2", { exact: true }).selectOption(String(16 * 60));
  await expect(page.locator(".day-row").filter({ hasText: "Monday" }).getByRole("alert")).toHaveText("Times overlap");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByLabel("Monday start 2", { exact: true }).selectOption(String(17 * 60 + 30));
  await page.getByRole("button", { name: "Copy Monday times", exact: true }).click();
  await page.getByRole("dialog", { name: "Copy times to", exact: true }).getByLabel("Tuesday", { exact: true }).check();
  await page.getByRole("dialog", { name: "Copy times to", exact: true }).getByLabel("Thursday", { exact: true }).check();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByLabel("Thursday start 2", { exact: true })).toHaveValue(String(17 * 60 + 30));
  // overrides: Fri Nov 20 custom 10-11; Mon Nov 23 unavailable
  await page.getByRole("button", { name: "Add an override", exact: true }).click();
  let dlg = page.getByRole("dialog", { name: "Add an override", exact: true });
  await dlg.getByRole("button", { name: "Friday, November 20, 2026", exact: true }).click();
  await dlg.getByLabel("Override start 1", { exact: true }).selectOption("600");
  await dlg.getByLabel("Override end 1", { exact: true }).selectOption("660");
  await dlg.getByRole("button", { name: "Add override", exact: true }).click();
  await page.getByRole("button", { name: "Add an override", exact: true }).click();
  dlg = page.getByRole("dialog", { name: "Add an override", exact: true });
  await dlg.getByRole("button", { name: "Monday, November 23, 2026", exact: true }).click();
  await dlg.getByRole("switch", { name: "Mark unavailable (all day)", exact: true }).click();
  await dlg.getByRole("button", { name: "Add override", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Tuesday start 2", { exact: true })).toHaveValue(String(17 * 60 + 30));
  await expect(page.getByRole("switch", { name: "Wednesday", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Fri, Nov 20, 2026")).toBeVisible();
  await expect(page.locator(".ov-list li").filter({ hasText: "Mon, Nov 23, 2026" })).toContainText("Unavailable");
  // booking page follows (meeting = 30 min, 2h notice, NOW Sun 07:00 NY)
  const s = await slots(request, "sam", "meeting", "America/New_York");
  expect(s["2026-11-16"].length).toBe(16 + 3); // 9-17 plus 17:30-19:00
  expect(s["2026-11-16"].at(-1)).toBe("2026-11-16T23:30:00.000Z");
  expect(s["2026-11-18"]).toBeUndefined(); // Wednesday off
  expect(s["2026-11-19"].length).toBe(19);
  expect(s["2026-11-20"]).toEqual(["2026-11-20T15:00:00.000Z", "2026-11-20T15:30:00.000Z"]);
  expect(s["2026-11-23"]).toBeUndefined();
  await page.goto("/sam/meeting?month=2026-11&date=2026-11-20");
  await expect(page.locator(".time-btn")).toHaveText(["10:00am", "10:30am"]);
  await expect(page.getByRole("button", { name: "Wednesday, November 18, 2026", exact: true })).toBeDisabled();
});
