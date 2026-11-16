import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DateTime } from "luxon";
import { api, DAY_NAMES, fmtMin, nowMs, summarize, weekOrder, SHORT, type ApiError } from "../lib";
import { Dialog, Empty, Field, Icon, Menu, Spinner, Switch, TimezoneSelect, useToast } from "../ui";
import { PageHeader, useAuth } from "../App";

type Range = { startMin: number; endMin: number };
const STARTS = Array.from({ length: 96 }, (_, i) => i * 15);
const ENDS = Array.from({ length: 96 }, (_, i) => (i + 1) * 15);

export function ScheduleList() {
  const { me } = useAuth(); const toast = useToast(); const nav = useNavigate();
  const [list, setList] = useState<any[] | null>(null); const [naming, setNaming] = useState(false); const [name, setName] = useState("");
  const load = () => api("/api/schedules").then(setList).catch((e) => toast(e.message));
  useEffect(() => { load(); }, []);
  async function act(fn: () => Promise<any>) { try { await fn(); await load(); } catch (e: any) { toast(e.message); } }
  return (
    <>
      <PageHeader title="Availability" subtitle="When people can book you." action={<button className="btn primary" onClick={() => { setName(""); setNaming(true); }}><Icon name="plus" />New</button>} />
      {list === null ? <Spinner /> : list.length === 0 ? <div className="panel"><Empty icon="clock" title="No schedules" line="Add the hours you can meet." /></div> : (
        <ul className="panel rows" aria-label="Schedules">
          {list.map((s) => (
            <li key={s.id} className="row">
              <Link to={`/availability/${s.id}`} className="row-main">
                <strong>{s.name}</strong> {s.isDefault && <span className="badge">Default</span>}
                <div className="muted">{summarize(s.hours, me.time_format, me.week_start)}</div>
                <div className="muted small"><Icon name="globe" size={12} /> {s.timeZone}</div>
              </Link>
              <Menu label={`More for ${s.name}`} items={[
                { label: "Set as default", disabled: s.isDefault, onClick: () => act(() => api(`/api/schedules/${s.id}`, { method: "PATCH", body: { isDefault: true } })) },
                { label: "Duplicate", onClick: () => act(() => api(`/api/schedules/${s.id}/duplicate`, { method: "POST" })) },
                { label: "Delete", danger: true, disabled: s.isDefault || list.length === 1, onClick: () => act(() => api(`/api/schedules/${s.id}`, { method: "DELETE" })) },
              ]} />
            </li>
          ))}
        </ul>
      )}
      {naming && (
        <Dialog title="New schedule" onClose={() => setNaming(false)}>
          <form onSubmit={async (e) => { e.preventDefault(); try { const s = await api("/api/schedules", { body: { name } }); nav(`/availability/${s.id}`); } catch (er: any) { toast(er.message); } }}>
            <Field label="Name" htmlFor="sname"><input id="sname" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Evenings" /></Field>
            <div className="dialog-foot"><button type="button" className="btn" onClick={() => setNaming(false)}>Close</button><button className="btn primary">Continue</button></div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function rangeProblem(rs: Range[]) {
  const a = [...rs].sort((x, y) => x.startMin - y.startMin);
  if (a.some((r) => r.endMin <= r.startMin)) return "End must be after start";
  if (a.some((r, i) => i > 0 && r.startMin < a[i - 1].endMin)) return "Times overlap";
  return "";
}

function RangeEditor({ ranges, onChange, label, f, extra }: { ranges: Range[]; onChange: (r: Range[]) => void; label: string; f: 12 | 24; extra?: React.ReactNode }) {
  function add() {
    const last = ranges[ranges.length - 1];
    const s = last ? last.endMin + 60 : 540;
    if (s + 60 > 1440) { onChange([...ranges, { startMin: Math.max(0, 1440 - 60), endMin: 1440 }]); return; }
    onChange([...ranges, { startMin: s, endMin: s + 60 }]);
  }
  return (
    <div className="ranges">
      {ranges.map((r, i) => (
        <div className="range" key={i}>
          <select aria-label={`${label} start ${i + 1}`} value={r.startMin} onChange={(e) => onChange(ranges.map((x, j) => j === i ? { ...x, startMin: Number(e.target.value) } : x))}>{STARTS.map((m) => <option key={m} value={m}>{fmtMin(m, f)}</option>)}</select>
          <span>-</span>
          <select aria-label={`${label} end ${i + 1}`} value={r.endMin} onChange={(e) => onChange(ranges.map((x, j) => j === i ? { ...x, endMin: Number(e.target.value) } : x))}>{ENDS.map((m) => <option key={m} value={m}>{fmtMin(m, f, true)}</option>)}</select>
          {i === 0 && <button type="button" className="icon-btn" aria-label={`Add range to ${label}`} onClick={add}><Icon name="plus" /></button>}
          {i === 0 && extra}
          <button type="button" className="icon-btn" aria-label={`Remove range ${i + 1} from ${label}`} onClick={() => onChange(ranges.filter((_, j) => j !== i))}><Icon name="trash" /></button>
        </div>
      ))}
    </div>
  );
}

function CopyTimes({ day, order, onApply }: { day: number; order: number[]; onApply: (days: number[]) => void }) {
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<number[]>([]);
  return (
    <span className="menu-wrap">
      <button type="button" className="icon-btn" aria-label={`Copy ${DAY_NAMES[day]} times`} onClick={() => { setSel([]); setOpen(!open); }}><Icon name="copy" /></button>
      {open && (
        <div className="menu copy-pop" role="dialog" aria-label="Copy times to">
          <div className="small muted">Copy times to</div>
          {order.filter((d) => d !== day).map((d) => (
            <label key={d} className="check"><input type="checkbox" checked={sel.includes(d)} onChange={(e) => setSel(e.target.checked ? [...sel, d] : sel.filter((x) => x !== d))} />{DAY_NAMES[d]}</label>
          ))}
          <button type="button" className="btn primary small-btn" onClick={() => { onApply(sel); setOpen(false); }}>Apply</button>
        </div>
      )}
    </span>
  );
}

function MonthPicker({ selected, onToggle, tz, weekStart }: { selected: string[]; onToggle: (d: string) => void; tz: string; weekStart: string }) {
  const today = DateTime.fromMillis(nowMs(), { zone: tz }).startOf("day");
  const [month, setMonth] = useState(today.startOf("month"));
  const order = weekOrder(weekStart);
  const lead = order.indexOf(month.weekday % 7);
  const days = Array.from({ length: month.daysInMonth! }, (_, i) => month.plus({ days: i }));
  return (
    <div className="mini-cal">
      <div className="cal-head"><strong>{month.toFormat("LLLL yyyy")}</strong><span>
        <button type="button" className="icon-btn" aria-label="Previous month" disabled={month <= today.startOf("month")} onClick={() => setMonth(month.minus({ months: 1 }))}><Icon name="left" /></button>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth(month.plus({ months: 1 }))}><Icon name="right" /></button></span></div>
      <div className="cal-grid">{order.map((d) => <div key={d} className="wd">{SHORT[d]}</div>)}{Array.from({ length: lead }, (_, i) => <div key={"e" + i} />)}
        {days.map((d) => { const iso = d.toISODate()!; const past = d < today; return (
          <button key={iso} type="button" disabled={past} aria-pressed={selected.includes(iso)} aria-label={d.toFormat("cccc, LLLL d, yyyy")} className={"day" + (past ? "" : " free") + (selected.includes(iso) ? " sel" : "")} onClick={() => onToggle(iso)}>{d.day}</button>); })}
      </div>
    </div>
  );
}

export function ScheduleEditor() {
  const { id } = useParams(); const { me } = useAuth(); const toast = useToast();
  const [s, setS] = useState<any>(null); const [orig, setOrig] = useState<any>(null); const [busy, setBusy] = useState(false); const [ovOpen, setOvOpen] = useState(false);
  useEffect(() => { api(`/api/schedules/${id}`).then((x) => { setS(x); setOrig(x); }).catch((e) => toast(e.message)); }, [id]);
  const order = weekOrder(me.week_start);
  const byDay = (d: number) => (s?.hours || []).filter((h: any) => h.weekday === d).map((h: any) => ({ startMin: h.startMin, endMin: h.endMin }));
  const problems = useMemo(() => s ? Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, rangeProblem(byDay(d))])) : {}, [s]);
  if (!s) return <Spinner />;
  const setDay = (d: number, rs: Range[]) => setS({ ...s, hours: [...s.hours.filter((h: any) => h.weekday !== d), ...rs.map((r) => ({ weekday: d, ...r }))] });
  const today = DateTime.fromMillis(nowMs(), { zone: s.timeZone }).toISODate()!;
  const overrides = (s.overrides as any[]).filter((o) => o.date >= today);
  const ovDates = [...new Set(overrides.map((o) => o.date))].sort();
  const hasProblem = Object.values(problems).some(Boolean);
  const dirty = JSON.stringify(s) !== JSON.stringify(orig);
  async function save() {
    setBusy(true);
    try { const r = await api(`/api/schedules/${s.id}`, { method: "PATCH", body: s }); setS(r); setOrig(r); toast("Saved"); } catch (e) { toast((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <>
      <header className="page-header editor-head">
        <div className="head-left"><Link to="/availability" className="icon-btn" aria-label="Back to availability"><Icon name="back" /></Link>
          <input className="title-input" aria-label="Schedule name" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></div>
        <div className="head-right"><label className="switch-label">Set as default <Switch label="Set as default" checked={s.isDefault} onChange={(v) => setS({ ...s, isDefault: v || orig.isDefault })} /></label>
          <button className="btn primary" disabled={busy || hasProblem || !dirty} onClick={save}>{busy && <Spinner />}Save</button></div>
      </header>
      <div className="sched-layout">
        <div>
          <div className="panel days" aria-label="Weekly hours">
            {order.map((d) => {
              const rs = byDay(d); const on = rs.length > 0;
              return (
                <div className={"day-row" + (problems[d] ? " bad" : "")} key={d}>
                  <Switch label={DAY_NAMES[d]} checked={on} onChange={(v) => setDay(d, v ? [{ startMin: 540, endMin: 1020 }] : [])} />
                  <span className="day-name">{DAY_NAMES[d]}</span>
                  {on ? <RangeEditor label={DAY_NAMES[d]} ranges={rs} f={me.time_format} onChange={(r) => setDay(d, r)} extra={<CopyTimes day={d} order={order} onApply={(days) => {
                    let hours = s.hours.filter((h: any) => !days.includes(h.weekday)); for (const t of days) hours = [...hours, ...rs.map((r: Range) => ({ weekday: t, ...r }))]; setS({ ...s, hours });
                  }} />} /> : <span className="muted">Unavailable</span>}
                  {problems[d] && <div className="err row-err" role="alert">{problems[d]}</div>}
                </div>
              );
            })}
          </div>
          <div className="panel overrides">
            <h2>Date overrides</h2><p className="muted">Different hours, or a day off, on chosen dates.</p>
            {ovDates.length === 0 ? <p className="muted small">No overrides yet.</p> : (
              <ul className="ov-list">{ovDates.map((d) => { const rs = overrides.filter((o) => o.date === d); return (
                <li key={d}><div><strong>{DateTime.fromISO(d).toFormat("ccc, LLL d, yyyy")}</strong><div className="muted">{rs[0].startMin === null ? "Unavailable" : rs.map((r: any) => `${fmtMin(r.startMin, me.time_format)} - ${fmtMin(r.endMin, me.time_format, true)}`).join(", ")}</div></div>
                  <button className="icon-btn" aria-label={`Remove override ${d}`} onClick={() => setS({ ...s, overrides: s.overrides.filter((o: any) => o.date !== d) })}><Icon name="trash" /></button></li>); })}</ul>
            )}
            <button className="btn" onClick={() => setOvOpen(true)}><Icon name="plus" />Add an override</button>
          </div>
        </div>
        <div className="panel tz-panel"><h2>Time zone</h2><TimezoneSelect value={s.timeZone} onChange={(z) => setS({ ...s, timeZone: z })} /></div>
      </div>
      {ovOpen && <OverrideDialog tz={s.timeZone} weekStart={me.week_start} f={me.time_format} onClose={() => setOvOpen(false)} onAdd={(dates, ranges) => {
        const rows: any[] = dates.flatMap((date): any[] => ranges ? ranges.map((r) => ({ date, ...r })) : [{ date, startMin: null, endMin: null }]);
        setS({ ...s, overrides: [...s.overrides.filter((o: any) => !dates.includes(o.date)), ...rows] }); setOvOpen(false);
      }} />}
    </>
  );
}

function OverrideDialog({ tz, weekStart, f, onClose, onAdd }: { tz: string; weekStart: string; f: 12 | 24; onClose: () => void; onAdd: (dates: string[], ranges: Range[] | null) => void }) {
  const [dates, setDates] = useState<string[]>([]); const [ranges, setRanges] = useState<Range[]>([{ startMin: 540, endMin: 1020 }]); const [off, setOff] = useState(false);
  const problem = off ? "" : ranges.length === 0 ? "Add a time range or mark the day unavailable" : rangeProblem(ranges);
  return (
    <Dialog wide title="Add an override" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={!dates.length || !!problem} onClick={() => onAdd(dates, off ? null : ranges)}>Add override</button></>}>
      <div className="ov-dialog">
        <MonthPicker tz={tz} weekStart={weekStart} selected={dates} onToggle={(d) => setDates(dates.includes(d) ? dates.filter((x) => x !== d) : [...dates, d])} />
        <div>
          <p className="small"><strong>Which hours are you free?</strong></p>
          {!off && <RangeEditor label="Override" ranges={ranges} f={f} onChange={setRanges} />}
          {problem && <div className="err">{problem}</div>}
          <label className="switch-label"><Switch label="Mark unavailable (all day)" checked={off} onChange={setOff} /> Mark unavailable (all day)</label>
        </div>
      </div>
    </Dialog>
  );
}
