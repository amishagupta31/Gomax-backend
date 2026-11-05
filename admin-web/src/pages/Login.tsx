import { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, ShieldCheck } from 'lucide-react';
import { ApiError } from '../api';
import { useAuth } from '../auth';

// M1 madm-login (21:14563) — the same page on desktop and phone.
// Email + password, no OTP. 5 wrong tries lock the login for 30 min.
export default function Login() {
  const { login } = useAuth();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(id.trim(), pw);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'locked') {
        const until = (err.details as { until?: string })?.until;
        setError(`Login locked${until ? ` until ${new Date(until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : ''}. Ask an owner to reset it.`);
      } else setError(err instanceof Error ? err.message : 'Could not log in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-top">
        <div className="login-logo">G</div>
        <p style={{ fontSize: 24, lineHeight: '28px', fontWeight: 700, letterSpacing: -0.24 }}>GoMax Admin</p>
        <p className="t-13">admin.gomax.in · for GoMax staff only</p>
      </div>
      <form className="login-body" onSubmit={submit}>
        <h1 className="t-title">Log in</h1>
        <div className="field">
          <label htmlFor="admin-id">Email</label>
          <div className="input-icon">
            <Mail size={18} />
            <input id="admin-id" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" value={id} onChange={(e) => setId(e.target.value)} autoFocus />
          </div>
        </div>
        <div className="field">
          <label htmlFor="admin-pw">Password</label>
          <div className="input-icon">
            <Lock size={18} />
            <input id="admin-pw" type={show ? 'text' : 'password'} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary lg block" disabled={busy || id.trim().length < 2 || !pw}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <p className="t-13 w5 c-navy" style={{ textAlign: 'center' }}>
          Forgot password? Ask the owner admin to reset it.
        </p>
        <div className="row g6 t-12 c-sec">
          <ShieldCheck size={16} color="var(--success-text)" />5 wrong tries = locked for 30 min
        </div>
      </form>
    </div>
  );
}
