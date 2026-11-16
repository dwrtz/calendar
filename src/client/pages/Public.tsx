import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, browserTz, fmtDay, fmtTime, initials, isZoneOk, LOCATION_LABEL, nowMs, settings, SHORT, weekOrder, type ApiError } from "../lib";
import { Field, Icon, Spinner, TimezoneSelect, useToast } from "../ui";

function useDocTitle(t: string) { useEffect(() => { document.title = t ? `${t} | ${settings.appName}` : settings.appName; }, [t]); }
function Footer() { return <div className="booker-foot">Booked with <strong>{settings.appName}</strong></div>; }
function NotFound({ msg }: { msg: string }) { return <div className="public-page"><div className="panel notfound"><h1>{msg}</h1><p className="muted">Check the link and try again.</p></div><Footer /></div>; }

export function Profile() {
  const { username } = useParams(); const [d, setD] = useState<any>(); const [err, setErr] = useState("");
  useEffect(() => { api(`/api/public/users/${username}`).then(setD).catch((e) => setErr(e.message)); }, [username]);
  useDocTitle(d?.user.name || "");
  if (err) return <NotFound msg="Nobody here by that name" />;
  if (!d) return <div className="centre"><Spinner /></div>;
  const first = d.user.name.split(" ")[0];
  return (
    <div className="public-page">
      <div className="profile-head"><div className="avatar big">{initials(d.user.name)}</div><h1>{d.user.name}</h1>{d.user.bio && <p className="muted">{d.user.bio}</p>}</div>
      {d.eventTypes.length > 0 && <div className="profile-intro"><h2>Choose a meeting type</h2><p className="muted">Pick the kind of meeting you'd like with {first}. Next you'll choose a date and time.</p></div>}
      <ul className="panel rows profile-list" aria-label="Meeting types">
        {d.eventTypes.length === 0 && <li className="row empty-row"><div><strong className="plain">Nothing to book right now</strong><p className="muted">{first} has no meeting types open for booking. Check back later.</p></div></li>}
        {d.eventTypes.map((e: any) => (
          <li key={e.slug}><Link className="row row-link" to={`/${username}/${e.slug}`} aria-label={`${e.title}, ${e.durationMin} minutes. Choose a time`}><div className="row-main"><strong>{e.title}</strong>{e.description && <p className="muted clamp2">{e.description}</p>}<div className="badges"><span className="badge"><Icon name="clock" size={12} />{e.durationMin} min</span><span className="badge"><Icon name={e.locationKind === "phone" ? "phone" : e.locationKind === "video" ? "video" : "pin"} size={12} />{LOCATION_LABEL[e.locationKind]}</span></div></div><span className="row-cta">Choose a time<Icon name="right" /></span></Link></li>
        ))}
      </ul>
      <Footer />
    </div>
  );
}

const TZ_KEY = "booker.tz", TF_KEY = "booker.timeFormat";
function storedTz() { const z = localStorage.getItem(TZ_KEY); return z && isZoneOk(z) ? z : browserTz(); }

