import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { expandBusy, resolveZone, parseDuration } from "../src/shared/ical-parse";
import { computeSlots } from "../src/shared/slots";

const fixture = readFileSync(new URL("./fixtures/busy.ics", import.meta.url), "utf8");
const iso = (r: { start_ms: number; end_ms: number }) => `${new Date(r.start_ms).toISOString()} ${new Date(r.end_ms).toISOString()}`;

describe("R17 iCal busy times", () => {
  it("expands the fixture to exactly the expected busy ranges", () => {
    const got = expandBusy(fixture, "America/New_York", Date.parse("2026-10-19T00:00:00Z"), Date.parse("2026-11-30T00:00:00Z")).map(iso);
    expect(got).toEqual([
      // DAILY every 2 days at 17:00 London (BST) until 25 Oct
      "2026-10-20T16:00:00.000Z 2026-10-20T16:30:00.000Z",
      "2026-10-22T16:00:00.000Z 2026-10-22T16:30:00.000Z",
      "2026-10-24T16:00:00.000Z 2026-10-24T16:30:00.000Z",
      // weekly Mondays 9:00 New York: EDT before 1 Nov, EST after (DST change)
      "2026-10-26T13:00:00.000Z 2026-10-26T14:00:00.000Z",
      // MONTHLY last Friday (UTC)
      "2026-10-30T12:00:00.000Z 2026-10-30T12:30:00.000Z",
      "2026-11-02T14:00:00.000Z 2026-11-02T15:00:00.000Z",
      // Windows zone name "Pacific Standard Time", DURATION
      "2026-11-05T16:00:00.000Z 2026-11-05T16:30:00.000Z",
      // 9 Nov removed by EXDATE; all-day 11 Nov is the whole day in the host's zone
      "2026-11-11T05:00:00.000Z 2026-11-12T05:00:00.000Z",
      // 16 Nov instance moved to Tue 17 Nov 10:00 (RECURRENCE-ID)
      "2026-11-17T15:00:00.000Z 2026-11-17T16:00:00.000Z",
      "2026-11-27T12:00:00.000Z 2026-11-27T12:30:00.000Z",
    ]);
  });
  it("skips transparent and cancelled events", () => {
    const got = expandBusy(fixture, "UTC", Date.parse("2026-11-03T00:00:00Z"), Date.parse("2026-11-05T00:00:00Z"));
    expect(got).toEqual([]);
  });
  it("clips to the window", () => {
    const got = expandBusy(fixture, "America/New_York", Date.parse("2026-11-10T00:00:00Z"), Date.parse("2026-11-12T00:00:00Z")).map(iso);
    expect(got).toEqual(["2026-11-11T05:00:00.000Z 2026-11-12T05:00:00.000Z"]);
  });
  it("maps zones and durations", () => {
    expect(resolveZone("Eastern Standard Time", "UTC")).toBe("America/New_York");
    expect(resolveZone("/mozilla.org/20070129_1/Europe/Berlin", "UTC")).toBe("Europe/Berlin");
    expect(resolveZone("Not/AZone", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(parseDuration("P1DT2H30M")).toBe((26 * 60 + 30) * 60000);
    expect(parseDuration("PT45M")).toBe(45 * 60000);
  });
  it("handles weekly BYDAY with INTERVAL and UNTIL, and monthly BYMONTHDAY", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "DTSTART:20261102T150000Z", "DTEND:20261102T160000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261125T000000Z", "END:VEVENT",
      "BEGIN:VEVENT", "UID:b", "DTSTART:20261015T100000Z", "DTEND:20261015T110000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const got = expandBusy(ics, "UTC", Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-20T00:00:00Z")).map((r) => new Date(r.start_ms).toISOString().slice(0, 16));
    expect(got).toEqual(["2026-11-02T15:00", "2026-11-04T15:00", "2026-11-15T10:00", "2026-11-16T15:00", "2026-11-18T15:00", "2026-12-15T10:00"]);
  });
  it("busy blocks remove the slots they overlap", () => {
    const base = {
      now: "2026-11-15T12:00:00.000Z", rangeStart: "2026-11-16T00:00:00.000Z", rangeEnd: "2026-11-17T00:00:00.000Z",
      schedule: { timeZone: "America/New_York", hours: [{ weekday: 1, startMin: 540, endMin: 720 }], overrides: [] },
      event: { durationMin: 30, stepMin: null, minNoticeMin: 0, bufferBeforeMin: 0, bufferAfterMin: 0, maxPerDay: null, futureDays: null },
    };
    const free = computeSlots({ ...base, busy: [] });
    expect(free.length).toBe(6);
    const blocks = expandBusy(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART;TZID=America/New_York:20261116T100000", "DTEND;TZID=America/New_York:20261116T110000", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
      "America/New_York", Date.parse("2026-11-16T00:00:00Z"), Date.parse("2026-11-17T00:00:00Z"));
    const busy = blocks.map((b) => ({ start: new Date(b.start_ms).toISOString(), end: new Date(b.end_ms).toISOString(), bufferBeforeMin: 0, bufferAfterMin: 0, sameEvent: false }));
    const left = computeSlots({ ...base, busy });
    expect(left).toEqual(["2026-11-16T14:00:00.000Z", "2026-11-16T14:30:00.000Z", "2026-11-16T16:00:00.000Z", "2026-11-16T16:30:00.000Z"]);
  });
});
