// Scheduled handler (Cron Trigger */5 * * * *): expired proposed times (R19), reminders and retries (R15), iCal polling (R17).
import { database } from "./db";
import { makeMailer, provider } from "./email";
import { makeCalendars } from "./calendars";
import { expireDue } from "./changes";

export async function runScheduled(env: any) {
  const db = database(env, new Request("https://cron.invalid/"));
  const now = Date.parse(db.nowIso());
  // Lease: overlapping runs do nothing. Released at the end so the next run (or a test) can go.
  const lease = await db.run("INSERT INTO cron_runs (name,started_at) VALUES ('main',?) ON CONFLICT(name) DO UPDATE SET started_at=excluded.started_at WHERE cron_runs.started_at < ?", Date.now(), Date.now() - 4 * 60000);
  if (!lease.changes) return { skipped: "another run holds the lease" };
  const out: Record<string, unknown> = {};
  try {
    if (provider(env)) {
      try {
        const origin = String(env.SITE_URL || "").replace(/\/$/, "");
        if (!origin) out.email = { error: "Set SITE_URL so reminder links point at your site" };
        else {
          const mailer = makeMailer(env, db, origin);
          // Proposed new times nobody answered before their deadline (R19) go first, so reminders use the kept time.
          out.changesExpired = await expireDue(db, mailer);
          out.email = await mailer.runReminders();
        }
      } catch (e: any) { out.email = { error: String(e?.message ?? e) }; console.error(JSON.stringify({ cron: "email", error: String(e?.message ?? e) })); }
    }
    try { out.ical = await makeCalendars(env, db).pollDue(); }
    catch (e: any) { out.ical = { error: String(e?.message ?? e) }; console.error(JSON.stringify({ cron: "ical", error: String(e?.message ?? e) })); }
  } finally {
    await db.run("DELETE FROM cron_runs WHERE name='main'");
  }
  void now;
  return out;
}