export function Booker() {
  const { username, slug } = useParams(); const [sp, setSp] = useSearchParams(); const nav = useNavigate(); const toast = useToast();
  const [ev, setEv] = useState<any>(); const [err, setErr] = useState(""); const [old, setOld] = useState<any>(null); const [oldErr, setOldErr] = useState("");
  const [tz, setTzState] = useState(storedTz);
  const [tf, setTf] = useState<12 | 24 | null>(() => { const v = localStorage.getItem(TF_KEY); return v === "12" ? 12 : v === "24" ? 24 : null; });
  const [slots, setSlots] = useState<Record<string, string[]> | null>(null); const [reload, setReload] = useState(0);
  const reschedule = sp.get("reschedule"); const asHost = !!reschedule && sp.get("host") === "1";
  useEffect(() => { api(`/api/public/users/${username}/events/${slug}`).then(setEv).catch((e) => setErr(e.message)); }, [username, slug]);
  useEffect(() => { if (reschedule) api(`/api/public/bookings/${reschedule}`).then((b) => { if (!["accepted", "pending"].includes(b.status)) setOldErr("This booking was cancelled, so it can't be moved."); else if (Date.parse(b.start_utc) <= nowMs()) setOldErr("This booking has already started, so it can't be moved."); else setOld(b); }).catch(() => setOldErr("We couldn't find that booking.")); }, [reschedule]);
  useDocTitle(ev?.title || "");
  const timeFormat: 12 | 24 = tf ?? ev?.user.timeFormat ?? 12;
  const today = DateTime.fromMillis(nowMs(), { zone: tz }).startOf("day");
  const monthParam = sp.get("month");
  // When moving a booking, open on the month of the current booking unless the visitor picked a month.
  const oldDay = old ? DateTime.fromISO(old.start_utc, { zone: tz }).toISODate() : null;
  const month = useMemo(() => { const m = monthParam ? DateTime.fromFormat(monthParam, "yyyy-MM", { zone: tz }) : oldDay ? DateTime.fromISO(oldDay, { zone: tz }) : null; return m && m.isValid && m >= today.startOf("month") ? m.startOf("month") : today.startOf("month"); }, [monthParam, tz, oldDay]);
  const date = sp.get("date"); const slot = sp.get("slot");
  function setParams(p: Record<string, string | null>, replace = false) {
    const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(p)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace });
  }
  useEffect(() => {
    if (!ev || (reschedule && !old && !oldErr)) return; if (oldErr) return;
    setSlots(null);
    const start = month.toUTC().toISO()!, end = month.plus({ months: 1 }).toUTC().toISO()!;
    let live = true;
    api(`/api/public/slots?username=${username}&slug=${slug}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&tz=${encodeURIComponent(tz)}${reschedule ? `&reschedule=${reschedule}` : ""}`)
      .then((r) => { if (live) setSlots(r.slots); }).catch((e) => toast(e.message));
    return () => { live = false; };
  }, [ev, month.toISODate(), tz, reload, old, oldErr]);
  const freeDays = slots ? Object.keys(slots).filter((d) => slots[d].length && d.startsWith(month.toFormat("yyyy-MM"))).sort() : [];
  useEffect(() => { if (slots && !slot && (!date || !date.startsWith(month.toFormat("yyyy-MM")))) { const pick = oldDay && freeDays.includes(oldDay) ? oldDay : freeDays[0]; if (pick) setParams({ month: month.toFormat("yyyy-MM"), date: pick }, true); } }, [slots]);
  function setTz(z: string) { localStorage.setItem(TZ_KEY, z); setTzState(z); setParams({ date: null, slot: null, month: null }, true); }
  if (err) return <NotFound msg={err} />;
  if (!ev) return <div className="centre"><Spinner /></div>;
  if (oldErr) return <div className="public-page"><div className="panel notfound"><h1>{oldErr}</h1><Link className="btn primary" to={`/${username}/${slug}`}>Book a new time</Link></div><Footer /></div>;
  const order = weekOrder(ev.user.weekStart);
  const lead = order.indexOf(month.weekday % 7);
  const days = Array.from({ length: month.daysInMonth! }, (_, i) => month.plus({ days: i }));
  const daySlots = date && slots ? slots[date] || [] : [];
  const selDay = date ? DateTime.fromISO(date, { zone: tz }) : null;
  const slotValid = slot && !Number.isNaN(Date.parse(slot));
  const details = (
    <div className="b-details">
      <div className="avatar">{initials(ev.user.name)}</div>
      <div className="muted host-name">{ev.user.name}</div>
      <h1>{ev.title}</h1>
      {ev.description && <p className="desc">{ev.description}</p>}
      {old && <div className="resched-note" role="note"><strong>{asHost ? `Moving ${old.booker_name}'s booking` : "Rescheduling your booking"}</strong><span>Pick a new date and time. The current time stays booked until you confirm the new one.</span></div>}
      {old && <p className="was"><span className="muted">Current time: </span><s>{fmtDay(old.start_utc, tz)} {fmtTime(old.start_utc, tz, timeFormat)} - {fmtTime(old.end_utc, tz, timeFormat)}</s></p>}
      {slotValid && <div className="meta-line chosen"><Icon name="calendar" /><div><div>{fmtDay(slot!, tz)}</div><div>{fmtTime(slot!, tz, timeFormat)} - {fmtTime(Date.parse(slot!) + ev.duration_min * 60000, tz, timeFormat)}</div></div></div>}
      <div className="meta-line"><Icon name="clock" />{ev.duration_min}m</div>
      <div className="meta-line"><Icon name={ev.location_kind === "phone" ? "phone" : ev.location_kind === "video" ? "video" : "pin"} />{LOCATION_LABEL[ev.location_kind]}</div>
      {!!ev.requires_approval && <div className="meta-line"><Icon name="check" />Needs approval</div>}
      <div className="meta-line"><Icon name="globe" /><TimezoneSelect plain label="Your time zone" value={tz} onChange={setTz} /></div>
    </div>
  );
  return (
    <div className="public-page booker-page">
      <div className={"booker panel" + (slotValid ? " form-mode" : "")}>
        {details}
        {slotValid ? <BookingForm ev={ev} username={username!} slug={slug!} slot={slot!} tz={tz} old={old} asHost={asHost} onBack={() => setParams({ slot: null })}
          onTaken={() => { setParams({ slot: null }); setReload((x) => x + 1); }} onDone={(uid) => { if (asHost) { toast("Booking moved"); nav("/bookings/upcoming"); } else nav(`/booking/${uid}`); }} /> : <>
          <div className="b-cal">
            <h2 className="step-title">{old ? "Select a new date" : "Select a date"}</h2>
            <div className="cal-head"><div className="month-title"><strong>{month.toFormat("LLLL")}</strong> {month.toFormat("yyyy")}</div><div>
              <button type="button" className="icon-btn" aria-label="Previous month" disabled={month <= today.startOf("month")} onClick={() => setParams({ month: month.minus({ months: 1 }).toFormat("yyyy-MM"), date: null })}><Icon name="left" /></button>
              <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setParams({ month: month.plus({ months: 1 }).toFormat("yyyy-MM"), date: null })}><Icon name="right" /></button></div></div>
            <div className="cal-grid big" aria-busy={!slots}>
              {order.map((d) => <div key={d} className="wd">{SHORT[d].toUpperCase()}</div>)}
              {Array.from({ length: lead }, (_, i) => <div key={"e" + i} />)}
              {days.map((d) => { const iso = d.toISODate()!; const free = !!slots?.[iso]?.length; const isToday = iso === today.toISODate();
                return <button key={iso} type="button" disabled={!free} aria-pressed={date === iso} aria-label={d.toFormat("cccc, LLLL d, yyyy")}
                  className={"day" + (free ? " free" : "") + (date === iso ? " sel" : "") + (isToday ? " today" : "")} onClick={() => setParams({ month: month.toFormat("yyyy-MM"), date: iso, slot: null })}>{d.day}</button>; })}
              {slots && freeDays.length === 0 && <div className="cal-full"><p>This month is fully booked</p><button className="btn" onClick={() => setParams({ month: month.plus({ months: 1 }).toFormat("yyyy-MM"), date: null })}>View next month</button></div>}
              {!slots && <div className="cal-loading"><Spinner /></div>}
            </div>
          </div>
          <div className="b-times">
            <h2 className="step-title">Select a time</h2>
            <div className="times-head"><div>{selDay ? <><strong>{selDay.toFormat("ccc")}</strong> {selDay.toFormat("d")}</> : <span className="muted">No date picked</span>}</div>
              <div className="seg" role="group" aria-label="Time format">{([12, 24] as const).map((v) => <button key={v} type="button" aria-pressed={timeFormat === v} className={timeFormat === v ? "on" : ""} onClick={() => { localStorage.setItem(TF_KEY, String(v)); setTf(v); }}>{v}h</button>)}</div></div>
            <div className="times-list" role="group" aria-label={selDay ? `Times on ${selDay.toFormat("cccc, LLLL d")}` : "Times"}>
              {!date && <p className="muted">Pick a highlighted date to see open times.</p>}
              {date && slots && daySlots.length === 0 && <p className="muted">No times left on this day. Try another highlighted date.</p>}
              {daySlots.map((s) => <button key={s} type="button" className="time-btn" aria-label={`${fmtTime(s, tz, timeFormat)}, ${fmtDay(s, tz)}`} onClick={() => setParams({ slot: s })}>{fmtTime(s, tz, timeFormat)}</button>)}
            </div>
          </div>
        </>}
      </div>
      <Footer />
    </div>
  );
}

