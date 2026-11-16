export class HttpError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string>) { super(message); }
}
export const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();
async function derive(pw: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations }, key, 256));
}
export async function hashPassword(pw: string) {
  const salt = randomHex(16), n = 100_000;
  const bits = await derive(pw, salt, n);
  return `pbkdf2-sha256$${n}$${salt}$${Array.from(bits, b => b.toString(16).padStart(2,"0")).join("")}`;
}
export async function checkPassword(pw: string, stored: string) {
  const [alg, n, salt, hex] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || Number(n) !== 100_000 || !/^[a-f0-9]{64}$/.test(hex)) return false;
  const got = await derive(pw, salt, Number(n));
  const expected = Uint8Array.from(hex.match(/../g)!, h => parseInt(h,16));
  return crypto.subtle.timingSafeEqual(got, expected);
}
