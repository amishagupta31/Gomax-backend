import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Banknote, Bell, Calendar, Camera, Check, ChevronRight, Copy, Eye, IdCard, LayoutGrid, LogOut, Monitor, ScanLine, Search, SlidersHorizontal, Truck, Wallet } from 'lucide-react';
import { api } from '../api';
import { useAuth, useStaff } from '../auth';
import { can, ROLE_LABEL } from '../roles';
import { useCounts, useHead } from '../Shell';
import { initials, inr, Loading, n, NotConnected, spacedMobile, useLoad, useToast } from '../ui';
import { BATCH_STATUS } from '../labels';
import { CouponLookup } from './Scans';
import type { Batch } from './Coupons';
import type { Row } from './Applicators';
import { checkOf, type Wd } from './Withdrawals';
import receipt from '../assets/3d/receipt.png';
import coin from '../assets/3d/coin.png';
import giftImg from '../assets/3d/wrapped-gift.png';
import warning from '../assets/3d/warning.png';

// M0–M7: the same web app under 600 px wide. Bottom tabs Home · Coupons · Approvals · Gifts · Me.
// Desktop-only tools are listed under Me › Desktop tools with a "Do this on desktop" sheet.

export function useIsPhone() {
  const q = '(max-width: 599px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setPhone(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return phone;
}

