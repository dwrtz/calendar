import { expect, type Page, type APIRequestContext } from "@playwright/test";
export async function login(page: Page, email = "alex@example.com", password = "demo-pass-123") {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/event-types$/);
}
export async function slots(request: APIRequestContext, username: string, slug: string, tz = "UTC", start = "2026-11-15T00:00:00.000Z", end = "2026-11-30T00:00:00.000Z", reschedule?: string) {
  const r = await request.get(`/api/public/slots?username=${username}&slug=${slug}&start=${start}&end=${end}&tz=${tz}${reschedule ? `&reschedule=${reschedule}` : ""}`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()).slots as Record<string, string[]>;
}
export const flat = (s: Record<string, string[]>) => Object.values(s).flat();
export async function book(request: APIRequestContext, username: string, slug: string, start: string, extra: Record<string, any> = {}) {
  return request.post("/api/public/bookings", { data: { username, slug, start, name: "Pat Guest", email: "pat@example.com", timeZone: "Europe/Berlin", ...extra } });
}
