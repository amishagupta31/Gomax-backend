import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Award, Ban, Coins, Eye, KeyRound, Languages, Lock, MessageCircle, Phone, ScanLine, ShieldCheck, TriangleAlert, Unlock, Users, Wallet } from 'lucide-react';
import { api } from '../api';
import { useStaff } from '../auth';
import { flagText, rankTone, type Flag } from '../labels';
import { canEdit } from '../roles';
import { useHead } from '../Shell';
import { ago, date, dateTime, Dialog, ErrorBox, errMsg, initials, Loading, n, ReasonDialog, spacedMobile, useLoad, useToast } from '../ui';
import { LevelTable, TreeList, treeStats, useTree } from './ReferralTree';

// D9b detail panel (21:15164) + M5 applicator profile (21:17427).
type Profile = {
  id: string;
  name: string;
  mobile: string;
  city: string | null;
  language: string;
  inviteCode: string;
  status: 'active' | 'blocked';
  cashHold: boolean;
  lockedUntil: string | null;
  points: number;
  runs: number;
  lifetimePoints: number;
  withdrawReady: boolean;
  rank: { id: string; name: string; spinsPerDay: number; runsBoostPct: number; next: { name: string; pointsToGo: number } | null; ladder: { id: string }[] };
  kyc: { pan: { masked: string; name: string } | null; upi: { id: string; name: string; matchesPan: boolean } | null };
  scans: { added: number; failed: number };
  referredBy: { id: string; name: string; mobile: string } | null;
  flags: Flag[];
  recentLedger: { id: number; wallet: 'points' | 'runs'; kind: string; amount: number; balanceAfter: number; title: string; sub: string | null; createdAt: string }[];
  createdAt: string;
};
const LANG: Record<string, string> = { en: 'English', hi: 'Hindi', pa: 'Punjabi' };