// ── M1 madm-home ──
export function MobileHome() {
  const staff = useStaff();
  const nav = useNavigate();
  useHead('Home');
  const d = useLoad<any>(() => api.get('/dashboard')).data;
  const waiting = useLoad<{ rows: Wd[] }>(() => (can(staff.role, '/withdrawals') ? api.get('/withdrawals?status=requested') : Promise.resolve({ rows: [] }))).data;
  const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  const tile = (to: string | null, img: string, value: string | number, label: string, sub: string, tone?: string) => {
    const body = (
      <>
        <div className="between">
          <img src={img} alt="" width={30} height={30} />
          {to && <ChevronRight size={16} color="var(--text-muted)" />}
        </div>
        <span className="v" style={{ color: tone }}>
          {value}
        </span>
        <span className="t-13 w5">{label}</span>
        <span className="t-12 c-sec">{sub}</span>
      </>
    );
    return to && can(staff.role, to.split('?')[0]!) ? (
      <Link to={to} className="m-tile" style={tone === 'var(--danger-text)' ? { borderColor: '#dc2626' } : undefined}>
        {body}
      </Link>
    ) : (
      <div className="m-tile">{body}</div>
    );
  };
  return (
    <>
      <div className="m-hero">
        <span className="avatar" style={{ width: 44, height: 44, borderRadius: 22, border: '2px solid var(--primary-500)', fontSize: 13 }}>
          {initials(staff.name)}
        </span>
        <div className="grow">
          <p className="t-title">
            {hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}, {staff.name.split(' ')[0]}
          </p>
          <div className="row g6 mt4">
            <span className="pill" style={{ background: 'rgba(255,255,255,0.14)', color: '#fff' }}>
              <Calendar size={13} />
              {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
            <span className="pill ok">
              <Check size={13} />
              {ROLE_LABEL[staff.role]}
            </span>
          </div>
        </div>
        <Link to={can(staff.role, '/scans') ? '/scans?tab=flags' : '/'} className="kpi-icon" style={{ width: 44, height: 44, borderRadius: 14, background: 'rgba(255,255,255,0.1)', color: '#fff' }} aria-label="Alerts">
          <Bell size={22} />
        </Link>
      </div>
      {!d ? (
        <div className="card" style={{ marginTop: -44 }}>
          <Loading />
        </div>
      ) : (
        <div className="m-tiles">
          {tile('/scans?tab=all', receipt, n(d.scans.added), 'Coupons scanned today', `${n(d.scans.failed)} failed tries`)}
          {tile('/withdrawals', coin, n(d.withdrawalsWaiting.n), 'Withdrawals waiting', `${inr(d.withdrawalsWaiting.amount)} · ${d.withdrawalsToPay.n} to pay →`, 'var(--primary-700)')}
          {tile('/gifts', giftImg, n(d.giftsToShip), 'Gift orders to ship', 'Booked + packed')}
          {tile('/scans?tab=flags', warning, n(d.openFlags), 'Fraud alerts', 'Check before paying', d.openFlags ? 'var(--danger-text)' : undefined)}
        </div>
      )}
      <div className="between">
        <p className="t-card w7">Needs you now</p>
        <Link className="link" to="/m/approvals">
          See all
        </Link>
      </div>
      <div className="card" style={{ padding: '4px 14px' }}>
        {(waiting?.rows ?? []).slice(0, 3).map((w) => {
          const c = checkOf(w);
          return (
            <button key={w.id} className="list-row" onClick={() => nav('/m/approvals')}>
              <span className="kpi-icon" style={{ width: 40, height: 40, borderRadius: 20, background: 'var(--primary-100)', color: 'var(--primary-700)' }}>
                <Banknote size={20} />
              </span>
              <span className="grow">
                <span className="t-body w5" style={{ display: 'block' }}>
                  {w.name} · {inr(w.amount)}
                </span>
                <span className="t-12 c-sec">Withdrawal · {c.review ? c.label.toLowerCase() : 'name matches UPI'}</span>
              </span>
              <span className={`pill ${c.review ? 'warn' : 'ok'}`}>{c.review ? 'Check' : 'Approve'}</span>
            </button>
          );
        })}
        {d && d.streakPhotosWaiting > 0 && can(staff.role, '/challenges') && (
          <button className="list-row" onClick={() => nav('/challenges?tab=photos')}>
            <span className="kpi-icon" style={{ width: 40, height: 40, borderRadius: 20, background: 'var(--primary-100)', color: 'var(--primary-700)' }}>
              <Camera size={20} />
            </span>
            <span className="grow">
              <span className="t-body w5" style={{ display: 'block' }}>
                {d.streakPhotosWaiting} streak photos
              </span>
              <span className="t-12 c-sec">Day photos waiting for review</span>
            </span>
            <span className="pill pri">Review</span>
          </button>
        )}
        {waiting && waiting.rows.length === 0 && !(d?.streakPhotosWaiting > 0) && <p className="t-13 c-sec" style={{ padding: '12px 0' }}>Nothing waiting. All clear.</p>}
      </div>
      <p className="t-card w7">Quick actions</p>
      <div className="m-quick">
        <Link to="/m/coupons">
          <span>
            <ScanLine size={20} />
          </span>
          Look up coupon
        </Link>
        <Link to="/m/me">
          <span>
            <Search size={20} />
          </span>
          Find an applicator
        </Link>
        <Link to="/gifts">
          <span>
            <Truck size={20} />
          </span>
          Ship a gift
        </Link>
      </div>
    </>
  );
}

// ── M2 approvals ──
export function MobileApprovals() {
  const staff = useStaff();
  const nav = useNavigate();
  const { counts } = useCounts();
  useHead('Approvals');
  const money = can(staff.role, '/withdrawals');
  const photos = staff.role === 'owner' || staff.role === 'ops';
  return (
    <>
      <div className="col g10">
        {money && (
          <Link className="card row g12" to="/withdrawals">
            <span className="kpi-icon tone-ok" style={{ width: 44, height: 44, borderRadius: 12 }}>
              <Banknote size={20} />
            </span>
            <span className="grow">
              <span className="t-card w6" style={{ display: 'block' }}>
                Cash · {counts?.withdrawals ?? 0} waiting
              </span>
              <span className="t-12 c-sec">Approve with PIN · hold with a reason</span>
            </span>
            <ChevronRight size={18} />
          </Link>
        )}
        {money && (
          <Link className="card row g12" to="/withdrawals?tab=approved">
            <span className="kpi-icon tone-info" style={{ width: 44, height: 44, borderRadius: 12 }}>
              <Wallet size={20} />
            </span>
            <span className="grow">
              <span className="t-card w6" style={{ display: 'block' }}>
                To pay
              </span>
              <span className="t-12 c-sec">Open the company UPI app pre-filled, then screenshot + UTR</span>
            </span>
            <ChevronRight size={18} />
          </Link>
        )}
        {photos && (
          <Link className="card row g12" to="/challenges?tab=photos">
            <span className="kpi-icon tone-pri" style={{ width: 44, height: 44, borderRadius: 12 }}>
              <Camera size={20} />
            </span>
            <span className="grow">
              <span className="t-card w6" style={{ display: 'block' }}>
                Photos · {counts?.photos ?? 0}
              </span>
              <span className="t-12 c-sec">Daily work photo streak</span>
            </span>
            <ChevronRight size={18} />
          </Link>
        )}
        {can(staff.role, '/applicators') && (
          <Link className="card row g12" to="/applicators?view=kyc">
            <span className="kpi-icon tone-warn" style={{ width: 44, height: 44, borderRadius: 12 }}>
              <IdCard size={20} />
            </span>
            <span className="grow">
              <span className="t-card w6" style={{ display: 'block' }}>
                KYC to check
              </span>
              <span className="t-12 c-sec">PAN added, UPI refused (name differs) — check and Mark KYC ok</span>
            </span>
            <ChevronRight size={18} />
          </Link>
        )}
        {!money && !photos && <p className="t-13 c-sec">Your login has nothing to approve.</p>}
      </div>
      <button className="btn ghost" onClick={() => nav('/')}>
        Back to Home
      </button>
    </>
  );
}

// ── M3 coupons ──
export function MobileCoupons() {
  const staff = useStaff();
  useHead('Coupons');
  const batches = useLoad<{ batches: Batch[] }>(() => (can(staff.role, '/coupons') ? api.get('/coupon-batches') : Promise.resolve({ batches: [] })));
  return (
    <>
      {can(staff.role, '/scans') ? <CouponLookup initial="" /> : <p className="t-13 c-sec">Your login cannot look up coupons.</p>}
      <p className="t-12 c-sec">Office only: look up a code the applicator sends. In the app, applicators can only scan or type.</p>
      {can(staff.role, '/coupons') && (
        <>
          <div className="between">
            <p className="t-card w7">Batches</p>
            <span className="pill">
              <Eye size={13} />
              View only
            </span>
          </div>
          {!batches.data && <Loading />}
          {batches.data?.batches.slice(0, 10).map((b) => {
            const pct = b.quantity ? Math.round((b.scanned / b.quantity) * 100) : 0;
            const st = BATCH_STATUS[b.status]!;
            return (
              <div key={b.id} className="card col g6">
                <div className="between">
                  <p className="t-card w6">
                    {b.ref} · {b.valuePoints} pt
                  </p>
                  <span className={`pill ${b.status === 'in_market' ? 'ok' : st.tone}`}>{b.status === 'in_market' ? 'Live' : st.label}</span>
                </div>
                <p className="t-12 c-sec">
                  {n(b.quantity)} coupons · {pct}% scanned
                </p>
                <div className="progress">
                  <i style={{ width: `${pct}%`, background: 'var(--success-text)' }} />
                </div>
              </div>
            );
          })}
          <div className="note" style={{ background: 'var(--surface-muted)', color: 'var(--text-secondary)' }}>
            <Monitor size={16} style={{ flex: 'none' }} />
            Create a new batch on desktop (Coupons → New batch). It needs value, quantity and print file.
          </div>
        </>
      )}
    </>
  );
}

// ── M5/M6 Me: search, key rules, alerts, desktop tools, log out ──
const RECENT_KEY = 'gomax-admin-recent';
const readRecent = (): Row[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
};
export const rememberApplicator = (r: Row) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([r, ...readRecent().filter((x) => x.id !== r.id)].slice(0, 5)));
  } catch {
    /* private mode */
  }
};

