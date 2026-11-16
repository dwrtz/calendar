import React, { useEffect, useState } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { api, type ApiError } from "../lib";
import { Field, Spinner, TimezoneSelect, useToast } from "../ui";
import { PageHeader, useAuth } from "../App";
import { Calendars, Integrations } from "./Integrations";

export function Settings() {
  const { tab } = useParams(); const { me, reload } = useAuth(); const toast = useToast();
  const [b, setB] = useState<any>(me); const [fields, setFields] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { setB(me); setFields({}); }, [tab, me]);
  if (!["profile", "general", "calendars", "integrations"].includes(tab ?? "")) return <Navigate to="/settings/profile" replace />;
  const set = (k: string, v: any) => setB({ ...b, [k]: v });
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFields({});
    try { await api("/api/me", { method: "PATCH", body: b }); await reload(); toast("Saved"); } catch (er) { const x = er as ApiError; setFields(x.fields || {}); toast(x.message); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Settings" subtitle={tab === "profile" ? "How you appear to people who book you." : tab === "calendars" ? "Keep busy times from your own calendar off your booking pages." : tab === "integrations" ? "Email, calendar invites and calendar sync." : "Time zone and how times are shown."} />
      <div className="settings-layout">
        <nav className="sub-nav" aria-label="Settings"><NavLink to="/settings/profile">Profile</NavLink><NavLink to="/settings/general">General</NavLink><NavLink to="/settings/calendars">Calendars</NavLink><NavLink to="/settings/integrations">Integrations</NavLink></nav>
        {tab === "calendars" ? <Calendars /> : tab === "integrations" ? <Integrations /> : <form className="panel form-panel" onSubmit={save}>
          {tab === "profile" ? <>
            <Field label="Name" htmlFor="s-name" error={fields.name}><input id="s-name" value={b.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Username" htmlFor="s-user" error={fields.username} help={b.username !== me.username ? "Your public links will change, and old links will stop working." : `${location.origin}/${b.username}`}><input id="s-user" value={b.username} onChange={(e) => set("username", e.target.value.toLowerCase())} /></Field>
            <Field label="Email" htmlFor="s-email" error={fields.email}><input id="s-email" type="email" value={b.email} onChange={(e) => set("email", e.target.value)} /></Field>
            <Field label="About you" htmlFor="s-bio" error={fields.bio} help={`${(b.bio || "").length}/300`}><textarea id="s-bio" rows={4} maxLength={300} value={b.bio} onChange={(e) => set("bio", e.target.value)} /></Field>
          </> : <>
            <Field label="Time zone" error={fields.time_zone}><TimezoneSelect value={b.time_zone} onChange={(z) => set("time_zone", z)} /></Field>
            <Field label="Time format" htmlFor="s-tf" error={fields.time_format}><select id="s-tf" value={b.time_format} onChange={(e) => set("time_format", Number(e.target.value))}><option value={12}>12 hour (9:00am)</option><option value={24}>24 hour (09:00)</option></select></Field>
            <Field label="Week starts on" htmlFor="s-ws" error={fields.week_start}><select id="s-ws" value={b.week_start} onChange={(e) => set("week_start", e.target.value)}><option value="monday">Monday</option><option value="sunday">Sunday</option></select></Field>
          </>}
          <button className="btn primary" disabled={busy}>{busy && <Spinner />}Save</button>
        </form>}
      </div>
    </>
  );
}
