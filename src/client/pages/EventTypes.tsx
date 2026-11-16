import React, { useEffect, useState } from "react";
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, LOCATION_LABEL, slugify, summarize, type ApiError } from "../lib";
import { Dialog, Empty, Field, Icon, Menu, Spinner, Switch, useToast } from "../ui";
import { PageHeader, useAuth } from "../App";

export { COLORS } from "../../shared/colors";
import { COLORS } from "../../shared/colors";
const REMINDERS: [number, string][] = [[10080, "1 week"], [1440, "1 day"], [60, "1 hour"], [15, "15 minutes"]];

function NewEventDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate(); const toast = useToast(); const { me } = useAuth();
  const [b, setB] = useState({ title: "", slug: "", description: "", duration_min: 30 });
  const [slugTouched, setSlugTouched] = useState(false); const [fields, setFields] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { const et = await api("/api/event-types", { body: { ...b, duration_min: Number(b.duration_min) } }); nav(`/event-types/${et.id}?tab=setup`); }
    catch (e) { const er = e as ApiError; setFields(er.fields || {}); toast(er.message); } finally { setBusy(false); }
  }
  return (
    <Dialog title="New event type" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Title" htmlFor="nt-title" error={fields.title}><input id="nt-title" required value={b.title} onChange={(e) => setB({ ...b, title: e.target.value, slug: slugTouched ? b.slug : slugify(e.target.value) })} /></Field>
        <Field label="URL slug" htmlFor="nt-slug" error={fields.slug}><div className="prefixed"><span>/{me.username}/</span><input id="nt-slug" required value={b.slug} onChange={(e) => { setSlugTouched(true); setB({ ...b, slug: slugify(e.target.value) || e.target.value.toLowerCase() }); }} /></div></Field>
        <Field label="Description" htmlFor="nt-desc" error={fields.description}><textarea id="nt-desc" rows={3} value={b.description} onChange={(e) => setB({ ...b, description: e.target.value })} /></Field>
        <Field label="Duration (minutes)" htmlFor="nt-dur" error={fields.duration_min}><input id="nt-dur" type="number" min={5} max={720} required value={b.duration_min} onChange={(e) => setB({ ...b, duration_min: e.target.value as any })} /></Field>
        <div className="dialog-foot"><button type="button" className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={busy}>{busy && <Spinner />}Continue</button></div>
      </form>
    </Dialog>
  );
}

