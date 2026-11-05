import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from 'lucide-react';
import { ApiError } from './api';

// ── formatting (IST, Indian grouping) ──
const IST = 'Asia/Kolkata';
export const n = (v: number | null | undefined) => (v ?? 0).toLocaleString('en-IN');
export const inr = (v: number | null | undefined) => `₹${n(v)}`;
export const spacedMobile = (m?: string | null) => (m && /^\d{10}$/.test(m) ? `${m.slice(0, 5)} ${m.slice(5)}` : (m ?? ''));
export const spacedUtr = (u?: string | null) => (u ? u.replace(/(\d{4})(?=\d)/g, '$1 ') : '');
export const initials = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
export const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' }) : '');
export const dateTime = (iso?: string | null) => (iso ? `${new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short' })}, ${time(iso)}` : '—');
export function ago(iso?: string | null) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr${s >= 7200 ? 's' : ''} ago`;
  if (s < 172800) return 'Yesterday';
  return date(iso);
}
export const hoursSince = (iso?: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : 0);
export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.');

// ── data loading ──
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => my === seq.current && (setData(d), setError(null)))
      .catch((e) => my === seq.current && setError(errMsg(e)))
      .finally(() => my === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="col g10" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="note bad" role="alert">
      <CircleAlert size={16} />
      <div className="grow">{error}</div>
      {retry && (
        <button className="link" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ icon, title, sub }: { icon?: ReactNode; title: string; sub?: string }) {
  return (
    <div className="empty">
      {icon}
      <p className="t-card" style={{ color: 'var(--text-primary)' }}>
        {title}
      </p>
      {sub && <p className="t-13">{sub}</p>}
    </div>
  );
}

/** Marks something the design shows but the API doesn't provide yet. */
export function NotConnected({ what }: { what: string }) {
  return (
    <div className="note warn">
      <Info size={16} style={{ flex: 'none' }} />
      <div>
        <b>Not connected yet:</b> {what}
      </div>
    </div>
  );
}

export const Client = ({ children = 'CLIENT to confirm' }: { children?: ReactNode }) => <span className="pill client">{children}</span>;

// ── toasts ──
type Toast = { text: string; bad?: boolean } | null;
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const timer = useRef<number>(0);
  const show = useCallback((text: string, bad?: boolean) => {
    setT({ text, bad });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">
          {t.bad ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
          {t.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ── overlays ──
function useEsc(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Drawer({ title, sub, onClose, children, footer, wide }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEsc(onClose);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="drawer-hd">
          <div className="grow">
            <h2 className="t-title">{title}</h2>
            {sub && <div className="t-12 c-sec mt4">{sub}</div>}
          </div>
          <button className="x-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-bd">{children}</div>
        {footer && <div className="drawer-ft">{footer}</div>}
      </aside>
    </div>
  );
}

export function Dialog({ title, children, onClose }: { title: ReactNode; children: ReactNode; onClose: () => void }) {
  useEsc(onClose);
  return (
    <div className="backdrop center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="between">
          <h2 className="t-title">{title}</h2>
          <button className="x-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PinInputs({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  return (
    <div className="pins">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          autoFocus={autoFocus && i === 0}
          type="password"
          inputMode="numeric"
          maxLength={1}
          aria-label={`PIN digit ${i + 1}`}
          value={value[i] ?? ''}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(-1);
            const next = (value.slice(0, i) + d + value.slice(i + 1)).slice(0, 4);
            onChange(next);
            if (d && i < 3) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
          }}
          onPaste={(e) => {
            const d = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4);
            if (d) {
              e.preventDefault();
              onChange(d);
              refs.current[Math.min(d.length, 3)]?.focus();
            }
          }}
        />
      ))}
    </div>
  );
}

/** "PIN is asked again before you approve money" (M1). */
export function PinDialog({ title, sub, action = 'Approve', onSubmit, onClose }: { title: string; sub?: ReactNode; action?: string; onSubmit: (pin: string) => Promise<void>; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pin);
    } catch (e) {
      setError(errMsg(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      {sub && <div className="t-13 c-sec">{sub}</div>}
      <div className="field">
        <span className="label">Your 4-digit security PIN</span>
        <PinInputs value={pin} onChange={setPin} autoFocus />
        {error && <p className="err">{error}</p>}
      </div>
      <button className="btn primary lg block" disabled={pin.length !== 4 || busy} onClick={go}>
        {busy ? <LoaderCircle size={16} className="spin" /> : null}
        {action}
      </button>
    </Dialog>
  );
}

/** Asks a reason (min 3 chars, as the API requires) with optional quick picks. */
export function ReasonDialog({
  title,
  sub,
  action,
  danger,
  picks = [],
  onSubmit,
  onClose,
}: {
  title: string;
  sub?: ReactNode;
  action: string;
  danger?: boolean;
  picks?: string[];
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} onClose={onClose}>
      {sub && <div className="t-13 c-sec">{sub}</div>}
      {picks.length > 0 && (
        <div className="row wrap g6">
          {picks.map((p) => (
            <button key={p} className={`pill ${reason === p ? 'pri' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setReason(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
      <div className="field">
        <label htmlFor="reason">Reason (the applicator sees this)</label>
        <textarea id="reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
        {error && <p className="err">{error}</p>}
      </div>
      <button
        className={`btn lg block ${danger ? 'danger solid' : 'primary'}`}
        disabled={reason.trim().length < 3 || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onSubmit(reason.trim());
          } catch (e) {
            setError(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {action}
      </button>
    </Dialog>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange?.(!on)} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string, number?][]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([v, l, c]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
          {c !== undefined && <span className="count">{n(c)}</span>}
        </button>
      ))}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="between wrap">
      <div>
        <h1 className="t-title">{title}</h1>
        {sub && <p className="t-13 c-sec mt4">{sub}</p>}
      </div>
      {actions && <div className="row wrap g10">{actions}</div>}
    </div>
  );
}