export default function ApplicatorProfile() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const staff = useStaff();
  const toast = useToast();
  const owner = staff.role === 'owner';
  const money = canEdit(staff.role, '/applicators') && (owner || staff.role === 'accounts');
  const p = useLoad<Profile>(() => api.get(`/applicators/${id}`), [id]);
  const tree = useTree(id);
  const [pan, setPan] = useState<{ pan: string; name: string } | null>(null);
  const [ask, setAsk] = useState<'hold' | 'release' | 'block' | 'unblock' | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [kycOk, setKycOk] = useState(false);
  const helpdesk = staff.role === 'owner' || staff.role === 'helpline';
  const d = p.data;
  useHead(d?.name ?? 'Applicator', d ? `${spacedMobile(d.mobile)} · code ${d.inviteCode}${d.city ? ` · ${d.city}` : ''} · joined ${date(d.createdAt)}` : '');

  if (p.error) return <ErrorBox error={p.error} retry={p.reload} />;
  if (!d) return <div className="card"><Loading rows={6} /></div>;
  const ts = tree.data ? treeStats(tree.data) : null;
  const kycMsg = !d.kyc.pan
    ? `Namaste ${d.name.split(' ')[0]}, please add your PAN in the GoMax app (Home → Link PAN & UPI) to withdraw your points. — GoMax`
    : d.kyc.upi && !d.kyc.upi.matchesPan
      ? `Namaste ${d.name.split(' ')[0]}, the name on your UPI (${d.kyc.upi.name}) is different from your PAN name. Please add a UPI in your own name in the GoMax app. — GoMax`
      : `Namaste ${d.name.split(' ')[0]}, please add your UPI ID in the GoMax app to withdraw your points. — GoMax`;

  return (
    <>
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => nav(-1)}>
        <ArrowLeft size={16} />
        Back
      </button>
      <div className="card row g16 wrap" style={{ background: 'linear-gradient(270deg, var(--navy-900), var(--navy-800))', color: '#fff', border: 0 }}>
        <span className="avatar lg">{initials(d.name)}</span>
        <div className="grow">
          <p className="t-title w7">{d.name}</p>
          <p className="t-13" style={{ color: 'var(--side-text)' }}>
            {spacedMobile(d.mobile)} · {d.city ?? 'City not set'} · joined {date(d.createdAt)}
          </p>
          <div className="row g6 wrap mt8">
            <span className="pill" style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}>
              <Award size={13} />
              {d.rank.name} · {d.rank.spinsPerDay} spins/day{d.rank.runsBoostPct ? ` · +${d.rank.runsBoostPct}% runs` : ''}
            </span>
            {d.status === 'blocked' && <span className="pill bad">Blocked</span>}
            {d.cashHold && <span className="pill warn">Cash on hold</span>}
          </div>
        </div>
        <div className="row g10 wrap">
          <a className="btn" href={`tel:+91${d.mobile}`}>
            <Phone size={16} />
            Call
          </a>
          {owner && (
            <button className="btn" style={{ background: 'var(--danger-50)', borderColor: 'var(--danger-50)', color: 'var(--danger-text)' }} onClick={() => setAsk(d.cashHold ? 'release' : 'hold')}>
              {d.cashHold ? <Unlock size={16} /> : <Lock size={16} />}
              {d.cashHold ? 'Release cash' : 'Hold cash'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-3 m2">
        <div className="card" style={{ background: 'var(--success-50)', borderColor: 'var(--success-50)' }}>
          <p className="t-12 c-ok">Points</p>
          <p className="t-title w7 c-ok">{n(d.points)}</p>
          <p className="t-12 c-ok">{d.withdrawReady ? 'Can withdraw' : 'Below the withdraw minimum'}</p>
        </div>
        <div className="card" style={{ background: '#e8f4f7', borderColor: '#e8f4f7' }}>
          <p className="t-12" style={{ color: 'var(--gift-text)' }}>
            Runs
          </p>
          <p className="t-title w7" style={{ color: 'var(--gift-text)' }}>
            {n(d.runs)}
          </p>
          <p className="t-12" style={{ color: 'var(--gift-text)' }}>
            For gifts
          </p>
        </div>
        <div className="card">
          <p className="t-12 c-sec">Scans</p>
          <p className="t-title w7">{n(d.scans.added)}</p>
          <p className="t-12 c-sec">
            All time · {n(d.scans.failed)} failed tries · lifetime {n(d.lifetimePoints)} pt
          </p>
        </div>
      </div>

      <div className="grid grid-main">
        <div className="col g20">
          <div className="card col g16">
            <p className="t-card w7">KYC — PAN &amp; UPI</p>
            <div className="grid grid-2" style={{ gap: 16 }}>
              <div className="col g6">
                <p className="caps">PAN</p>
                {d.kyc.pan ? (
                  <>
                    <p className="t-card w6 mono">{pan?.pan ?? d.kyc.pan.masked}</p>
                    <p className="t-13">Name: {d.kyc.pan.name}</p>
                    <span className="pill ok" style={{ alignSelf: 'flex-start' }}>
                      <ShieldCheck size={13} />
                      PAN added
                    </span>
                    {money && !pan && (
                      <button
                        className="link"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={() =>
                          api
                            .get(`/applicators/${id}/pan`)
                            .then(setPan)
                            .catch((e) => toast(errMsg(e), true))
                        }
                      >
                        <Eye size={13} style={{ verticalAlign: -2 }} /> Show full PAN (saved in Audit log)
                      </button>
                    )}
                  </>
                ) : (
                  <span className="pill" style={{ alignSelf: 'flex-start' }}>
                    — No PAN
                  </span>
                )}
              </div>
              <div className="col g6">
                <p className="caps">UPI</p>
                {d.kyc.upi ? (
                  <>
                    <p className="t-card w6">{d.kyc.upi.id}</p>
                    <p className="t-13">Bank name: {d.kyc.upi.name}</p>
                    {d.kyc.upi.matchesPan ? (
                      <span className="pill ok" style={{ alignSelf: 'flex-start' }}>
                        UPI ok
                      </span>
                    ) : (
                      <span className="pill warn" style={{ alignSelf: 'flex-start' }}>
                        <TriangleAlert size={13} />
                        App / PAN name ≠ bank name
                      </span>
                    )}
                  </>
                ) : (
                  <span className="pill" style={{ alignSelf: 'flex-start' }}>
                    — No UPI
                  </span>
                )}
              </div>
            </div>
            <div className="row g10 wrap">
              {(!d.kyc.pan || !d.kyc.upi || !d.kyc.upi.matchesPan) && (
                <a className="btn" href={`https://wa.me/91${d.mobile}?text=${encodeURIComponent(kycMsg)}`} target="_blank" rel="noreferrer">
                  <MessageCircle size={16} />
                  Ask to fix (WhatsApp)
                </a>
              )}
              {owner && (
                <button className="btn" style={{ background: 'var(--danger-50)', borderColor: 'var(--danger-50)', color: 'var(--danger-text)' }} onClick={() => setAsk(d.status === 'blocked' ? 'unblock' : 'block')}>
                  <Ban size={16} />
                  {d.status === 'blocked' ? 'Unblock' : 'Block'}
                </button>
              )}
              {owner && (
                <button className="btn" onClick={() => setAdjust(true)}>
                  <Coins size={16} />
                  Goodwill / correction
                </button>
              )}
            </div>
            {money && d.kyc.pan && !d.kyc.upi && (
              <button className="btn" style={{ alignSelf: 'flex-start', background: 'var(--success-50)', borderColor: 'var(--success-50)', color: 'var(--success-text)' }} onClick={() => setKycOk(true)}>
                <ShieldCheck size={16} />
                Mark KYC ok (save UPI after checking)
              </button>
            )}
          </div>

          <div className="card col g12">
            <div className="between">
              <p className="t-card w7">Referral tree</p>
              {ts && (
                <span className="t-12 c-sec">
                  {ts.total} people · {n(ts.runs)} runs earned
                </span>
              )}
            </div>
            {tree.error && <ErrorBox error={tree.error} retry={tree.reload} />}
            {tree.data ? <TreeList rootId={d.id} rootName={d.name} tree={tree.data} /> : !tree.error && <Loading />}
          </div>

          <div className="card col g10">
            <p className="t-card w7">Points &amp; runs history</p>
            {d.recentLedger.length === 0 && <p className="t-13 c-sec">No movements yet.</p>}
            {d.recentLedger.map((l) => (
              <div key={l.id} className="list-row">
                <span className={`kpi-icon ${l.wallet === 'points' ? 'tone-ok' : 'tone-gift'}`}>{l.wallet === 'points' ? <Wallet size={15} /> : <Coins size={15} />}</span>
                <div className="grow">
                  <p className="t-13 w5">{l.title}</p>
                  <p className="t-12 c-sec">
                    {l.sub ? `${l.sub} · ` : ''}
                    {dateTime(l.createdAt)}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p className={`t-13 w6 ${l.amount > 0 ? 'c-ok' : 'c-bad'}`}>
                    {l.amount > 0 ? '+' : ''}
                    {n(l.amount)} {l.wallet === 'points' ? 'pt' : 'runs'}
                  </p>
                  <p className="t-12 c-muted">bal {n(l.balanceAfter)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="col g20">
          <div className="card col g10">
            <div className="kv">
              <span>Language</span>
              <span className="row g6">
                <Languages size={14} />
                {LANG[d.language] ?? d.language}
              </span>
              <span>Login</span>
              <span>Mobile + password</span>
              <span>Invite code</span>
              <span className="mono w6">{d.inviteCode}</span>
              <span>Referred by</span>
              <span>{d.referredBy ? <Link className="link" to={`/applicators/${d.referredBy.id}`}>{d.referredBy.name}</Link> : '—'}</span>
              <span>Rank</span>
              <span>
                <span className={`pill ${rankTone(d.rank.id)}`}>{d.rank.name}</span>
                {d.rank.next && <span className="t-12 c-sec"> · {n(d.rank.next.pointsToGo)} pt to {d.rank.next.name}</span>}
              </span>
            </div>
          </div>
          {tree.data && (
            <div className="card col g12">
              <p className="t-card w7">Runs earned by level</p>
              <LevelTable tree={tree.data} />
            </div>
          )}
          <div className="card col g10">
            <p className="t-card w7">Fraud flags</p>
            {d.flags.length === 0 && <p className="t-13 c-sec">None.</p>}
            {d.flags.map((f) => {
              const t = flagText({ ...f, name: d.name, mobile: d.mobile });
              return (
                <Link key={f.id} to="/scans?tab=flags" className="alert-box" style={{ background: f.status === 'open' ? undefined : 'var(--surface-muted)', color: f.status === 'open' ? undefined : 'var(--text-secondary)' }}>
                  <TriangleAlert size={16} style={{ flex: 'none' }} />
                  <div>
                    <p className="t-13 w6">{t.title}</p>
                    <p className="t-12">
                      {f.status} · {ago(f.createdAt)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="card col g10">
            <p className="t-card w7">Look deeper</p>
            <Link className="list-row" to={`/scans?q=${d.mobile}&tab=all`}>
              <span className="kpi-icon tone-pri">
                <ScanLine size={16} />
              </span>
              <span className="grow t-13 w5">Scans log for {d.name.split(' ')[0]}</span>
            </Link>
            <Link className="list-row" to={`/referrals?id=${d.id}`}>
              <span className="kpi-icon tone-pri">
                <Users size={16} />
              </span>
              <span className="grow t-13 w5">Referral tree page</span>
            </Link>
            {helpdesk && (
              <button
                className="list-row"
                onClick={() =>
                  api
                    .post(`/applicators/${id}/reset-password`)
                    .then(() => toast(`Reset link sent to ${d.name.split(' ')[0]} on WhatsApp (valid 15 min)`))
                    .catch((e) => toast(errMsg(e), true))
                }
              >
                <span className="kpi-icon tone-pri">
                  <KeyRound size={16} />
                </span>
                <span className="grow">
                  <span className="t-13 w5" style={{ display: 'block' }}>
                    Reset password
                  </span>
                  <span className="t-12 c-sec">Sends a one-time reset link on WhatsApp</span>
                </span>
              </button>
            )}
            {helpdesk && d.lockedUntil && (
              <button
                className="list-row"
                onClick={() =>
                  api
                    .post(`/applicators/${id}/unlock`)
                    .then(() => (toast('Login unlocked'), p.reload()))
                    .catch((e) => toast(errMsg(e), true))
                }
              >
                <span className="kpi-icon tone-bad">
                  <Unlock size={16} />
                </span>
                <span className="grow">
                  <span className="t-13 w5" style={{ display: 'block' }}>
                    Unlock login
                  </span>
                  <span className="t-12 c-bad">Paused till {new Date(d.lockedUntil).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })} after wrong tries</span>
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {pan && (
        <Dialog title="Full PAN" onClose={() => setPan(null)}>
          <p className="t-title mono">{pan.pan}</p>
          <p className="t-13">Name on PAN: {pan.name}</p>
          <p className="t-12 c-sec">This view is saved in the Audit log.</p>
        </Dialog>
      )}
      {ask && (
        <ReasonDialog
          title={{ hold: `Hold ${d.name}’s cash?`, release: 'Release cash hold?', block: `Block ${d.name}?`, unblock: `Unblock ${d.name}?` }[ask]}
          sub={
            {
              hold: 'They cannot withdraw until an owner releases it. Same hold as fraud alerts.',
              release: 'They can withdraw again. Open fraud flags stay open.',
              block: 'They are logged out and cannot use the app. All data is kept.',
              unblock: 'They can log in and use the app again.',
            }[ask]
          }
          action={{ hold: 'Hold cash', release: 'Release', block: 'Block', unblock: 'Unblock' }[ask]}
          danger={ask === 'hold' || ask === 'block'}
          onClose={() => setAsk(null)}
          onSubmit={async (reason) => {
            if (ask === 'hold' || ask === 'release') await api.post(`/applicators/${id}/hold`, { hold: ask === 'hold', reason });
            else await api.post(`/applicators/${id}/block`, { blocked: ask === 'block', reason });
            toast('Done · saved in the Audit log');
            setAsk(null);
            p.reload();
          }}
        />
      )}
      {kycOk && <KycOkDialog id={id} name={d.name} panName={d.kyc.pan?.name ?? ''} onClose={() => setKycOk(false)} onDone={() => (setKycOk(false), p.reload())} />}
      {adjust && <AdjustDialog id={id} name={d.name} onClose={() => setAdjust(false)} onDone={() => (setAdjust(false), p.reload())} />}
    </>
  );
}

function AdjustDialog({ id, name, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [wallet, setWallet] = useState<'points' | 'runs'>('points');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = Number(amount);
  return (
    <Dialog title={`Goodwill / correction for ${name}`} onClose={onClose}>
      <div className="segmented">
        <button className={wallet === 'points' ? 'on' : ''} onClick={() => setWallet('points')}>
          Points
        </button>
        <button className={wallet === 'runs' ? 'on' : ''} onClick={() => setWallet('runs')}>
          Runs
        </button>
      </div>
      <div className="field">
        <label htmlFor="amt">Amount (use − to take away)</label>
        <input id="amt" className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ''))} placeholder="20 or -20" />
        <p className="hint">At most 10,000 at a time. Owners only. Saved in the Audit log.</p>
      </div>
      <div className="field">
        <label htmlFor="adr">Reason (the applicator sees this in their history)</label>
        <input id="adr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </div>
      {error && <p className="err">{error}</p>}
      <button
        className="btn primary lg block"
        disabled={!v || Math.abs(v) > 10000 || reason.trim().length < 3 || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ balance: number }>(`/applicators/${id}/adjust`, { wallet, amount: v, reason: reason.trim() });
            toast(`Done · new ${wallet} balance ${n(r.balance)}`);
            onDone();
          } catch (e) {
            setError(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {v > 0 ? `Give +${n(v)} ${wallet}` : v < 0 ? `Take ${n(v)} ${wallet}` : 'Save'}
      </button>
    </Dialog>
  );
}

/** D9b "Mark KYC ok": the app refused this UPI (name ≠ PAN); accounts checked it by hand. */
function KycOkDialog({ id, name, panName, onClose, onDone }: { id: string; name: string; panName: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [upiId, setUpiId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Mark KYC ok for ${name}`} onClose={onClose}>
      <p className="t-13 c-sec">
        PAN name: <b>{panName}</b>. Save their UPI only after you checked it is theirs (e.g. short name, or their own shop). Saved in the Audit log.
      </p>
      <div className="field">
        <label htmlFor="ku">UPI ID</label>
        <input id="ku" className="input" value={upiId} onChange={(e) => setUpiId(e.target.value.trim())} placeholder="raju1990@ybl" />
      </div>
      <div className="field">
        <label htmlFor="kn">How you checked</label>
        <input id="kn" className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Called him: Raju = Rajinder Kumar" />
      </div>
      {error && <p className="err">{error}</p>}
      <button
        className="btn primary lg block"
        disabled={busy || upiId.length < 4 || note.trim().length < 3}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ upi: { id: string; name: string } }>(`/applicators/${id}/kyc-ok`, { upiId, note: note.trim() });
            toast(`UPI saved · name on UPI: ${r.upi.name}`);
            onDone();
          } catch (e) {
            setError(errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Check UPI + save
      </button>
    </Dialog>
  );
}
