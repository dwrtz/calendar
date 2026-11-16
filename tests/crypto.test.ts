import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../src/worker/crypto";

const key = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString("base64");
const other = Buffer.from(new Uint8Array(32).map((_, i) => 255 - i)).toString("base64");
describe("crypto", () => {
  it("round-trips with a fresh IV each time", async () => {
    const url = "https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc123/basic.ics";
    const a = await encrypt(key, url), b = await encrypt(key, url);
    expect(a).not.toBe(b); expect(a.startsWith("v1.")).toBe(true); expect(a).not.toContain("abc123");
    expect(await decrypt(key, a)).toBe(url);
  });
  it("fails with the wrong key or no key", async () => {
    const a = await encrypt(key, "secret");
    await expect(decrypt(other, a)).rejects.toThrow();
    await expect(encrypt(undefined, "x")).rejects.toThrow("Set ENCRYPTION_KEY first");
    await expect(encrypt("c2hvcnQ=", "x")).rejects.toThrow(/32 bytes/);
  });
});
