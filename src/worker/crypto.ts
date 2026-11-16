// AES-GCM for values stored in D1 (R17/R18). Format: v1.<iv b64url>.<ciphertext b64url>.
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
export class MissingKeyError extends Error { constructor() { super("Set ENCRYPTION_KEY first"); } }
async function key(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new MissingKeyError();
  let raw: Uint8Array;
  try { raw = unb64u(secret.trim().replace(/=+$/, "")); } catch { throw new Error("ENCRYPTION_KEY must be base64"); }
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(secret: string | undefined, text: string): Promise<string> {
  const k = await key(secret); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(text)));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function decrypt(secret: string | undefined, blob: string): Promise<string> {
  const [v, iv, ct] = String(blob).split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unknown encrypted value");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) as unknown as ArrayBuffer }, await key(secret), unb64u(ct) as unknown as ArrayBuffer);
  return new TextDecoder().decode(pt);
}
