import { describe, it, expect } from "vitest";
import { computeSlots, groupByDate, type SlotInput } from "../src/shared/slots";

const NY = "America/New_York";
const wk = (days: number[], s: number, e: number) => days.map((weekday) => ({ weekday, startMin: s, endMin: e }));
const base = (over: Partial<SlotInput> & { ev?: Partial<SlotInput["event"]> } = {}): SlotInput => ({
  now: "2026-11-15T12:00:00.000Z",
  rangeStart: "2026-11-16T00:00:00.000Z",
  rangeEnd: "2026-11-18T00:00:00.000Z",
  schedule: { timeZone: NY, hours: wk([1, 2, 3, 4, 5], 540, 1020), overrides: [] },
  busy: [],
  ...over,
  event: { durationMin: 30, stepMin: null, minNoticeMin: 0, bufferBeforeMin: 0, bufferAfterMin: 0, maxPerDay: null, futureDays: null, ...(over.event ?? {}), ...(over.ev ?? {}) },
});
const onDay = (slots: string[], tz: string, d: string) => groupByDate(slots, tz)[d] ?? [];

describe("computeSlots", () => {
  it("1 basic", () => {
    const m = onDay(computeSlots(base()), NY, "2026-11-16");
    expect(m.length).toBe(16);
    expect(m[0]).toBe("2026-11-16T14:00:00.000Z");
    expect(m[15]).toBe("2026-11-16T21:30:00.000Z");
  });
  it("2 step", () => {
    const m = onDay(computeSlots(base({ ev: { durationMin: 60, stepMin: 30 } })), NY, "2026-11-16");
    expect(m.length).toBe(15);
    expect(m[14]).toBe("2026-11-16T21:00:00.000Z");
  });
  it("3 fit", () => {
    const s = computeSlots(base({ schedule: { timeZone: NY, hours: wk([1], 540, 600), overrides: [] }, ev: { durationMin: 45 } }));
    expect(onDay(s, NY, "2026-11-16")).toEqual(["2026-11-16T14:00:00.000Z"]);
  });
  it("4 notice", () => {
    const s = computeSlots(base({ now: "2026-11-16T15:10:00.000Z", ev: { minNoticeMin: 60 } }));
    expect(onDay(s, NY, "2026-11-16")[0]).toBe("2026-11-16T16:30:00.000Z");
  });
  it("5 DST forward", () => {
    const sched = { timeZone: NY, hours: [...wk([0], 60, 240), ...wk([1, 5], 540, 1020)], overrides: [] };
    const s = computeSlots(base({ now: "2027-03-01T00:00:00.000Z", rangeStart: "2027-03-12T00:00:00.000Z", rangeEnd: "2027-03-16T00:00:00.000Z", schedule: sched, ev: { durationMin: 60 } }));
    expect(onDay(s, NY, "2027-03-14")).toEqual(["2027-03-14T06:00:00.000Z", "2027-03-14T07:00:00.000Z"]);
    expect(onDay(s, NY, "2027-03-15")[0]).toBe("2027-03-15T13:00:00.000Z");
    expect(onDay(s, NY, "2027-03-12")[0]).toBe("2027-03-12T14:00:00.000Z");
  });
  it("6 DST back", () => {
    const s = computeSlots(base({ now: "2026-10-20T00:00:00.000Z", rangeStart: "2026-11-01T00:00:00.000Z", rangeEnd: "2026-11-02T12:00:00.000Z", schedule: { timeZone: NY, hours: wk([0], 0, 180), overrides: [] }, ev: { durationMin: 60 } }));
    expect(onDay(s, NY, "2026-11-01")).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z"]);
  });
  it("7 half-hour zone", () => {
    const s = computeSlots(base({ schedule: { timeZone: "Asia/Kolkata", hours: wk([1], 540, 600), overrides: [] } }));
    expect(onDay(s, "Asia/Kolkata", "2026-11-16")).toEqual(["2026-11-16T03:30:00.000Z", "2026-11-16T04:00:00.000Z"]);
  });
  it("8 midnight", () => {
    const s = computeSlots(base({ schedule: { timeZone: "Europe/London", hours: [...wk([1], 1320, 1440), ...wk([2], 0, 120)], overrides: [] }, ev: { durationMin: 120, stepMin: 60 } }));
    expect(s).toEqual(["2026-11-16T22:00:00.000Z", "2026-11-16T23:00:00.000Z", "2026-11-17T00:00:00.000Z"]);
  });
  it("9 override", () => {
    const r = { rangeEnd: "2026-11-24T00:00:00.000Z" };
    const s = computeSlots(base({ ...r, schedule: { timeZone: NY, hours: wk([1], 540, 1020), overrides: [{ date: "2026-11-16", startMin: 780, endMin: 840 }] } }));
    expect(onDay(s, NY, "2026-11-16")).toEqual(["2026-11-16T18:00:00.000Z", "2026-11-16T18:30:00.000Z"]);
    expect(onDay(s, NY, "2026-11-23").length).toBe(16);
    const u = computeSlots(base({ ...r, schedule: { timeZone: NY, hours: wk([1], 540, 1020), overrides: [{ date: "2026-11-16", startMin: null, endMin: null }] } }));
    expect(onDay(u, NY, "2026-11-16")).toEqual([]);
    expect(onDay(u, NY, "2026-11-23").length).toBe(16);
  });
  const b1030 = { start: "2026-11-16T15:00:00.000Z", end: "2026-11-16T15:30:00.000Z", bufferBeforeMin: 0, bufferAfterMin: 0, sameEvent: true };
  it("10 busy", () => {
    const m = onDay(computeSlots(base({ busy: [b1030] })), NY, "2026-11-16");
    expect(m.length).toBe(15);
    expect(m).not.toContain("2026-11-16T15:00:00.000Z");
  });
  it("11 buffers", () => {
    const m = onDay(computeSlots(base({ busy: [{ ...b1030, bufferBeforeMin: 10 }], ev: { bufferAfterMin: 15 } })), NY, "2026-11-16");
    expect(m).not.toContain("2026-11-16T14:30:00.000Z");
    expect(m).toContain("2026-11-16T14:00:00.000Z");
    const z = onDay(computeSlots(base({ busy: [b1030] })), NY, "2026-11-16");
    expect(z).toContain("2026-11-16T14:30:00.000Z");
  });
  it("12 per day", () => {
    const s = computeSlots(base({ busy: [b1030], ev: { maxPerDay: 1 } }));
    expect(onDay(s, NY, "2026-11-16")).toEqual([]);
    expect(onDay(s, NY, "2026-11-17").length).toBe(16);
    const o = computeSlots(base({ busy: [{ ...b1030, sameEvent: false }], ev: { maxPerDay: 1 } }));
    expect(onDay(o, NY, "2026-11-16").length).toBe(15);
  });
  it("13 horizon", () => {
    const s = computeSlots(base({ now: "2026-11-15T17:00:00.000Z", rangeEnd: "2026-11-30T00:00:00.000Z", ev: { futureDays: 7 } }));
    expect(onDay(s, NY, "2026-11-20").length).toBe(16);
    expect(s.some((x) => x >= "2026-11-22T05:00:00.000Z")).toBe(false);
  });
  it("14 visitor zone", () => {
    const s = computeSlots(base());
    const g = groupByDate(s.filter((x) => x < "2026-11-17T00:00:00.000Z"), "Pacific/Kiritimati");
    expect(Object.keys(g)).toEqual(["2026-11-17"]);
    expect(g["2026-11-17"]).toEqual(onDay(s, NY, "2026-11-16"));
  });
});