function BookingForm({ ev, username, slug, slot, tz, old, asHost, onBack, onTaken, onDone }: { ev: any; username: string; slug: string; slot: string; tz: string; old: any; asHost: boolean; onBack: () => void; onTaken: () => void; onDone: (uid: string) => void }) {
  const toast = useToast();
  const [b, setB] = useState({ name: old?.booker_name ?? "", email: old?.booker_email ?? "", phone: old?.booker_phone ?? "", notes: old?.notes ?? "", reason: "" });
  const [guests, setGuests] = useState<string[]>(old?.guests ?? []);
  const [fields, setFields] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [taken, setTaken] = useState("");
  const set = (k: string, v: string) => setB({ ...b, [k]: v });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setFields({}); setTaken("");
    try {
      const r = await api("/api/public/bookings", { body: asHost ? { username, slug, start: slot, reschedule: old.uid, asHost: true, rescheduleReason: b.reason } : { username, slug, start: slot, name: b.name, email: b.email, phone: b.phone || undefined, notes: b.notes, guests: guests.filter(Boolean), timeZone: tz, reschedule: old?.uid, rescheduleReason: old ? b.reason : undefined } });
      onDone(r.uid);
    } catch (er) {
      const x = er as ApiError;
      if (x.status === 409) { setTaken(x.message); toast(x.message); setTimeout(onTaken, 1200); }
      else { setFields(x.fields || {}); toast(x.message); }
      setBusy(false);
    }
  }
  const label = old ? "Move booking" : ev.requires_approval ? "Request booking" : "Book it";
  if (asHost) return (
    <form className="b-form" onSubmit={submit} noValidate>
      <h2 className="step-title">Confirm the new time</h2>
      <p className="muted">{old.booker_name} ({old.booker_email}) keeps the same details. The old time is released when you move it.</p>
      {taken && <div className="alert" role="alert">{taken}</div>}
      <Field label="Reason for change" htmlFor="bf-reason"><textarea id="bf-reason" rows={2} value={b.reason} onChange={(e) => set("reason", e.target.value)} /></Field>
      <div className="form-actions"><button type="button" className="btn" onClick={onBack}>Back</button><button className="btn primary" disabled={busy}>{busy && <Spinner />}{label}</button></div>
    </form>
  );
  return (
    <form className="b-form" onSubmit={submit} noValidate>
      <h2 className="step-title">{old ? "Confirm your new time" : "Enter your details"}</h2>
      <p className="muted small">{old ? "Check your details, then move the booking. Your old time is released when you do." : ev.requires_approval ? `${ev.user.name} confirms requests for this meeting. You'll see the status on the next page.` : "Fill these in to book the time shown."}</p>
      {taken && <div className="alert" role="alert">{taken}</div>}
      <Field label="Your name *" htmlFor="bf-name" error={fields.name}><input id="bf-name" autoComplete="name" required value={b.name} onChange={(e) => set("name", e.target.value)} /></Field>
      <Field label="Email *" htmlFor="bf-email" error={fields.email}><input id="bf-email" type="email" autoComplete="email" required value={b.email} onChange={(e) => set("email", e.target.value)} /></Field>
      {ev.location_kind === "phone" && <Field label="Phone number *" htmlFor="bf-phone" error={fields.phone}><input id="bf-phone" type="tel" autoComplete="tel" required value={b.phone} onChange={(e) => set("phone", e.target.value)} /></Field>}
      <Field label="Anything we should know?" htmlFor="bf-notes" error={fields.notes}><textarea id="bf-notes" rows={3} maxLength={1000} value={b.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      {!ev.hide_guests && <div className="guests">
        {guests.map((g, i) => <div key={i} className="guest-row"><input aria-label={`Guest email ${i + 1}`} type="email" value={g} onChange={(e) => setGuests(guests.map((x, j) => j === i ? e.target.value : x))} /><button type="button" className="icon-btn" aria-label={`Remove guest ${i + 1}`} onClick={() => setGuests(guests.filter((_, j) => j !== i))}><Icon name="x" /></button></div>)}
        {fields.guests && <div className="err">{fields.guests}</div>}
        {guests.length < 10 && <button type="button" className="link-btn" onClick={() => setGuests([...guests, ""])}>+ Add guests</button>}
      </div>}
      {old && <Field label="Reason for change" htmlFor="bf-reason"><textarea id="bf-reason" rows={2} value={b.reason} onChange={(e) => set("reason", e.target.value)} /></Field>}
      <div className="form-actions"><button type="button" className="btn" onClick={onBack}>Back</button><button className="btn primary" disabled={busy}>{busy && <Spinner />}{label}</button></div>
    </form>
  );
}

