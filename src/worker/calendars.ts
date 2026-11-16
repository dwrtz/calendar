// Busy times from a secret iCal address (R17).
import { expandBusy } from "../shared/ical-parse";
import { encrypt, decrypt } from "./crypto";

type Db = { one: (sql: string, ...p: any[]) => Promise<any>; all: (sql: string, ...p: any[]) => Promise<any[]>; run: (sql: string, ...p: any[]) => Promise<{ changes: number }>; nowIso: () => string };
const HORIZON_DAYS = 60, MAX_BYTES = 5_000_000;
export const pollMinutes = (env: any) => Math.min(15, Math.max(5, Number(env.ICAL_POLL_MINUTES) || 10));

export function checkFeedUrl(env: any, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL; try { u = new URL(raw.trim().replace(/^webcal:\/\//i, "https://")); } catch { return null; }
  if (u.protocol === "https:") return u.toString();
  if (env.TEST_CLOCK === "1" && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) return u.toString();
  return null;
}
export function hintFor(url: string) {
  // Only the host, the file name and 6 characters of the secret part are ever shown.
  const u = new URL(url); const parts = u.pathname.split("/").filter(Boolean);
  const file = parts.length && /\.ics$/i.test(parts[parts.length - 1]) ? parts.pop()! : "";
  const secret = (parts.join("/") + u.search).replace(/[^A-Za-z0-9]/g, "");
  return `${u.hostname}/…${file ? "/" + file : ""} ending …${secret.slice(-6)}`;
}
export class FeedError extends Error {}
async function fetchFeed(url: string, etag?: string | null, lastModified?: string | null) {
  let r: Response;
  const headers: Record<string, string> = { Accept: "text/calendar, */*" };
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;
  try { r = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15000) }); }
  catch { throw new FeedError("Couldn't reach the address. Check it and try again."); }
  if (r.status === 304) return { notModified: true as const };
  if (r.status === 404 || r.status === 410) throw new FeedError(`The address returned ${r.status}. It may have been reset in Google Calendar.`);
  if (r.status === 401 || r.status === 403) throw new FeedError(`The address returned ${r.status}. It may be private or reset; copy the secret address again.`);
  if (!r.ok) throw new FeedError(`The address returned ${r.status}. We'll try again on the next sync.`);
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new FeedError("That calendar is too large to read (over 5 MB).");
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new FeedError("The address didn't return an iCal calendar. Copy the address that ends in .ics.");
  return { notModified: false as const, text, etag: r.headers.get("ETag"), lastModified: r.headers.get("Last-Modified") };
}

