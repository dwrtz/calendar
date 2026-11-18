// The Worker's email() entry (R19). Kept apart from inbound.ts so the tested core has no Worker-only types.
import { processInbound, REJECT } from "./inbound";
import { emailOn, makeMailer, mask } from "./email";
import { database } from "./db";

/** The Worker's email() handler. Rejects (permanent SMTP error) anything it can't use; never forwards or replies. */
export async function receiveEmail(message: ForwardableEmailMessage, env: any, ctx?: ExecutionContext) {
  const raw = await new Response(message.raw).arrayBuffer();
  const db = database(env, new Request("https://email.invalid/"));
  const origin = String(env.SITE_URL || "").replace(/\/$/, "");
  const mailer = makeMailer(env, db, origin);
  const result = emailOn(env) && origin
    ? await processInbound({ from: message.from, to: message.to, raw, size: message.rawSize }, {
        env, db, notifyDeclined: async (uid, id) => { const p = mailer.notifyHost("rsvp_declined", uid, id); if (ctx?.waitUntil) ctx.waitUntil(p); else await p; },
      })
    : { ok: false as const, reason: REJECT.off };
  console.log(JSON.stringify({ inbound: result.ok ? result.action : "rejected", from: mask(message.from), ...(result.ok ? { uid: result.uid, role: result.role, partstat: result.partstat ?? "" } : { reason: result.reason }) }));
  if (!result.ok) message.setReject(result.reason);
  return result;
}
