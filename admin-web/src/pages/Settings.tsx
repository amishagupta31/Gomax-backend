import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Award, Banknote, Check, Info, KeyRound, Landmark, Languages, MessageCircle, Pencil, Shield, Sparkles, Unlock, UserPlus, Users, Wallet } from 'lucide-react';
import { api, type Role } from '../api';
import { useStaff } from '../auth';
import { ROLE_LABEL } from '../roles';
import { useHead } from '../Shell';
import { ago, Client, Drawer, ErrorBox, errMsg, initials, inr, Loading, n, NotConnected, PinInputs, Toggle, useLoad, useToast } from '../ui';

// D9c Settings (21:15494) · D9c2 Ranks & benefits (21:16182). Owners change; others read.
// Every change is saved in the Audit log.
type Rank = { id: string; name: string; min: number; spins: number; runsBoostPct: number };
type S = {
  withdraw: { minPoints: number; maxPerRequest: number; maxPerMonth: number };
  firstCouponBonus: number;
  ranks: Rank[];
  referral: { firstCouponBonusRuns: number; levelSharePct: number; levels: number; monthlyCapRuns: number };
  streak: { rewards: { days: number; runs: number }[] };
  quests: { scan: number; invite: number; photo: number };
  fraud: { burstScans: number; burstMinutes: number; jumpKm: number; jumpMinutes: number };
  payout: { lockMinutes: number };
};
type Section = 'money' | 'games' | 'ranks' | 'referral' | 'fraud' | 'languages' | 'staff' | 'payout' | 'whatsapp';
const SECTIONS: [Section, string, typeof Wallet][] = [
  ['money', 'Points & withdrawals', Wallet],
  ['games', 'Games & scratch card', Sparkles],
  ['ranks', 'Ranks & benefits', Award],
  ['referral', 'Referral', Users],
  ['fraud', 'Fraud rules', Shield],
  ['languages', 'Languages', Languages],
  ['staff', 'Staff logins', KeyRound],
  ['payout', 'Payout provider', Landmark],
  ['whatsapp', 'WhatsApp', MessageCircle],
];

