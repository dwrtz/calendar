import React, { createContext, useContext, useEffect, useState } from "react";
import { createBrowserRouter, Link, Navigate, NavLink, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { api, browserTz, initials, settings, type ApiError } from "./lib";
import { Field, Icon, Menu, Spinner, ToastProvider, useToast } from "./ui";
import { EventEditor, EventList } from "./pages/EventTypes";
import { ScheduleEditor, ScheduleList } from "./pages/Availability";
import { Bookings } from "./pages/Bookings";
import { Settings } from "./pages/Settings";
import { Booker, BookingPage, Profile } from "./pages/Public";

export const AuthContext = createContext<{ me: any; reload: () => Promise<void> }>({ me: null, reload: async () => {} });
/** Session is only asked for by pages that need it, never by public pages. */
export const useAuth = () => { const c = useContext(AuthContext); useEffect(() => { if (c.me === undefined) c.reload(); }, []); return c; };

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<any>(undefined);
  async function reload() { try { setMe(await api("/api/me")); } catch { setMe(null); } }
  return <AuthContext.Provider value={{ me, reload }}>{children}</AuthContext.Provider>;
}

function Shell() {
  const { me, reload } = useAuth(); const navigate = useNavigate(); const loc = useLocation();
  if (me === undefined) return <div className="centre"><Spinner /></div>;
  if (!me) return <Navigate to="/login" replace />;
  const items = [{ href: "/event-types", name: "Event types", icon: "link" }, { href: "/bookings/upcoming", name: "Bookings", icon: "calendar" }, { href: "/availability", name: "Availability", icon: "clock" }, { href: "/settings/profile", name: "Settings", icon: "gear" }];
  const menu = [
    { label: "View public page", onClick: () => window.open(`/${me.username}`, "_blank", "noopener") },
    { label: "Sign out", onClick: async () => { await api("/api/auth/logout", { method: "POST" }); await reload(); navigate("/login"); } },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="wordmark" to="/event-types"><span className="mark">S</span>{settings.appName}</Link>
        <nav>{items.map((it) => <NavLink key={it.href} to={it.href} className={loc.pathname.startsWith("/" + it.href.split("/")[1]) ? "active" : ""} aria-current={loc.pathname.startsWith("/" + it.href.split("/")[1]) ? "page" : undefined}><Icon name={it.icon} size={18} />{it.name}</NavLink>)}</nav>
        <div className="side-user"><div className="avatar small">{initials(me.name)}</div><strong>{me.name}</strong><Menu label="User menu" items={menu} /></div>
      </aside>
      <div className="mobile-top"><Link className="wordmark" to="/event-types"><span className="mark">S</span>{settings.appName}</Link><Menu label="User menu" items={menu} /></div>
      <main className="app-main"><Outlet /></main>
    </div>
  );
}

function AuthPage({ signup = false }: { signup?: boolean }) {
  const { me, reload } = useAuth(); const nav = useNavigate(); const toast = useToast();
  const [b, setB] = useState({ name: "", email: "", username: "", password: "" });
  const [fields, setFields] = useState<Record<string, string>>({}); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const set = (key: string, value: string) => setB((b) => ({ ...b, [key]: value }));
  if (me) return <Navigate to="/event-types" replace />;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setFields({}); setErr(""); setBusy(true);
    try {
      await api(`/api/auth/${signup ? "signup" : "login"}`, { body: { ...b, timeZone: browserTz() } }); await reload(); nav("/event-types");
    } catch (e) { const er = e as ApiError; setFields(er.fields || {}); setErr(er.message); toast(er.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="auth-page"><div className="auth-card">
      <div className="wordmark"><span className="mark">S</span>{settings.appName}</div>
      <h1>{signup ? "Make time for better meetings" : "Welcome back"}</h1><p className="muted">{signup ? "Create your page. Let people pick a time." : "Sign in to manage your time."}</p>
      <form onSubmit={submit}>
        {signup && <Field label="Name" htmlFor="name" error={fields.name}><input id="name" autoComplete="name" required value={b.name} onChange={(e) => set("name", e.target.value)} /></Field>}
        <Field label="Email" htmlFor="email" error={fields.email}><input id="email" type="email" autoComplete="email" required value={b.email} onChange={(e) => set("email", e.target.value)} /></Field>
        {signup && <Field label="Username" htmlFor="username" error={fields.username} help={`${location.origin}/${b.username || "you"}`}><input id="username" required value={b.username} onChange={(e) => set("username", e.target.value.toLowerCase())} /></Field>}
        <Field label="Password" htmlFor="password" error={fields.password}><input id="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : undefined} required value={b.password} onChange={(e) => set("password", e.target.value)} /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn primary full" disabled={busy}>{busy && <Spinner />}{signup ? "Create account" : "Sign in"}</button>
      </form>
      <div className="auth-foot">{signup ? "Already have an account?" : "New here?"} <Link to={signup ? "/login" : "/signup"}>{signup ? "Sign in" : "Create account"}</Link></div>
      {!signup && settings.seedDemo && <div className="demo-hint">Demo: alex@example.com / demo-pass-123</div>}
    </div></div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: React.ReactNode; subtitle?: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</header>;
}
function Root() { const { me } = useAuth(); return <Navigate to={me ? "/event-types" : "/login"} replace />; }
function ScrollTop() { const { pathname } = useLocation(); useEffect(() => { window.scrollTo(0, 0); }, [pathname]); return null; }
function Layout() { return <ToastProvider><AuthProvider><ScrollTop /><Outlet /></AuthProvider></ToastProvider>; }
const router = createBrowserRouter([{ element: <Layout />, children: [
  { path: "/", element: <Root /> },
  { path: "/login", element: <AuthPage /> }, { path: "/signup", element: <AuthPage signup /> },
  { element: <Shell />, children: [
    { path: "/event-types", element: <EventList /> }, { path: "/event-types/:id", element: <EventEditor /> },
    { path: "/availability", element: <ScheduleList /> }, { path: "/availability/:id", element: <ScheduleEditor /> },
    { path: "/bookings", element: <Navigate to="/bookings/upcoming" replace /> }, { path: "/bookings/:status", element: <Bookings /> },
    { path: "/settings", element: <Navigate to="/settings/profile" replace /> }, { path: "/settings/:tab", element: <Settings /> },
  ] },
  { path: "/booking/:uid", element: <BookingPage /> },
  { path: "/:username/:slug", element: <Booker /> }, { path: "/:username", element: <Profile /> },
] }]);
export default function App() {
  useEffect(() => { document.title = settings.appName; document.documentElement.style.setProperty("--brand", settings.brandColor); }, []);
  return <RouterProvider router={router} />;
}