export function EventList() {
  const { me } = useAuth(); const toast = useToast(); const nav = useNavigate();
  const [list, setList] = useState<any[] | null>(null); const [creating, setCreating] = useState(false); const [deleting, setDeleting] = useState<any>(null);
  const load = () => api("/api/event-types").then(setList).catch((e) => toast(e.message));
  useEffect(() => { load(); }, []);
  async function act(fn: () => Promise<any>) { try { await fn(); await load(); } catch (e: any) { toast(e.message); } }
  return (
    <>
      <PageHeader title="Event types" subtitle="Kinds of meeting people can book with you. Share a link, or your whole page, so people can pick a time." action={<button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />New</button>} />
      {list === null ? <Spinner /> : list.length === 0 ? (
        <div className="panel"><Empty icon="link" title="No event types yet" line="Make one, like a 30-minute call, then share its link so people can book you." action={<button className="btn primary" onClick={() => setCreating(true)}>New</button>} /></div>
      ) : (
        <ul className="panel rows" aria-label="Event types">
          {list.map((et, i) => (
            <li key={et.id} className="row et-row">
              <span className="colour-dot" style={{ background: et.color }} />
              <Link to={`/event-types/${et.id}?tab=setup`} className="row-main">
                <strong>{et.title}</strong> <span className="muted">/{me.username}/{et.slug}</span>
                <div className="badges"><span className="badge"><Icon name="clock" size={12} />{et.duration_min}m</span>{!!et.requires_approval && <span className="badge">Needs approval</span>}{!!et.hidden && <span className="badge">Hidden</span>}{et.location_kind === "video" && !et.location_value && <span className="badge warn" title="Guests won't see where to join">Add a meeting link</span>}</div>
              </Link>
              <div className="row-actions">
                <label className="switch-label">Hidden <Switch label={`Hide ${et.title}`} checked={!!et.hidden} onChange={(v) => act(() => api(`/api/event-types/${et.id}`, { method: "PATCH", body: { hidden: v ? 1 : 0 } }))} /></label>
                <button className="icon-btn" aria-label={`Copy link to ${et.title}`} onClick={async () => { await navigator.clipboard?.writeText(`${location.origin}/${me.username}/${et.slug}`).catch(() => {}); toast("Link copied"); }}><Icon name="copy" /></button>
                <a className="icon-btn" aria-label={`Preview ${et.title}`} href={`/${me.username}/${et.slug}`} target="_blank" rel="noopener"><Icon name="ext" /></a>
                <Menu label={`More for ${et.title}`} items={[
                  { label: "Edit", onClick: () => nav(`/event-types/${et.id}?tab=setup`) },
                  { label: "Duplicate", onClick: async () => { try { const c = await api(`/api/event-types/${et.id}/duplicate`, { method: "POST" }); nav(`/event-types/${c.id}?tab=setup`); } catch (e: any) { toast(e.message); } } },
                  { label: "Move up", disabled: i === 0, onClick: () => act(() => api(`/api/event-types/${et.id}/move`, { body: { direction: "up" } })) },
                  { label: "Move down", disabled: i === list.length - 1, onClick: () => act(() => api(`/api/event-types/${et.id}/move`, { body: { direction: "down" } })) },
                  { label: "Delete", danger: true, onClick: () => setDeleting(et) },
                ]} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewEventDialog onClose={() => setCreating(false)} />}
      {deleting && (
        <Dialog title="Delete event type?" onClose={() => setDeleting(null)} footer={<><button className="btn" onClick={() => setDeleting(null)}>Keep it</button><button className="btn danger-fill" onClick={() => act(async () => { await api(`/api/event-types/${deleting.id}`, { method: "DELETE" }); setDeleting(null); toast("Event type deleted"); })}>Delete</button></>}>
          <p>People won't be able to book "{deleting.title}" any more. Bookings already made stay in your list.</p>
        </Dialog>
      )}
    </>
  );
}

const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const STEPS = [5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120];
const TABS = [["setup", "Setup"], ["availability", "Availability"], ["limits", "Limits"], ["advanced", "Advanced"]];

export function EventEditor() {
  const { id } = useParams(); const [sp, setSp] = useSearchParams(); const tab = sp.get("tab") || "setup";
  const { me } = useAuth(); const toast = useToast(); const nav = useNavigate();
  const [orig, setOrig] = useState<any>(null); const [et, setEt] = useState<any>(null); const [schedules, setSchedules] = useState<any[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const [noticeUnit, setNoticeUnit] = useState<"minutes" | "hours" | "days">("hours");
  useEffect(() => {
    Promise.all([api(`/api/event-types/${id}`), api("/api/schedules")]).then(([e, s]) => {
      setOrig(e); setEt(e); setSchedules(s);
      setNoticeUnit(e.min_notice_min % 1440 === 0 && e.min_notice_min ? "days" : e.min_notice_min % 60 === 0 && e.min_notice_min ? "hours" : "minutes");
    }).catch((e) => toast(e.message));
  }, [id]);
  const dirty = et && orig && JSON.stringify(et) !== JSON.stringify(orig);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !!dirty && currentLocation.pathname !== nextLocation.pathname);
  if (!et) return <Spinner />;
  const set = (k: string, v: any) => setEt({ ...et, [k]: v });
  const unitMul = { minutes: 1, hours: 60, days: 1440 }[noticeUnit];
  async function save() {
    setBusy(true); setFields({});
    try { const r = await api(`/api/event-types/${et.id}`, { method: "PATCH", body: et }); setOrig(r); setEt(r); toast("Saved"); }
    catch (e) { const er = e as ApiError; setFields(er.fields || {}); toast(er.message); } finally { setBusy(false); }
  }
  const sched = schedules.find((s) => s.id === et.schedule_id) || schedules.find((s) => s.isDefault);
  return (
    <>
      <header className="page-header editor-head">
        <div className="head-left"><Link to="/event-types" className="icon-btn" aria-label="Back to event types"><Icon name="back" /></Link><h1>{orig.title}</h1></div>
        <div className="head-right"><label className="switch-label">Hidden <Switch label="Hidden" checked={!!et.hidden} onChange={(v) => set("hidden", v ? 1 : 0)} /></label>
          <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy && <Spinner />}Save</button></div>
      </header>
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setSp({ tab: k }, { replace: true })}>{l}</button>)}</div>
      <div className="panel form-panel">
        {tab === "setup" && <>
          <Field label="Title" htmlFor="title" error={fields.title}><input id="title" value={et.title} onChange={(e) => set("title", e.target.value)} /></Field>
          <Field label="Description" htmlFor="desc" error={fields.description}><textarea id="desc" rows={4} value={et.description} onChange={(e) => set("description", e.target.value)} /></Field>
          <Field label="URL slug" htmlFor="slug" error={fields.slug}><div className="prefixed"><span>{location.origin}/{me.username}/</span><input id="slug" value={et.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} /></div></Field>
          <Field label="Duration (minutes)" htmlFor="duration" error={fields.duration_min}><input id="duration" type="number" min={5} max={720} value={et.duration_min} onChange={(e) => set("duration_min", Number(e.target.value))} /></Field>
          <Field label="Location" htmlFor="loc" error={fields.location_kind}><select id="loc" value={et.location_kind} onChange={(e) => set("location_kind", e.target.value)}>{Object.entries(LOCATION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {et.location_kind === "video" && <Field label="Meeting link" htmlFor="locv" error={fields.location_value}><input id="locv" placeholder="https://" value={et.location_value} onChange={(e) => set("location_value", e.target.value)} /><p className="help">Guests see this link on their confirmation page. If you leave it empty, they're told you'll share the link.</p></Field>}
          {et.location_kind === "in_person" && <Field label="Address" htmlFor="locv" error={fields.location_value}><input id="locv" value={et.location_value} onChange={(e) => set("location_value", e.target.value)} /></Field>}
          {et.location_kind === "custom" && <Field label="Where" htmlFor="locv" error={fields.location_value}><input id="locv" value={et.location_value} onChange={(e) => set("location_value", e.target.value)} /></Field>}
          {et.location_kind === "phone" && <p className="help">The person booking gives their number.</p>}
        </>}
        {tab === "availability" && <>
          <Field label="Schedule" htmlFor="sched" error={fields.schedule_id}><select id="sched" value={et.schedule_id ?? ""} onChange={(e) => set("schedule_id", e.target.value ? Number(e.target.value) : null)}>
            <option value="">Default schedule{schedules.find((s) => s.isDefault) ? ` (${schedules.find((s) => s.isDefault).name})` : ""}</option>
            {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isDefault ? " (default)" : ""}</option>)}</select></Field>
          {sched && <div className="summary-box"><strong>{sched.name}</strong><p>{summarize(sched.hours, me.time_format, me.week_start)}</p><p className="muted"><Icon name="globe" size={12} /> {sched.timeZone}</p><Link to={`/availability/${sched.id}`}>Edit this schedule</Link></div>}
        </>}
        {tab === "limits" && <>
          <div className="two">
            <Field label="Buffer before" htmlFor="bb" error={fields.buffer_before_min}><select id="bb" value={et.buffer_before_min} onChange={(e) => set("buffer_before_min", Number(e.target.value))}>{BUFFERS.map((b) => <option key={b} value={b}>{b ? `${b} minutes` : "None"}</option>)}</select></Field>
            <Field label="Buffer after" htmlFor="ba" error={fields.buffer_after_min}><select id="ba" value={et.buffer_after_min} onChange={(e) => set("buffer_after_min", Number(e.target.value))}>{BUFFERS.map((b) => <option key={b} value={b}>{b ? `${b} minutes` : "None"}</option>)}</select></Field>
          </div>
          <Field label="Minimum notice" htmlFor="notice" error={fields.min_notice_min} help="How soon before a meeting people can still book it.">
            <div className="inline"><input id="notice" type="number" min={0} value={et.min_notice_min / unitMul} onChange={(e) => set("min_notice_min", Math.round(Number(e.target.value) * unitMul))} />
              <select aria-label="Notice unit" value={noticeUnit} onChange={(e) => { const u = e.target.value as any; setNoticeUnit(u); }}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></div></Field>
          <Field label="Slot step" htmlFor="step" error={fields.slot_step_min} help="How far apart the start times are."><select id="step" value={et.slot_step_min ?? ""} onChange={(e) => set("slot_step_min", e.target.value ? Number(e.target.value) : null)}><option value="">Use event length</option>{STEPS.map((s) => <option key={s} value={s}>{s} minutes</option>)}</select></Field>
          <div className="toggle-field"><label className="switch-label"><Switch label="Limit bookings per day" checked={et.max_per_day != null} onChange={(v) => set("max_per_day", v ? 1 : null)} /> Limit bookings per day</label>
            {et.max_per_day != null && <input aria-label="Bookings per day" type="number" min={1} value={et.max_per_day} onChange={(e) => set("max_per_day", Number(e.target.value))} />}{fields.max_per_day && <div className="err">{fields.max_per_day}</div>}</div>
          <div className="toggle-field"><label className="switch-label"><Switch label="Limit how far ahead" checked={et.future_days != null} onChange={(v) => set("future_days", v ? 30 : null)} /> Limit how far ahead</label>
            {et.future_days != null && <span className="inline"><input aria-label="Days ahead" type="number" min={1} value={et.future_days} onChange={(e) => set("future_days", Number(e.target.value))} /> days</span>}{fields.future_days && <div className="err">{fields.future_days}</div>}</div>
          <fieldset className="reminders"><legend>Email reminders</legend>
            <div className="check-row">{REMINDERS.map(([m, l]) => { const cur: number[] = (() => { try { return JSON.parse(et.reminder_offsets ?? "[1440,60]"); } catch { return []; } })(); return (
              <label key={m} className="check"><input type="checkbox" checked={cur.includes(m)} onChange={(e) => set("reminder_offsets", JSON.stringify(e.target.checked ? [...cur, m] : cur.filter((x) => x !== m)))} /> {l} before</label>); })}</div>
            <p className="help">Sent to you and your guests when email is set up in Settings &gt; Integrations.</p>{fields.reminder_offsets && <div className="err">{fields.reminder_offsets}</div>}</fieldset>
        </>}
        {tab === "advanced" && <>
          <div className="toggle-field"><label className="switch-label"><Switch label="Requires approval" checked={!!et.requires_approval} onChange={(v) => set("requires_approval", v ? 1 : 0)} /> Requires approval</label><p className="help">Bookings wait for you to accept them.</p></div>
          <div className="toggle-field"><label className="switch-label"><Switch label="Hide guests field" checked={!!et.hide_guests} onChange={(v) => set("hide_guests", v ? 1 : 0)} /> Hide guests field</label></div>
          <Field label="Event colour"><div className="swatches" role="radiogroup" aria-label="Event colour">{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={et.color === c} aria-label={c} className={"swatch" + (et.color === c ? " on" : "")} style={{ background: c }} onClick={() => set("color", c)} />)}</div></Field>
        </>}
      </div>
      {blocker.state === "blocked" && (
        <Dialog title="Discard changes?" onClose={() => blocker.reset()} footer={<><button className="btn" onClick={() => blocker.reset()}>Keep editing</button><button className="btn danger-fill" onClick={() => blocker.proceed()}>Discard</button></>}><p>You have changes that are not saved.</p></Dialog>
      )}
    </>
  );
}