export default function Settings() {
  const staff = useStaff();
  const owner = staff.role === 'owner';
  const [sec, setSec] = useState<Section>('money');
  const { data, error, reload } = useLoad<{ settings: S }>(() => api.get('/settings'));
  useHead('Settings', owner ? 'Owner only · every change is saved in the Audit log' : 'View only · owners change these');
  const sections = SECTIONS.filter(([k]) => owner || k !== 'staff');
  return (
    <div className="grid grid-nav">
      <nav className="card col" style={{ gap: 2, padding: 10 }} aria-label="Settings sections">
        {sections.map(([k, l, I]) => (
          <button key={k} className="nav-item" style={{ border: 0, background: sec === k ? 'var(--primary-50)' : 'none', color: sec === k ? 'var(--primary-700)' : 'var(--text-primary)', fontWeight: sec === k ? 600 : 500 }} onClick={() => setSec(k)}>
            <I size={16} />
            {l}
          </button>
        ))}
      </nav>
      <div className="col g20" style={{ minWidth: 0 }}>
        {error && <ErrorBox error={error} retry={reload} />}
        {!data && !error && <div className="card"><Loading rows={6} /></div>}
        {data && sec === 'money' && <Money s={data.settings} owner={owner} onSaved={reload} />}
        {data && sec === 'games' && <Games s={data.settings} />}
        {data && sec === 'ranks' && <Ranks s={data.settings} owner={owner} onSaved={reload} />}
        {data && sec === 'referral' && <Referral s={data.settings} owner={owner} onSaved={reload} />}
        {data && sec === 'fraud' && <Fraud s={data.settings} owner={owner} onSaved={reload} />}
        {sec === 'languages' && <LanguagesCard />}
        {sec === 'staff' && owner && <StaffLogins />}
        {data && sec === 'payout' && <Payout s={data.settings} owner={owner} onSaved={reload} />}
        {sec === 'whatsapp' && (
          <div className="card col g12">
            <p className="t-card w7">WhatsApp</p>
            <p className="t-13">Messages go out through Meta WhatsApp Cloud API once the Business number and templates are approved. The template list is on the WhatsApp messages page.</p>
            <Link className="link" to="/whatsapp">
              Open WhatsApp messages
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** Saves one settings key; returns a button. */
function useSave(key: keyof S, onSaved: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (value: unknown) => {
    setBusy(true);
    try {
      await api.put(`/settings/${key}`, { value });
      toast('Saved · in the Audit log');
      onSaved();
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };
  return { busy, save };
}

const Num = ({ label, value, onChange, disabled, hint, prefix, suffix }: { label: string; value: number | string; onChange: (v: number) => void; disabled?: boolean; hint?: string; prefix?: string; suffix?: string }) => (
  <div className="field">
    <span className="label">{label}</span>
    <div className="row g6">
      {prefix && <span className="c-sec">{prefix}</span>}
      <input className="input" inputMode="numeric" aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(Number(e.target.value.replace(/[^\d.]/g, '')) || 0)} />
      {suffix && <span className="c-sec nowrap">{suffix}</span>}
    </div>
    {hint && <p className="hint">{hint}</p>}
  </div>
);

function SaveRow({ owner, busy, onSave, money }: { owner: boolean; busy: boolean; onSave: () => void; money?: boolean }) {
  if (!owner) return <p className="t-12 c-sec">View only — owners change settings.</p>;
  return (
    <div className="row g10 wrap">
      <button className="btn primary" disabled={busy} onClick={onSave}>
        <Check size={16} />
        Save changes
      </button>
      {money && <span className="t-12 c-muted">A 2nd owner to confirm money changes is not connected yet — this saves at once.</span>}
    </div>
  );
}

function Money({ s, owner, onSaved }: { s: S; owner: boolean; onSaved: () => void }) {
  const [w, setW] = useState(s.withdraw);
  const [bonus, setBonus] = useState(s.firstCouponBonus);
  const a = useSave('withdraw', onSaved);
  const b = useSave('firstCouponBonus', () => {});
  return (
    <div className="card col g16">
      <p className="t-card w7">Points &amp; withdrawals</p>
      <div className="grid grid-3" style={{ gap: 14 }}>
        <div className="field">
          <span className="label">1 point =</span>
          <input className="input" value="₹1" disabled />
        </div>
        <Num label="Minimum to withdraw (points)" value={w.minPoints} disabled={!owner} onChange={(v) => setW({ ...w, minPoints: v })} hint={`Points tile turns green at ${n(w.minPoints)}`} />
        <Num label="Max per request" prefix="₹" value={w.maxPerRequest} disabled={!owner} onChange={(v) => setW({ ...w, maxPerRequest: v })} />
        <Num label="Max per month per applicator" prefix="₹" value={w.maxPerMonth} disabled={!owner} onChange={(v) => setW({ ...w, maxPerMonth: v })} hint={`App shows “Max ${inr(w.maxPerRequest)} per request · ${inr(w.maxPerMonth)} a month”`} />
        <Num label="First coupon bonus (points)" value={bonus} disabled={!owner} onChange={setBonus} />
        <div className="field">
          <span className="label">Day window (scratch card, limits)</span>
          <input className="input" value="12:00 am – 12:00 am IST" disabled />
        </div>
        <div className="field">
          <span className="label">Helpline number (shown in app)</span>
          <input className="input" value="92158 44410" disabled />
        </div>
        <div className="field">
          <span className="label">Login paused after</span>
          <input className="input" value="5 wrong tries · 30 min" disabled />
          <p className="hint">Fixed in the API. The Figma page says 3 tries; the M1 note says 5.</p>
        </div>
        <div className="field">
          <span className="label">Points expire after</span>
          <input className="input" value="Never" disabled />
        </div>
      </div>
      <NotConnected what="daily payout batch time and the “owner OK above ₹50,000 a day” limit (no setting in the API yet)." />
      <SaveRow
        owner={owner}
        money
        busy={a.busy || b.busy}
        onSave={async () => {
          await a.save(w);
          if (bonus !== s.firstCouponBonus) await b.save(bonus);
        }}
      />
    </div>
  );
}

function Games({ s }: { s: S }) {
  return (
    <div className="card col g12">
      <p className="t-card w7">Games &amp; scratch card</p>
      <p className="t-13">Spin odds and the scratch card rule have their own page.</p>
      <p className="t-13 c-sec">
        Quests: scan {s.quests.scan} runs · invite {s.quests.invite} runs · photo {s.quests.photo} runs.
      </p>
      <Link className="btn" style={{ alignSelf: 'flex-start' }} to="/games">
        <Sparkles size={16} />
        Open Games &amp; odds
      </Link>
    </div>
  );
}

function Ranks({ s, owner, onSaved }: { s: S; owner: boolean; onSaved: () => void }) {
  const [ranks, setRanks] = useState(s.ranks);
  const [edit, setEdit] = useState<number | null>(null);
  const { busy, save } = useSave('ranks', onSaved);
  return (
    <div className="card col g16">
      <p className="t-card w7">Ranks &amp; benefits</p>
      <div className="table-wrap">
        <table className="tbl cards">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Lifetime points</th>
              <th>Free spins / day</th>
              <th>Extra runs</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ranks.map((r, i) => (
              <tr key={r.id}>
                <td data-l="Rank">
                  <div className="person">
                    <span className="avatar">{initials(r.name)}</span>
                    {edit === i ? <input className="input" value={r.name} onChange={(e) => setRanks(ranks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /> : <div><p className="w6">{r.name}</p><p className="t-12 c-sec">{i === 0 ? 'Start rank' : `Rank ${i + 1}`}</p></div>}
                  </div>
                </td>
                <td data-l="Lifetime points">{edit === i && i > 0 ? <input className="input" style={{ width: 110 }} inputMode="numeric" value={r.min} onChange={(e) => setRanks(ranks.map((x, j) => (j === i ? { ...x, min: Number(e.target.value.replace(/\D/g, '')) } : x)))} /> : <span className="pill navy">{n(r.min)} points</span>}</td>
                <td data-l="Free spins / day">{edit === i ? <input className="input" style={{ width: 80 }} inputMode="numeric" value={r.spins} onChange={(e) => setRanks(ranks.map((x, j) => (j === i ? { ...x, spins: Number(e.target.value.replace(/\D/g, '')) } : x)))} /> : `${r.spins} spins`}</td>
                <td data-l="Extra runs">{edit === i ? <input className="input" style={{ width: 80 }} inputMode="numeric" value={r.runsBoostPct} onChange={(e) => setRanks(ranks.map((x, j) => (j === i ? { ...x, runsBoostPct: Number(e.target.value.replace(/\D/g, '')) } : x)))} /> : r.runsBoostPct ? `+${r.runsBoostPct}% runs` : '0%'}</td>
                <td>
                  {owner && (
                    <button className="btn ghost sm" aria-label={`Edit ${r.name}`} onClick={() => setEdit(edit === i ? null : i)}>
                      {edit === i ? <Check size={15} /> : <Pencil size={15} />}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note" style={{ color: 'var(--navy-brand)' }}>
        <Info size={16} style={{ flex: 'none' }} />
        Same values as the app Ranks screen. Rank never goes down. Free spins reset at 12:00 am IST. <Client>GoMax Legend: CLIENT to confirm</Client>
      </div>
      <SaveRow owner={owner} busy={busy} onSave={() => save(ranks)} />
    </div>
  );
}

function Referral({ s, owner, onSaved }: { s: S; owner: boolean; onSaved: () => void }) {
  const [r, setR] = useState(s.referral);
  const { busy, save } = useSave('referral', onSaved);
  return (
    <div className="card col g16">
      <p className="t-card w7">First-time rewards &amp; referral</p>
      <div className="grid grid-3" style={{ gap: 14 }}>
        <Num label="Referral runs to inviter (friend’s 1st coupon)" value={r.firstCouponBonusRuns} disabled={!owner} onChange={(v) => setR({ ...r, firstCouponBonusRuns: v })} suffix="runs" />
        <Num label="Runs per level (% of points scanned below)" value={r.levelSharePct} disabled={!owner} onChange={(v) => setR({ ...r, levelSharePct: v })} suffix="%" />
        <Num label="Levels (max 4)" value={r.levels} disabled={!owner} onChange={(v) => setR({ ...r, levels: Math.min(4, v) })} />
        <Num label="Referral monthly cap" value={r.monthlyCapRuns} disabled={!owner} onChange={(v) => setR({ ...r, monthlyCapRuns: v })} suffix="runs" />
        <div className="field">
          <span className="label">Paid when</span>
          <input className="input" value="Friend adds 1st coupon" disabled />
        </div>
        <div className="field">
          <span className="label">Self-invite / same phone</span>
          <input className="input" value="Blocked" disabled />
        </div>
      </div>
      <SaveRow owner={owner} busy={busy} onSave={() => save(r)} />
    </div>
  );
}

function Fraud({ s, owner, onSaved }: { s: S; owner: boolean; onSaved: () => void }) {
  const [f, setF] = useState(s.fraud);
  const { busy, save } = useSave('fraud', onSaved);
  return (
    <div className="card col g16">
      <p className="t-card w7">Fraud rules</p>
      <p className="t-13 c-sec">A flag holds the applicator’s cash until an owner decides (Scans log → Flags).</p>
      <div className="grid grid-2" style={{ gap: 14 }}>
        <Num label="Too fast: more than … scans" value={f.burstScans} disabled={!owner} onChange={(v) => setF({ ...f, burstScans: v })} suffix="scans" />
        <Num label="… in minutes" value={f.burstMinutes} disabled={!owner} onChange={(v) => setF({ ...f, burstMinutes: v })} suffix="min" />
        <Num label="GPS jump: more than" value={f.jumpKm} disabled={!owner} onChange={(v) => setF({ ...f, jumpKm: v })} suffix="km" />
        <Num label="… in minutes" value={f.jumpMinutes} disabled={!owner} onChange={(v) => setF({ ...f, jumpMinutes: v })} suffix="min" />
      </div>
      <p className="t-12 c-sec">Always on: same code tried again · 2+ accounts on one phone · 10 wrong codes in 10 min.</p>
      <Client>Fraud limits ok? (15 scans / 5 min, 50 km jump) · CLIENT to confirm</Client>
      <SaveRow owner={owner} busy={busy} onSave={() => save(f)} />
    </div>
  );
}

function Payout({ s, owner, onSaved }: { s: S; owner: boolean; onSaved: () => void }) {
  const [lock, setLock] = useState(s.payout.lockMinutes);
  const { busy, save } = useSave('payout', onSaved);
  return (
    <div className="card col g16">
      <p className="t-card w7">Payout provider</p>
      <div className="kv">
        <span>Payout mode</span>
        <span>Set on the server (PAYOUT_MODE): manual UPI or RazorpayX. Each withdrawal shows which one paid it.</span>
      </div>
      <Num label="Pay-manually row lock (minutes)" value={lock} disabled={!owner} onChange={setLock} suffix="min" hint="While one person pays, nobody else can pay the same row." />
      <SaveRow owner={owner} busy={busy} onSave={() => save({ lockMinutes: lock })} />
    </div>
  );
}

function LanguagesCard() {
  return (
    <div className="card col g12">
      <div>
        <p className="t-card w7">Languages in the app</p>
        <p className="t-12 c-sec">Applicator picks at sign-up; can change in Profile</p>
      </div>
      <div className="grid grid-3" style={{ gap: 12 }}>
        {[
          ['English', 'Default'],
          ['Hindi', 'हिंदी'],
          ['Punjabi', 'Gurmukhi'],
        ].map(([l, s]) => (
          <div key={l} className="row g10" style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: '12px 14px' }}>
            <Toggle on disabled label={l!} />
            <div>
              <p className="t-13 w6">{l}</p>
              <p className="t-12 c-sec">{s}</p>
            </div>
          </div>
        ))}
      </div>
      <NotConnected what="turning a language on/off and the translation progress — languages are built into the app." />
    </div>
  );
}

// ── Staff logins ──
type StaffRow = { id: string; loginId: string; name: string; role: Role; mobile: string | null; active: boolean; lockedUntil: string | null; createdAt: string };
const ROLE_TONE: Record<Role, string> = { owner: 'navy', accounts: 'ok', factory: 'warn', helpline: 'ok', ops: 'info' };

function StaffLogins() {
  const me = useStaff();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ staff: StaffRow[] }>(() => api.get('/staff'));
  const [edit, setEdit] = useState<StaffRow | 'new' | null>(null);
  return (
    <div className="card col g16">
      <div className="between">
        <p className="t-card w7">Staff logins</p>
        <button className="btn sm" onClick={() => setEdit('new')}>
          <UserPlus size={14} />
          Add staff
        </button>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Login</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.staff.map((s) => {
                const locked = s.lockedUntil && new Date(s.lockedUntil) > new Date();
                return (
                  <tr key={s.id}>
                    <td data-l="Name">
                      <div className="person">
                        <span className="avatar">{initials(s.name)}</span>
                        <div>
                          <p className="w6">{s.name}</p>
                          <p className="t-12 c-sec">{s.mobile ?? ROLE_LABEL[s.role]}</p>
                        </div>
                      </div>
                    </td>
                    <td data-l="Role">
                      <span className={`pill ${ROLE_TONE[s.role]}`}>{ROLE_LABEL[s.role]}</span>
                    </td>
                    <td data-l="Login" className="mono">
                      {s.loginId}
                    </td>
                    <td data-l="Status">{!s.active ? <span className="pill">Off</span> : locked ? <span className="pill bad">Locked till {new Date(s.lockedUntil!).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span> : <span className="pill ok">Active · since {ago(s.createdAt)}</span>}</td>
                    <td>
                      <div className="row g6" style={{ justifyContent: 'flex-end' }}>
                        {locked && (
                          <button
                            className="btn sm"
                            onClick={() =>
                              api
                                .patch(`/staff/${s.id}`, { unlock: true })
                                .then(() => (toast(`${s.name} unlocked`), reload()))
                                .catch((e) => toast(errMsg(e), true))
                            }
                          >
                            <Unlock size={14} />
                            Unlock
                          </button>
                        )}
                        <button className="btn ghost sm" aria-label={`Edit ${s.name}`} disabled={s.id === me.id} title={s.id === me.id ? 'Ask another owner to change your login' : undefined} onClick={() => setEdit(s)}>
                          <Pencil size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="note" style={{ color: 'var(--navy-brand)' }}>
        <Banknote size={16} style={{ flex: 'none' }} />
        Dealer logins (D10): GoMax makes the dealer’s ID + password and sends it on WhatsApp — dealers cannot sign up. Manage them on the Dealers page.
      </div>
      {edit && (
        <StaffDrawer
          s={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function StaffDrawer({ s, onClose, onSaved }: { s: StaffRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [loginId, setLoginId] = useState(s?.loginId ?? '');
  const [name, setName] = useState(s?.name ?? '');
  const [role, setRole] = useState<Role>(s?.role ?? 'accounts');
  const [mobile, setMobile] = useState(s?.mobile ?? '');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [active, setActive] = useState(s?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [password, pin]);
  const newOk = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(loginId.trim().toLowerCase()) && loginId.trim().length <= 40 && name.trim().length >= 2 && password.length >= 10 && pin.length === 4 && (!mobile || /^\d{10}$/.test(mobile));
  const editOk = (!password || password.length >= 10) && (!pin || pin.length === 4);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (s) await api.patch(`/staff/${s.id}`, { role, active, ...(password && { password }), ...(pin && { pin }) });
      else await api.post('/staff', { loginId: loginId.trim().toLowerCase(), name: name.trim(), role, mobile: mobile || undefined, password, pin });
      toast(s ? 'Login updated' : `Login ${loginId} made · share the password and money-approval PIN in person`);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={s ? `Edit ${s.name}` : 'Add staff login'}
      sub="Log in with email + password. The 4-digit PIN is asked before approving money. Changing the password logs them out everywhere."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !(s ? editOk : newOk)} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {!s && (
        <>
          <div className="field">
            <label htmlFor="sl">Email</label>
            <input id="sl" className="input" type="email" value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="ankit@example.com" autoCapitalize="none" />
            <p className="hint">They log in with this email and the password below.</p>
          </div>
          <div className="field">
            <label htmlFor="sn">Name</label>
            <input id="sn" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="sm">Mobile (optional)</label>
            <input id="sm" className="input" inputMode="numeric" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="sr">Role</label>
        <select id="sr" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <p className="hint">Owners: everything · Accounts: money + KYC · Factory: printing + gifts · Helpline: lookups · Office staff: streak photos</p>
      </div>
      <div className="field">
        <label htmlFor="sp">{s ? 'New password (leave empty to keep)' : 'Password'}</label>
        <input id="sp" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="hint">At least 10 characters.</p>
      </div>
      <div className="field">
        <span className="label">{s ? 'New PIN for money approvals (leave empty to keep)' : 'Security PIN for money approvals'}</span>
        <PinInputs value={pin} onChange={setPin} />
      </div>
      {s && (
        <label className="row g10 t-13">
          <Toggle on={active} onChange={setActive} label="Login active" />
          Login active (off = cannot log in; all data kept)
        </label>
      )}
      {error && <ErrorBox error={error} />}
    </Drawer>
  );
}
