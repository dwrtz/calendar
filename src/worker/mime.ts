// RFC 5322/2045 message builder. Calendar invites go out the way Google Calendar and Outlook send them:
// multipart/mixed( multipart/alternative( text/plain, text/html, text/calendar; method=... ), invite.ics attachment ).
// Gmail renders the invite card and adds the event from the inline text/calendar part.
export type MimeInput = {
  from: { email: string; name?: string }; to: string; replyTo?: string; subject: string; text: string; html: string;
  ics?: string; icsMethod?: "REQUEST" | "CANCEL" | "PUBLISH" | "DECLINECOUNTER"; date?: Date; messageId?: string;
};
const enc = new TextEncoder();
export function b64(s: string): string { let o = ""; for (const x of enc.encode(s)) o += String.fromCharCode(x); return btoa(o); }
const wrap76 = (s: string) => s.replace(/.{1,76}/g, (m) => m + "\r\n");
/** RFC 2047 encoded-word for non-ASCII header text; ASCII passes through. */
export function encodeWord(s: string): string { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`; }
function mailbox(email: string, name?: string) {
  if (!name) return `<${email}>`;
  const n = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeWord(name);
  return `${n} <${email}>`;
}
const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
function part(type: string, body: string, extra: string[] = []) {
  return [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", wrap76(b64(body))].join("\r\n");
}
export function buildMime(m: MimeInput): string {
  const domain = m.from.email.split("@")[1] || "localhost";
  const alt = `alt_${rnd()}`, mixed = `mixed_${rnd()}`;
  const headers = [
    `From: ${mailbox(m.from.email, m.from.name)}`,
    `To: <${m.to}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId ?? `<${rnd()}@${domain}>`}`,
    "MIME-Version: 1.0",
  ];
  const altParts = [part("text/plain; charset=UTF-8", m.text), part("text/html; charset=UTF-8", m.html)];
  if (m.ics) altParts.push(part(`text/calendar; charset=UTF-8; method=${m.icsMethod ?? "REQUEST"}`, m.ics));
  const altBody = altParts.map((p) => `--${alt}\r\n${p}`).join("") + `--${alt}--\r\n`;
  if (!m.ics) return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altBody].join("\r\n");
  const attach = part(`application/ics; name="invite.ics"`, m.ics, [`Content-Disposition: attachment; filename="invite.ics"`]);
  const body = `--${mixed}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n${altBody}--${mixed}\r\n${attach}--${mixed}--\r\n`;
  return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", body].join("\r\n");
}
