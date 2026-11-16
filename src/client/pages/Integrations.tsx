import React, { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { api, type ApiError } from "../lib";
import { Field, Spinner, useToast } from "../ui";

export const ICAL_HELP = "In Google Calendar on the web, open Settings (the gear), choose your calendar under 'Settings for my calendars', open 'Integrate calendar', and copy 'Secret address in iCal format'. It ends in basic.ics. Anyone with this address can see your events, so it is stored encrypted and never shown again.";
const ago = (iso?: string | null) => (iso ? DateTime.fromISO(iso).toRelative() ?? "just now" : "never");
const STATE: Record<string, string> = { on: "On", off: "Off", attention: "Needs attention" };

function useIntegrations() {
  const [d, setD] = useState<any>(null);
  const load = async () => setD(await api("/api/integrations"));
  useEffect(() => { load().catch(() => setD({ error: true })); }, []);
  return { d, load, setD };
}

export function Calendars() {
  const { d, load } = useIntegrations(); const toast = useToast();
  const [url, setUrl] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(""); const [replacing, setReplacing] = useState(false);
  if (!d) return <div className="panel"><Spinner /></div>;
  const ical = d.ical ?? {}; const keyMissing = d.configured && !d.configured.encryptionKey;
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy("save");
    try { await api("/api/integrations/ical", { method: "PUT", body: { url } }); setUrl(""); setReplacing(false); await load(); toast("Calendar connected"); }
    catch (x) { const er = x as ApiError; setErr(er.fields?.url || er.message); }
    finally { setBusy(""); }
  }
  async function act(kind: "sync" | "remove") {
    setBusy(kind);
    try {
      if (kind === "sync") await api("/api/integrations/ical/sync", { method: "POST" }); else await api("/api/integrations/ical", { method: "DELETE" });
      await load(); toast(kind === "sync" ? "Synced" : "Calendar removed");
    } catch (x) { toast((x as ApiError).message); } finally { setBusy(""); }
  }
  const showForm = ical.state === "off" || replacing;
  return (
    <div className="panel form-panel integ">
      <h2>Busy times from your calendar</h2>
      <p className="muted">Paste your calendar's secret iCal address and times you're busy there stop showing as open on your booking pages. It syncs every {ical.pollMinutes ?? 10} minutes.</p>
      {ical.state !== "off" && <div className={"integ-status " + ical.state} role="status">
        <div><strong>{STATE[ical.state]}</strong> · <span>{ical.hint}</span></div>
        <div className="muted">Last synced {ago(ical.lastSyncAt)}{ical.lastOkAt && ical.lastOkAt !== ical.lastSyncAt ? ` (last success ${ago(ical.lastOkAt)})` : ""} · {ical.blocks} busy {ical.blocks === 1 ? "time" : "times"} in the next 60 days</div>
        {ical.lastError && <p className="err" role="alert">{ical.lastError}</p>}
        {ical.state === "attention" && <p className="help">After 3 failed syncs in a row, busy times older than a day stop counting. Paste the address again to fix it.</p>}
        <div className="form-actions left"><button type="button" className="btn" disabled={!!busy} onClick={() => act("sync")}>{busy === "sync" && <Spinner />}Sync now</button>
          <button type="button" className="btn" onClick={() => setReplacing(!replacing)}>{replacing ? "Keep this one" : "Replace"}</button>
          <button type="button" className="btn danger" disabled={!!busy} onClick={() => act("remove")}>{busy === "remove" && <Spinner />}Remove</button></div>
      </div>}
      {showForm && <form onSubmit={save}>
        <Field label="Secret iCal address" htmlFor="ical-url" error={err} help={ICAL_HELP}>
          <input id="ical-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" value={url} onChange={(e) => setUrl(e.target.value)} disabled={keyMissing} required />
        </Field>
        {keyMissing && <p className="err" role="alert">Set ENCRYPTION_KEY first. It's a Worker secret: run <code>openssl rand -base64 32</code> and save the result with <code>wrangler secret put ENCRYPTION_KEY</code>.</p>}
        <p className="help">Any https:// iCal address works: Outlook and iCloud publish them too.</p>
        <button className="btn primary" disabled={!!busy || keyMissing}>{busy === "save" && <Spinner />}Save address</button>
      </form>}
      <h2 className="integ-h2">Google Calendar (two-way)</h2>
      <p className="muted">Not set up on this site. Two-way sync needs a Google Cloud OAuth client; see the README. The secret address above covers busy times without it.</p>
    </div>
  );
}

export function Integrations() {
  const { d } = useIntegrations();
  if (!d) return <div className="panel"><Spinner /></div>;
  const e = d.email ?? {};
  const rows = [
    { name: "Email", state: e.state, line: e.state === "off" ? "No emails are sent. Guests are told to keep their booking page." : e.state === "attention" ? e.reason : e.provider === "test" ? "Sending to the test outbox." : `Sending from ${e.from} with ${e.provider === "cloudflare" ? "Cloudflare Email Sending" : "Resend"}.`, err: e.lastError },
    { name: "Calendar invites", state: e.state === "on" ? "on" : "off", line: e.state === "on" ? "Booking emails carry an invite that shows as confirmed in the guest's and your calendar." : "Sent with booking emails, so they start when email does. \"Add to calendar\" works without email." },
    { name: "Busy times (iCal)", state: d.ical?.state, line: d.ical?.state === "off" ? "Paste a secret iCal address under Calendars." : `Last synced ${ago(d.ical?.lastSyncAt)}.`, err: d.ical?.lastError },
    { name: "Google Calendar", state: "off", line: "Not set up on this site." },
  ];
  return (
    <div className="panel form-panel integ">
      <h2>Integrations</h2>
      <ul className="integ-list">{rows.map((r) => <li key={r.name}><div><strong>{r.name}</strong><p className="muted">{r.line}</p>{r.err && <p className="err">Last error: {r.err}</p>}</div><span className={"badge state-" + r.state}>{STATE[r.state] ?? "Off"}</span></li>)}</ul>
      {e.state !== "on" && <details className="integ-setup"><summary>How to turn on email</summary>
        <ol>
          <li>Cloudflare Email Sending needs the Workers Paid plan to send to any address (3,000 emails a month included, then $0.35 per 1,000) and the domain on Cloudflare DNS.</li>
          <li>In the dashboard open Compute &gt; Email Service &gt; Email Sending &gt; Onboard Domain and pick your domain. It adds SPF and DKIM TXT records, a DMARC record on _dmarc and cf-bounce MX records. Wait until it shows as verified.</li>
          <li>Add the <code>send_email</code> binding named <code>EMAIL</code>, set <code>EMAIL_PROVIDER=cloudflare</code>, <code>EMAIL_FROM</code> (an address on that domain) and <code>SITE_URL</code>, then deploy.</li>
          <li>Or use Resend: verify the domain there, <code>wrangler secret put RESEND_API_KEY</code>, set <code>EMAIL_PROVIDER=resend</code> and <code>EMAIL_FROM</code>.</li>
        </ol></details>}
    </div>
  );
}