const DESKTOP_TOOLS: [string, string, string][] = [
  ['Coupons', 'Create coupon batch', 'Value, quantity, unique codes'],
  ['Coupons', 'Send coupons for printing', 'CSV print file'],
  ['Games & content', 'Spin odds & scratch rules', 'Prizes, odds, expiry'],
  ['Games & content', 'Challenges builder', 'New challenges & rewards'],
  ['Games & content', 'Home content', 'Hero cards, How GoMax works, T&C'],
  ['Games & content', 'WhatsApp templates', 'Messages & languages'],
  ['Catalogue & settings', 'Products & TDS', 'Add products, upload data sheets'],
  ['Catalogue & settings', 'Ranks & benefits', 'Points, spins, extra runs'],
  ['Catalogue & settings', 'Limits & referral', 'Withdraw limits, referral cap'],
  ['Catalogue & settings', 'Staff & dealer logins', 'Create / remove logins'],
  ['Catalogue & settings', 'Audit log', 'Every change, who & when'],
];

export function MobileMe() {
  const staff = useStaff();
  const { logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [view, setView] = useState<'me' | 'rules' | 'tools'>('me');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Row[] | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const recent = readRecent();
  const s = useLoad<{ settings: any }>(() => api.get('/settings')).data?.settings;
  useHead(view === 'rules' ? 'Key rules' : view === 'tools' ? 'Desktop tools' : 'Me');
  const open = (r: Row) => {
    rememberApplicator(r);
    nav(`/applicators/${r.id}`);
  };

  if (view === 'rules')
    return (
      <>
        <div className="note" style={{ background: 'var(--surface-muted)', color: 'var(--text-secondary)' }}>
          <Eye size={16} style={{ flex: 'none' }} />
          View only here. Owners change rules on desktop → Settings.
        </div>
        {!s ? (
          <Loading />
        ) : (
          <>
            <RuleGroup
              title="Cash (withdraw)"
              rows={[
                ['Minimum to withdraw', '1 pt = ₹1', `${n(s.withdraw.minPoints)} pts`],
                ['Max per request', '', inr(s.withdraw.maxPerRequest)],
                ['Max per month', 'Per applicator', inr(s.withdraw.maxPerMonth)],
              ]}
            />
            <RuleGroup
              title="Games"
              rows={[
                ['Scratch card', `For ${s.scratch.couponsPerCard} coupons in a day (12 am–12 am) · expires in ${s.scratch.expiryDays} days`, '1 a day'],
                ['Spin wheel odds', '100 runs = 0% (never)', s.spinOdds.map((o: { runs: number }) => o.runs).join(' · ')],
              ]}
            />
            <RuleGroup
              title="Coupons"
              rows={[
                ['Scan limit', 'Each coupon works once', '1 time'],
                ['Fraud check', 'Auto alert to owners', `${s.fraud.burstScans} in ${s.fraud.burstMinutes} min`],
              ]}
            />
            <RuleGroup
              title="Ranks & referral"
              rows={[
                ['Ranks', s.ranks.map((r: { name: string; min: number; spins: number }) => `${r.name} ${n(r.min)} · ${r.spins} spins`).join(' · '), `${s.ranks.length} ranks`],
                ['Referral', `+${s.referral.firstCouponBonusRuns} runs on friend’s 1st coupon · L1–L${s.referral.levels} earn ${s.referral.levelSharePct}% of points scanned below`, `${s.referral.monthlyCapRuns} / month`],
              ]}
            />
          </>
        )}
        <button className="btn" onClick={() => setView('me')}>
          Back
        </button>
      </>
    );

  if (view === 'tools')
    return (
      <>
        <div className="note" style={{ background: 'var(--surface-muted)', color: 'var(--text-secondary)' }}>
          <Monitor size={16} style={{ flex: 'none' }} />
          These are set up on a laptop. Tap any tool to see how.
        </div>
        {[...new Set(DESKTOP_TOOLS.map((t) => t[0]))].map((g) => (
          <div key={g} className="col g10">
            <p className="t-13 w7">{g}</p>
            <div className="card" style={{ padding: '4px 14px' }}>
              {DESKTOP_TOOLS.filter((t) => t[0] === g).map(([, t, sub]) => (
                <button key={t} className="list-row" onClick={() => setSheet(t)}>
                  <span className="kpi-icon tone-pri">
                    <LayoutGrid size={16} />
                  </span>
                  <span className="grow">
                    <span className="t-13 w5" style={{ display: 'block' }}>
                      {t}
                    </span>
                    <span className="t-12 c-sec">{sub}</span>
                  </span>
                  <span className="t-12 w6">Desktop ›</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <button className="btn" onClick={() => setView('me')}>
          Back
        </button>
        {sheet && (
          <div className="sheet-backdrop" onClick={() => setSheet(null)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <Monitor size={32} color="var(--primary-700)" />
              <p className="t-title w7">Do this on desktop</p>
              <p className="t-13">“{sheet}” needs a bigger screen. Open admin.gomax.in on a laptop.</p>
              <div className="row g10">
                <button
                  className="btn grow"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(window.location.origin)
                      .then(() => toast('Link copied'))
                      .catch(() => toast('Could not copy', true))
                  }
                >
                  <Copy size={16} />
                  Copy link
                </button>
                <button className="btn primary grow" onClick={() => setSheet(null)}>
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );

  return (
    <>
      {can(staff.role, '/applicators') && (
        <>
          <form
            className="field"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!q.trim()) return;
              const r = await api.get<{ rows: Row[] }>(`/applicators?limit=10&q=${encodeURIComponent(q.trim())}`);
              setResults(r.rows);
            }}
          >
            <label htmlFor="mq">Find an applicator</label>
            <div className="input-icon">
              <Search size={18} />
              <input id="mq" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile or invite code" />
            </div>
          </form>
          {results && (
            <div className="card" style={{ padding: '4px 14px' }}>
              {results.length === 0 && <p className="t-13 c-sec" style={{ padding: '12px 0' }}>No one found.</p>}
              {results.map((r) => (
                <PersonRow key={r.id} r={r} onClick={() => open(r)} />
              ))}
            </div>
          )}
          {!results && recent.length > 0 && (
            <>
              <p className="t-card w7">Recent</p>
              <div className="card" style={{ padding: '4px 14px' }}>
                {recent.map((r) => (
                  <PersonRow key={r.id} r={r} onClick={() => open(r)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
      <p className="t-card w7">My account</p>
      <div className="card" style={{ padding: '4px 14px' }}>
        <button className="list-row" onClick={() => setView('rules')}>
          <span className="kpi-icon tone-pri">
            <SlidersHorizontal size={16} />
          </span>
          <span className="grow">
            <span className="t-body w5" style={{ display: 'block' }}>
              Key rules
            </span>
            <span className="t-12 c-sec">Limits, scratch card, spin odds</span>
          </span>
          <ChevronRight size={18} />
        </button>
        <div className="list-row">
          <span className="kpi-icon tone-pri">
            <Bell size={16} />
          </span>
          <span className="grow">
            <span className="t-body w5" style={{ display: 'block' }}>
              Admin alerts
            </span>
            <span className="t-12 c-sec">Not connected yet — alerts per admin login on WhatsApp</span>
          </span>
        </div>
        <button className="list-row" onClick={() => setView('tools')}>
          <span className="kpi-icon tone-pri">
            <LayoutGrid size={16} />
          </span>
          <span className="grow">
            <span className="t-body w5" style={{ display: 'block' }}>
              Desktop tools
            </span>
            <span className="t-12 c-sec">Coupon batches, games, content, settings</span>
          </span>
          <ChevronRight size={18} />
        </button>
        <button className="list-row" onClick={logout}>
          <span className="kpi-icon tone-bad">
            <LogOut size={16} />
          </span>
          <span className="grow">
            <span className="t-body w5" style={{ display: 'block' }}>
              Log out
            </span>
            <span className="t-12 c-sec">
              {staff.name} · {ROLE_LABEL[staff.role]}
            </span>
          </span>
        </button>
      </div>
      <NotConnected what="admin alerts (which alerts go to which person)." />
    </>
  );
}

const PersonRow = ({ r, onClick }: { r: Row; onClick: () => void }) => (
  <button className="list-row" onClick={onClick}>
    <span className="avatar">{initials(r.name)}</span>
    <span className="grow">
      <span className="t-body w5" style={{ display: 'block' }}>
        {r.name}
      </span>
      <span className="t-12 c-sec">
        {r.city ?? ''} · {spacedMobile(r.mobile)}
      </span>
    </span>
    <ChevronRight size={18} />
  </button>
);

function RuleGroup({ title, rows }: { title: string; rows: [string, string, string][] }) {
  return (
    <div className="col g10">
      <p className="t-13 w7">{title}</p>
      <div className="card" style={{ padding: '4px 14px' }}>
        {rows.map(([t, s, v]) => (
          <div key={t} className="list-row">
            <span className="kpi-icon tone-pri">
              <Wallet size={16} />
            </span>
            <span className="grow">
              <span className="t-13 w5" style={{ display: 'block' }}>
                {t}
              </span>
              {s && <span className="t-12 c-sec">{s}</span>}
            </span>
            <span className="t-13 w6" style={{ textAlign: 'right', maxWidth: 120 }}>
              {v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
