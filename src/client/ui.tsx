import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { allZones, zoneLabel } from "./lib";

const paths: Record<string, string> = {
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  pin: "M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6L6 18",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  copy: "M8 8h12v12H8zM4 16V4h12",
  plus: "M12 5v14M5 12h14",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  ext: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  video: "M3 7h12v10H3zM15 10l6-3v10l-6-3",
  phone: "M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  back: "M19 12H5M11 6l-6 6 6 6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  inbox: "M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z",
};
export function Icon({ name, size = 16, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "dots" ? 3 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] || ""} />
    </svg>
  );
}

type ToastCtx = (msg: string) => void;
const Toast = createContext<ToastCtx>(() => {});
export const useToast = () => useContext(Toast);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msgs, setMsgs] = useState<{ id: number; msg: string }[]>([]);
  const show = useMemo(() => (msg: string) => {
    const id = Math.random();
    setMsgs((m) => [...m, { id, msg }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 3000);
  }, []);
  return (
    <Toast.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{msgs.map((m) => <div key={m.id} className="toast">{m.msg}</div>)}</div>
    </Toast.Provider>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button type="button" id={id} role="switch" aria-checked={checked} aria-label={label} className={"switch" + (checked ? " on" : "")} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((x) => !(x as any).disabled);
    (focusables()[0] || el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Tab") {
        const f = focusables(); if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"dialog" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <h2>{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Menu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="dots" /></button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" type="button" disabled={it.disabled} className={it.danger ? "danger" : ""} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TimezoneSelect({ value, onChange, id, label = "Time zone", plain }: { value: string; onChange: (z: string) => void; id?: string; label?: string; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const zones = useMemo(() => allZones(), []);
  const ref = useRef<HTMLDivElement>(null);
  const shown = zones.filter((z) => z.toLowerCase().replace(/_/g, " ").includes(q.toLowerCase().replace(/_/g, " "))).slice(0, 200);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div className={"tz" + (plain ? " plain" : "")} ref={ref}>
      <button type="button" id={id} className="tz-btn" aria-label={`${label}: ${value}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen(!open); setQ(""); }}>
        <span>{plain ? value.replace(/_/g, " ") : zoneLabel(value)}</span><Icon name="down" size={14} />
      </button>
      {open && (
        <div className="tz-pop">
          <input autoFocus aria-label="Search time zones" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); if (e.key === "Enter" && shown[0]) { onChange(shown[0]); setOpen(false); } }} />
          <ul role="listbox" aria-label="Time zones">
            {shown.map((z) => (
              <li key={z}><button type="button" role="option" aria-selected={z === value} onClick={() => { onChange(z); setOpen(false); }}>{zoneLabel(z)}</button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Field({ label, error, help, children, htmlFor }: { label: string; error?: string; help?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && !error && <div className="help">{help}</div>}
      {error && <div className="err" role="alert">{error}</div>}
    </div>
  );
}

export function Empty({ icon, title, line, action }: { icon: string; title: string; line: string; action?: React.ReactNode }) {
  return (
    <div className="empty"><div className="empty-icon"><Icon name={icon} size={22} /></div><strong>{title}</strong><p>{line}</p>{action}</div>
  );
}
export const Spinner = () => <span className="spinner" aria-hidden="true" />;