export function makeCalendars(env: any, db: Db) {
  const DB: any = env.DB;
  async function storeBlocks(userId: number, text: string, zone: string) {
    const now = Date.parse(db.nowIso());
    const blocks = expandBusy(text, zone, now - 86400000, now + HORIZON_DAYS * 86400000).slice(0, 3000);
    const stmts = [DB.prepare("DELETE FROM busy_blocks WHERE user_id=? AND source='ical'").bind(userId),
      ...blocks.map((b) => DB.prepare("INSERT INTO busy_blocks (user_id,source,start_ms,end_ms) VALUES (?,?,?,?)").bind(userId, "ical", b.start_ms, b.end_ms))];
    await DB.batch(stmts);
    return blocks.length;
  }
  /** Save (or replace) the host's feed. Fetched once first, so a bad address is refused. */
  async function save(user: any, rawUrl: unknown) {
    const url = checkFeedUrl(env, rawUrl);
    if (!url) throw new FeedError("Enter the full https:// address of an iCal calendar.");
    const enc = await encrypt(env.ENCRYPTION_KEY, url);
    const f = await fetchFeed(url);
    if (f.notModified) throw new FeedError("The address didn't return a calendar.");
    const now = db.nowIso();
    await db.run(`INSERT INTO calendar_feeds (user_id,url_enc,url_hint,etag,last_modified,last_sync_at,last_ok_at,last_error,fail_count,created_at) VALUES (?,?,?,?,?,?,?,'',0,?)
      ON CONFLICT(user_id) DO UPDATE SET url_enc=excluded.url_enc,url_hint=excluded.url_hint,etag=excluded.etag,last_modified=excluded.last_modified,
      last_sync_at=excluded.last_sync_at,last_ok_at=excluded.last_ok_at,last_error='',fail_count=0`, user.id, enc, hintFor(url), f.etag, f.lastModified, now, now, now);
    return storeBlocks(user.id, f.text, user.time_zone);
  }
  async function remove(userId: number) {
    await DB.batch([DB.prepare("DELETE FROM calendar_feeds WHERE user_id=?").bind(userId), DB.prepare("DELETE FROM busy_blocks WHERE user_id=? AND source='ical'").bind(userId)]);
  }
  async function sync(feed: any) {
    const now = db.nowIso();
    try {
      const user = await db.one("SELECT id,time_zone FROM users WHERE id=?", feed.user_id);
      const url = await decrypt(env.ENCRYPTION_KEY, feed.url_enc);
      const f = await fetchFeed(url, feed.etag, feed.last_modified);
      if (!f.notModified) await storeBlocks(feed.user_id, f.text, user.time_zone);
      await db.run("UPDATE calendar_feeds SET last_sync_at=?,last_ok_at=?,last_error='',fail_count=0,etag=COALESCE(?,etag),last_modified=COALESCE(?,last_modified) WHERE id=?",
        now, now, f.notModified ? null : f.etag, f.notModified ? null : f.lastModified, feed.id);
      return { ok: true };
    } catch (e: any) {
      const msg = e instanceof FeedError ? e.message : /ENCRYPTION_KEY|decrypt|operation/i.test(String(e?.message)) ? "The saved address can't be read with the current ENCRYPTION_KEY. Paste it again." : "Sync failed. We'll try again on the next sync.";
      if (!(e instanceof FeedError)) console.error(JSON.stringify({ ical: "sync failed", error: String(e?.message ?? e).slice(0, 200) }));
      await db.run("UPDATE calendar_feeds SET last_sync_at=?,last_error=?,fail_count=fail_count+1 WHERE id=?", now, msg, feed.id);
      return { ok: false, error: msg };
    }
  }
  async function pollDue() {
    const cutoff = new Date(Date.parse(db.nowIso()) - (pollMinutes(env) - 1) * 60000).toISOString();
    const due = await db.all("SELECT * FROM calendar_feeds WHERE last_sync_at IS NULL OR last_sync_at <= ? ORDER BY last_sync_at LIMIT 20", cutoff);
    let ok = 0; for (const f of due) if ((await sync(f)).ok) ok++;
    return { polled: due.length, ok };
  }
  /** Feed status for the settings page; never includes the address. */
  async function status(userId: number) {
    const f = await db.one("SELECT url_hint,last_sync_at,last_ok_at,last_error,fail_count FROM calendar_feeds WHERE user_id=?", userId);
    if (!f) return { state: "off", hint: null, lastSyncAt: null, lastError: "", blocks: 0 };
    const blocks = (await db.one("SELECT COUNT(*) AS n FROM busy_blocks WHERE user_id=? AND source='ical'", userId)).n;
    return { state: f.fail_count >= 3 ? "attention" : "on", hint: f.url_hint, lastSyncAt: f.last_sync_at, lastOkAt: f.last_ok_at, lastError: f.last_error, failCount: f.fail_count, blocks };
  }
  return { save, remove, sync, pollDue, status };
}

/** Whether a host's iCal blocks are fresh enough to use: stale (3+ failures and last good sync over 24h ago) blocks are ignored. */
export const USE_BLOCKS_SQL = `NOT EXISTS (SELECT 1 FROM calendar_feeds cf WHERE cf.user_id=bb.user_id AND cf.fail_count>=3 AND (cf.last_ok_at IS NULL OR cf.last_ok_at < ?))`;
