import { describe, it, expect } from "vitest";
import { parseFrom, render, mask, offsetText, provider, emailProblem, type MailBooking } from "../src/worker/email";
import { hintFor, checkFeedUrl } from "../src/worker/calendars";

const b: MailBooking = { uid: "u1", title: "Intro call", start_utc: "2026-11-17T15:00:00.000Z", end_utc: "2026-11-17T15:30:00.000Z", location: "https://meet.example.com/a",
  notes: "<b>hi</b>", status: "accepted", booker_name: "Pat", booker_email: "pat@example.com", booker_tz: "Europe/Berlin", guests: [], host_name: "Alex", host_email: "alex@example.com", host_tz: "America/New_York" };
describe("R15 email", () => {
  it("subjects and times are in the recipient's zone", () => {
    expect(render("confirmed", b, "guest", "https://x.test").subject).toBe("Confirmed: Intro call with Alex on Tue, Nov 17, 4:00pm");
    expect(render("confirmed", b, "host", "https://x.test").subject).toBe("Confirmed: Intro call with Pat on Tue, Nov 17, 10:00am");
    expect(render("moved", b, "guest", "https://x.test").subject).toMatch(/^Moved: /);
    expect(render("cancelled", { ...b, cancelled_by: "guest", cancel_reason: "Sick" }, "host", "https://x.test").text).toContain("Pat cancelled this meeting. Reason: Sick");
    expect(render("reminder", b, "guest", "https://x.test", 60).subject).toBe("Reminder: Intro call with Alex starts in 1 hour");
  });
  it("links to the booking page and escapes HTML", () => {
    const r = render("confirmed", b, "guest", "https://x.test");
    expect(r.text).toContain("Reschedule: https://x.test/booking/u1"); expect(r.text).toContain("Cancel: https://x.test/booking/u1");
    expect(r.text).toContain("(Europe/Berlin)");
    expect(r.html).toContain("&lt;b&gt;hi&lt;/b&gt;"); expect(r.html).not.toContain("<b>hi</b>");
    expect(render("cancelled", b, "guest", "https://x.test").text).not.toContain("Reschedule:");
  });
  it("is off unless configured, and says what's missing", () => {
    expect(provider({})).toBe(""); expect(provider({ EMAIL_PROVIDER: "test" })).toBe(""); expect(provider({ EMAIL_PROVIDER: "test", TEST_CLOCK: "1" })).toBe("test");
    expect(emailProblem({ EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "a@b.co" })).toMatch(/send_email binding/);
    expect(emailProblem({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "a@b.co" })).toMatch(/RESEND_API_KEY/);
    expect(emailProblem({ EMAIL_PROVIDER: "cloudflare" })).toMatch(/EMAIL_FROM/);
    expect(mask("pat@example.com")).toBe("p***@example.com"); expect(offsetText(10080)).toBe("1 week"); expect(offsetText(15)).toBe("15 minutes");
  });
  it("splits a display-name From for the Email Sending binding", () => {
    expect(parseFrom('"Scheduler" <bookings@calendar.example.com>')).toEqual({ email: "bookings@calendar.example.com", name: "Scheduler" });
    expect(parseFrom("bookings@x.com")).toBe("bookings@x.com"); expect(parseFrom("<b@x.com>")).toBe("b@x.com");
  });
  it("shows only a hint of a feed address and accepts only https", () => {
    const h = hintFor("https://calendar.google.com/calendar/ical/x%40gmail.com/private-0123456789abcdef/basic.ics");
    expect(h).toBe("calendar.google.com/…/basic.ics ending …abcdef"); expect(h).not.toContain("0123456789");
    expect(checkFeedUrl({}, "http://example.com/a.ics")).toBeNull();
    expect(checkFeedUrl({}, "webcal://example.com/a.ics")).toBe("https://example.com/a.ics");
    expect(checkFeedUrl({ TEST_CLOCK: "1" }, "http://127.0.0.1:1/feed.ics")).toBe("http://127.0.0.1:1/feed.ics");
  });
});
