import React, { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, fmtTime, nowMs } from "../lib";
import { Dialog, Empty, Field, Spinner, useToast } from "../ui";
import { PageHeader, useAuth } from "../App";

const TABS = [["upcoming", "Upcoming"], ["unconfirmed", "Unconfirmed"], ["past", "Past"], ["cancelled", "Cancelled"]] as const;
const EMPTY: Record<string, [string, string]> = {
  upcoming: ["Nothing coming up", "Share your booking page so people can pick a time. New bookings show up here."], unconfirmed: ["Nothing waiting for you", "Requests that need your OK show up here."],
  past: ["No past bookings", "Meetings that have ended show up here."], cancelled: ["No cancelled bookings", "Cancelled and declined bookings show up here."],
};

const RSVP: Record<string, [string, string]> = { ACCEPTED: ["Accepted", "ok"], TENTATIVE: ["Maybe", "warn"], DECLINED: ["Declined", "red"], "NEEDS-ACTION": ["No reply", ""], DELEGATED: ["Delegated", ""] };

function dayHeading(iso: string, tz: string) {
  const d = DateTime.fromISO(iso, { zone: tz }).startOf("day"); const t = DateTime.fromMillis(nowMs(), { zone: tz }).startOf("day");
  const diff = Math.round(d.diff(t, "days").days);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toFormat(d.year === t.year ? "ccc, LLL d" : "ccc, LLL d, yyyy");
}

export function Bookings() {
  const { status = "upcoming" } = useParams(); const { me } = useAuth(); const toast = useToast();
  const [data, setData] = useState<{ items: any[]; nextCursor: string | null; counts: Record<string, number> } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "cancel" | "decline"; b: any } | null>(null); const [reason, setReason] = useState("");
  const load = async (cursor?: string) => {
    try { const r = await api(`/api/bookings?status=${status}${cursor ? `&cursor=${cursor}` : ""}`); setData((d) => cursor && d ? { ...r, items: [...d.items, ...r.items] } : r); } catch (e: any) { toast(e.message); }
  };
  useEffect(() => { setData(null); load(); }, [status]);
  async function act(path: string, body?: any) { try { await api(path, { body: body ?? {} }); setDialog(null); await load(); toast("Done"); } catch (e: any) { toast(e.message); } }
  const tz = me.time_zone, f = me.time_format;
  let lastHead = "";
  return (
    <>
      <PageHeader title="Bookings" subtitle="Meetings people have booked with you." />
      <nav className="tabs" aria-label="Booking tabs">{TABS.map(([k, l]) => <NavLink key={k} to={`/bookings/${k}`} className={({ isActive }) => isActive ? "active" : ""}>{l}{data && <span className="count">{data.counts[k]}</span>}</NavLink>)}</nav>
      {!data ? <Spinner /> : data.items.length === 0 ? <div className="panel"><Empty icon="inbox" title={EMPTY[status][0]} line={EMPTY[status][1]} action={status === "upcoming" ? <a className="btn" href={`/${me.username}`} target="_blank" rel="noopener">Open your booking page</a> : undefined} /></div> : (
        <div className="panel booking-list">
          {data.items.map((b) => {
            const head = dayHeading(b.start_utc, tz); const showHead = head !== lastHead; lastHead = head;
            return (
              <React.Fragment key={b.uid}>
                {showHead && <h3 className="day-head">{head}</h3>}
                <div className="booking-row" data-uid={b.uid}>
                  <div className="b-time"><span className="bar" style={{ background: b.color }} /><strong>{fmtTime(b.start_utc, tz, f)} - {fmtTime(b.end_utc, tz, f)}</strong></div>
                  <div className="b-main">
                    <strong>{b.title} with {b.booker_name}</strong>
                    <div className="muted">{b.booker_email}{b.guests.length ? `, ${b.guests.join(", ")}` : ""}</div>
                    {b.location && <div className="muted small">{b.location}</div>}
                    {b.notes && <div className="muted small notes">"{b.notes}"</div>}
                    {b.participants && (
                      <ul className="rsvps" aria-label="Replies">
                        {b.participants.map((p: any) => {
                          const [label, tone] = RSVP[p.partstat] ?? ["No reply", ""];
                          return <li key={p.email}><span className="muted small">{p.role === "host" ? "You" : p.name}</span> <span className={`badge ${tone}`}>{label}</span>{p.comment && <span className="muted small"> "{p.comment}"</span>}</li>;
                        })}
                      </ul>
                    )}
                    {b.pendingChange && status === "upcoming" && (
                      <div className="notice" role="status">
                        {b.pendingChange.proposerRole === "host" ? "You" : b.pendingChange.proposerName} proposed a new time: {dayHeading(b.pendingChange.start, tz)} {fmtTime(b.pendingChange.start, tz, f)} - {fmtTime(b.pendingChange.end, tz, f)}.
                        {" "}Waiting for {b.pendingChange.proposerRole === "host" ? b.pendingChange.counterpartName : "you"} to accept or decline it in {b.pendingChange.proposerRole === "host" ? "their" : "your"} calendar. Both times are held until then.
                      </div>
                    )}
                    <div className="badges">
                      {b.status === "pending" && <span className="badge warn">Needs approval</span>}
                      {b.from_uid && <span className="badge">Moved</span>}
                      {b.status === "rejected" && <span className="badge red">Declined</span>}
                      {b.status === "cancelled" && !b.rescheduled && <span className="badge red">{b.cancelled_by === "host" ? "Cancelled by host" : "Cancelled by guest"}</span>}
                      {b.status === "cancelled" && !!b.rescheduled && <span className="badge">Rescheduled</span>}
                    </div>
                  </div>
                  <div className="b-actions">
                    {status === "upcoming" && <><a className="btn" href={`/${me.username}/${b.event_slug}?reschedule=${b.uid}&host=1`}>Reschedule</a><button className="btn" onClick={() => { setReason(""); setDialog({ kind: "cancel", b }); }}>Cancel</button></>}
                    {status === "unconfirmed" && <><button className="btn primary" onClick={() => act(`/api/bookings/${b.uid}/accept`)}>Accept</button><button className="btn" onClick={() => { setReason(""); setDialog({ kind: "decline", b }); }}>Decline</button><a className="btn" href={`/${me.username}/${b.event_slug}?reschedule=${b.uid}&host=1`}>Reschedule</a></>}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {data.nextCursor && <button className="btn load-more" onClick={() => load(data.nextCursor!)}>Load more</button>}
        </div>
      )}
      {dialog && (
        <Dialog title={dialog.kind === "cancel" ? "Cancel this booking?" : "Decline this request?"} onClose={() => setDialog(null)} footer={<><button className="btn" onClick={() => setDialog(null)}>Keep it</button><button className="btn danger-fill" onClick={() => act(`/api/bookings/${dialog.b.uid}/${dialog.kind}`, { reason })}>{dialog.kind === "cancel" ? "Cancel booking" : "Decline"}</button></>}>
          <p>{dialog.b.title} with {dialog.b.booker_name}, {dayHeading(dialog.b.start_utc, tz)} at {fmtTime(dialog.b.start_utc, tz, f)}.</p>
          <Field label="Reason (optional)" htmlFor="reason"><textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </Dialog>
      )}
    </>
  );
}