export function BookingPage() {
  const { uid } = useParams(); const toast = useToast();
  const [b, setB] = useState<any>(); const [err, setErr] = useState(""); const [cancelling, setCancelling] = useState(false); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const tz = storedTz();
  useEffect(() => { api(`/api/public/bookings/${uid}`).then(setB).catch((e) => setErr(e.message)); }, [uid]);
  useDocTitle(b?.title || "");
  if (err) return <NotFound msg="We couldn't find that booking" />;
  if (!b) return <div className="centre"><Spinner /></div>;
  const tf: 12 | 24 = (Number(localStorage.getItem(TF_KEY)) as 12 | 24) || 12;
  const cancelled = ["cancelled", "rejected"].includes(b.status);
  const started = Date.parse(b.start_utc) <= nowMs();
  const pending = b.status === "pending";
  const heading = cancelled ? (b.rescheduled ? "This booking was moved" : b.status === "rejected" ? "This request was declined" : "This booking was cancelled") : b.from_uid ? "Booking moved" : pending ? "Request sent" : "You're booked";
  const host = b.host_name;
  const line = cancelled
    ? (b.rescheduled ? (b.cancelled_by === "host" ? `${host} moved this meeting to a new time.` : "It now has a new time. This old time is released.")
      : b.status === "rejected" ? `${host} can't make this one. You can pick another time.` : b.cancelled_by === "host" ? `${host} cancelled this meeting.` : `It's cancelled, and ${host} can see that in their bookings.`)
    : started ? "This meeting has started or already happened."
    : pending ? `${host} needs to confirm this request. Come back to this page to see if it's confirmed.`
    : b.from_uid ? `Your meeting with ${host} is now at the time below. The old time is cancelled.`
    : `Your meeting with ${host} is confirmed.`;
  const isUrl = /^https?:\/\//i.test(b.location || "");
  const where = isUrl ? <a href={b.location} target="_blank" rel="noopener noreferrer">{b.location}</a> : b.location === "Video call" ? <>Video call <span className="muted">({host} will share the link)</span></> : (b.location || "-");
  async function copyLink() { await navigator.clipboard?.writeText(location.href).catch(() => {}); toast("Link copied"); }
  async function doCancel() {
    setBusy(true);
    try { setB(await api(`/api/public/bookings/${uid}/cancel`, { body: { reason } })); setCancelling(false); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="public-page">
      <div className="panel booking-card">
        <div className={"status-icon " + (cancelled ? "red" : pending ? "grey" : "green")}><Icon name={cancelled ? "x" : pending ? "clock" : "check"} size={26} /></div>
        <h1>{heading}</h1>{line && <p className="muted">{line}</p>}
        {cancelled && b.cancel_reason && <p className="muted">Reason: {b.cancel_reason}</p>}
        <dl className="b-grid">
          <dt>What</dt><dd>{b.title}</dd>
          <dt>When</dt><dd className={cancelled ? "struck" : ""}>{fmtDay(b.start_utc, tz)}<br />{fmtTime(b.start_utc, tz, tf)} - {fmtTime(b.end_utc, tz, tf)} <span className="muted">({tz.replace(/_/g, " ")})</span></dd>
          <dt>Who</dt><dd><div>{b.host_name} <span className="badge">Host</span></div><div className="muted">{b.host_email}</div><div>{b.booker_name}</div><div className="muted">{b.booker_email}</div>{b.guests.map((g: string) => <div key={g} className="muted">{g}</div>)}</dd>
          <dt>Where</dt><dd>{where}</dd>
          {b.notes && <><dt>Notes</dt><dd>{b.notes}</dd></>}
        </dl>
        {!cancelled && !started && <div className="next-steps" role="note"><strong>What's next</strong><span>{b.emailEnabled ? "We've emailed you the details. You can also copy this page's link or add the meeting to your calendar, and use this page to reschedule or cancel later." : "No confirmation email is sent, so keep this page: copy its link, or add the meeting to your calendar. Use this page to reschedule or cancel later."}</span>
          <div className="next-actions"><button type="button" className="btn" onClick={copyLink}>Copy link to this page</button>{!cancelled && <a className="btn" href={`/api/public/bookings/${b.uid}/ics`} download>Add to calendar</a>}</div></div>}
        {!cancelled && !started && !cancelling && <div className="change-line">Need a change? <Link to={`/${b.host_username}/${b.event_slug}?reschedule=${b.uid}`}>Reschedule</Link> or <button type="button" className="link-btn" onClick={() => setCancelling(true)}>Cancel</button></div>}
        {cancelling && <div className="cancel-box"><p><strong>Cancel this booking?</strong> {host} will see it's cancelled and the time opens up again. This can't be undone.</p><Field label="Reason (optional)" htmlFor="c-reason"><textarea id="c-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="form-actions"><button className="btn" onClick={() => setCancelling(false)}>Keep it</button><button className="btn danger-fill" disabled={busy} onClick={doCancel}>{busy && <Spinner />}Cancel booking</button></div></div>}
        {cancelled && b.movedToUid && <div className="change-line"><Link to={`/booking/${b.movedToUid}`}>See the new time</Link></div>}
        {cancelled && !b.movedToUid && !b.event_deleted && <div className="change-line"><Link to={`/${b.host_username}/${b.event_slug}`}>Book another time</Link></div>}
        {!cancelled && started && <div className="change-line"><a href={`/api/public/bookings/${b.uid}/ics`} download>Add to calendar</a></div>}
      </div>
      <Footer />
    </div>
  );
}
