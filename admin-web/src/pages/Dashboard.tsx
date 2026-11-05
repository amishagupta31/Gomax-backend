import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, Banknote, Camera, Check, ChevronRight, Download, Gift, HardHat, Info, QrCode, ScanLine, TriangleAlert, UserPlus, Wallet } from 'lucide-react';
import { api, download } from '../api';
import { useStaff } from '../auth';
import { flagText, STEP, type Flag } from '../labels';
import { can } from '../roles';
import { useCounts, useHead } from '../Shell';
import { ago, ErrorBox, errMsg, inr, initials, Loading, n, spacedMobile, useLoad, useToast } from '../ui';
import scrollImg from '../assets/3d/scroll.png';
import giftImg from '../assets/3d/wrapped-gift.png';
import { MobileHome, useIsPhone } from './Mobile';

// D1 Dashboard (owner, 21:6053) · D1b factory login (21:6496). "Each role sees its own home."
type Dash = {
  day: string;
  scans: { added: number; points: number; failed: number };
  newApplicators: number;
  withdrawalsWaiting: { n: number; amount: number };
  withdrawalsToPay: { n: number; amount: number };
  giftsToShip: number;
  openFlags: number;
  streakPhotosWaiting: number;
  pointsLiability: number | null;
};

const greeting = () => {
  const h = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const today = () => new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

export default function Dashboard() {
  const staff = useStaff();
  const phone = useIsPhone();
  if (staff.role === 'factory') return <FactoryHome />;
  return phone ? <MobileHome /> : <OwnerHome />;
}

function OwnerHome() {
  const staff = useStaff();
  const nav = useNavigate();
  useHead(`${greeting()}, ${staff.name.split(' ')[0]}`, `${today()} · data updates every 5 min`);
  const dash = useLoad<Dash>(() => api.get('/dashboard'));
  const ins = useLoad<Insights | null>(() => (staff.role === 'owner' || staff.role === 'accounts' || staff.role === 'helpline' ? api.get('/dashboard/insights') : Promise.resolve(null)));
  const [chart, setChart] = useState<'coupons' | 'points'>('coupons');
  const flags = useLoad<{ flags: Flag[] }>(() => (can(staff.role, '/scans') ? api.get('/fraud-flags?limit=4') : Promise.resolve({ flags: [] })));
  const batches = useLoad<{ batches: { id: number; ref: string; status: string; quantity: number }[] }>(() => (can(staff.role, '/coupons') ? api.get('/coupon-batches') : Promise.resolve({ batches: [] })));
  const d = dash.data;
  const toPrint = batches.data?.batches.filter((b) => b.status === 'generated') ?? [];

  if (dash.error) return <ErrorBox error={dash.error} retry={dash.reload} />;

  const actions = [
    can(staff.role, '/withdrawals') && d && d.withdrawalsWaiting.n > 0 && { to: '/withdrawals', icon: Banknote, tone: 'tone-ok', title: `${d.withdrawalsWaiting.n} withdrawals to approve`, sub: `Accounts · ${inr(d.withdrawalsWaiting.amount)}` },
    can(staff.role, '/withdrawals') && d && d.withdrawalsToPay.n > 0 && { to: '/withdrawals?tab=approved', icon: Wallet, tone: 'tone-info', title: `${d.withdrawalsToPay.n} approved, to pay`, sub: `Accounts · ${inr(d.withdrawalsToPay.amount)}` },
    can(staff.role, '/gifts') && d && d.giftsToShip > 0 && { to: '/gifts', icon: Gift, tone: 'tone-gift', title: `${d.giftsToShip} gifts to pack or ship`, sub: 'Factory · Gifts & courier' },
    can(staff.role, '/scans') && d && d.openFlags > 0 && { to: '/scans?tab=flags', icon: TriangleAlert, tone: 'tone-bad', title: `${d.openFlags} fraud alert${d.openFlags > 1 ? 's' : ''}`, sub: 'Owners · Scans log' },
    can(staff.role, '/challenges') && d && d.streakPhotosWaiting > 0 && { to: '/challenges?tab=photos', icon: Camera, tone: 'tone-navy', title: `${d.streakPhotosWaiting} streak photos to check`, sub: 'Challenges · photo review' },
    ...toPrint.map((b) => ({ to: '/coupons', icon: QrCode, tone: 'tone-pri', title: `Batch ${b.ref} ready to print`, sub: `Factory · ${n(b.quantity)} coupons` })),
  ].filter(Boolean) as { to: string; icon: typeof Banknote; tone: string; title: string; sub: string }[];

  return (
    <>
      <div className="between wrap">
        <div className="segmented" role="tablist" aria-label="Period">
          <button className="on">Today</button>
          <button disabled title="Not connected yet — the API returns today only">This week</button>
          <button disabled title="Not connected yet — the API returns today only">This month</button>
          <button disabled title="Not connected yet — the API returns today only">Custom</button>
        </div>
        <div className="row g10 d-only">
          <span className="pill">All areas</span>
          <button className="btn" disabled title="Not connected yet">
            <Download size={16} />
            Download report
          </button>
        </div>
      </div>

      {!d ? (
        <div className="card">
          <Loading rows={4} />
        </div>
      ) : (
        <>
          <div className="grid grid-4 m2">
            <div className="card kpi">
              <div className="row g10">
                <span className="kpi-icon tone-pri">
                  <HardHat size={16} />
                </span>
                <span className="t-13 c-sec">Active applicators (last 30 days)</span>
              </div>
              <p className="t-big">{ins.data ? n(ins.data.activeApplicators30d) : '—'}</p>
              <p className="t-12 c-ok">
                +{n(d.newApplicators)} joined today{ins.data ? ` · ${n(ins.data.registered)} registered` : ''}
              </p>
            </div>
            <div className="card kpi">
              <div className="row g10">
                <span className="kpi-icon tone-pri">
                  <ScanLine size={16} />
                </span>
                <span className="t-13 c-sec">Coupons scanned today</span>
              </div>
              <p className="t-big">{n(d.scans.added)}</p>
              <p className="t-12 c-sec">
                {n(d.scans.points)} points added · {n(d.scans.failed)} failed tries
              </p>
            </div>
            {d.pointsLiability !== null && (
              <div className="card kpi">
                <div className="row g10">
                  <span className="kpi-icon tone-warn">
                    <Wallet size={16} />
                  </span>
                  <span className="t-13 c-sec">Points liability</span>
                </div>
                <p className="t-big">{inr(d.pointsLiability)}</p>
                <p className="t-12 c-sec">Points in applicator wallets not yet withdrawn (1 pt = ₹1)</p>
              </div>
            )}
            <div className="card kpi">
              <div className="row g10">
                <span className="kpi-icon tone-ok">
                  <Banknote size={16} />
                </span>
                <span className="t-13 c-sec">Withdrawals waiting</span>
              </div>
              <p className="t-big">
                {n(d.withdrawalsWaiting.n)} · {inr(d.withdrawalsWaiting.amount)}
              </p>
              <p className="t-12 c-bad">
                {d.withdrawalsToPay.n} approved, to pay · {inr(d.withdrawalsToPay.amount)}
              </p>
            </div>
          </div>

          <div className="grid grid-4 m2">
            <MiniKpi to="/gifts" icon={<Gift size={18} />} tone="tone-gift" value={d.giftsToShip} label="Gift orders to pack or ship" sub="Booked + packed" subClass="c-info" />
            <MiniKpi to="/scans?tab=flags" icon={<TriangleAlert size={18} />} tone="tone-bad" value={d.openFlags} label="Fraud alerts" sub="Cash on hold until an owner decides" subClass="c-bad" />
            <MiniKpi to="/applicators" icon={<UserPlus size={18} />} tone="tone-pri" value={d.newApplicators} label="New sign-ups today" sub="" subClass="c-pri" />
            <MiniKpi to="/challenges?tab=photos" icon={<Camera size={18} />} tone="tone-info" value={d.streakPhotosWaiting} label="Streak photos to review" sub="Daily work photo streak" subClass="" />
          </div>
        </>
      )}

      <div className="grid grid-main">
        <div className="card" style={{ position: 'relative' }}>
          <div className="card-hd">
            <div>
              <p className="t-card w7">Coupons scanned — last 14 days</p>
              <p className="t-12 c-sec">All areas · 1 coupon = 1 scan · each coupon only once</p>
            </div>
          </div>
          {ins.data ? <Chart daily={ins.data.daily} metric={chart} onMetric={setChart} /> : ins.error ? <ErrorBox error={ins.error} retry={ins.reload} /> : <Loading rows={4} />}
        </div>
        <div className="card">
          <p className="t-card w7">Needs action now</p>
          <p className="t-12 c-sec">Tap a row to open the page</p>
          <div className="mt12">
            {!d && <Loading />}
            {d && actions.length === 0 && <p className="t-13 c-sec">Nothing waiting. All clear.</p>}
            {actions.map((a) => (
              <button key={a.title} className="list-row" onClick={() => nav(a.to)}>
                <span className={`kpi-icon ${a.tone}`} style={{ width: 36, height: 36, borderRadius: 10 }}>
                  <a.icon size={18} />
                </span>
                <span className="grow">
                  <span className="t-13 w6" style={{ display: 'block' }}>
                    {a.title}
                  </span>
                  <span className="t-12 c-sec">{a.sub}</span>
                </span>
                <ChevronRight size={16} color="var(--text-muted)" />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-main">
        <div className="card">
          <div className="card-hd">
            <p className="t-card w7">Top applicators — this month</p>
            {can(staff.role, '/applicators') && (
              <Link className="link" to="/applicators">
                See all applicators
              </Link>
            )}
          </div>
          {!ins.data ? (
            <Loading />
          ) : ins.data.topApplicators.length === 0 ? (
            <p className="t-13 c-sec">No coupons scanned this month yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="tbl cards">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Applicator</th>
                    <th>City</th>
                    <th className="num">Coupons</th>
                    <th className="num">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {ins.data.topApplicators.slice(0, 6).map((a, i) => (
                    <tr key={a.id} className="click" onClick={() => can(staff.role, '/applicators') && nav(`/applicators/${a.id}`)}>
                      <td data-l="#">{i + 1}</td>
                      <td data-l="Applicator">
                        <div className="person">
                          <span className="avatar">{initials(a.name)}</span>
                          <div>
                            <p className="w6">{a.name}</p>
                            <p className="t-12 c-sec">{spacedMobile(a.mobile)}</p>
                          </div>
                        </div>
                      </td>
                      <td data-l="City">{a.city ?? '—'}</td>
                      <td data-l="Coupons" className="num">
                        {n(a.coupons)}
                      </td>
                      <td data-l="Points" className="num">
                        {n(a.points)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {can(staff.role, '/scans') && (
          <div className="card">
            <div className="card-hd">
              <div>
                <p className="t-card w7">Fraud alerts</p>
                <p className="t-12 c-sec">Auto-flagged · owner decides</p>
              </div>
              {d && d.openFlags > 0 && <span className="pill bad">{d.openFlags} open</span>}
            </div>
            {flags.loading && <Loading />}
            {flags.error && <ErrorBox error={flags.error} retry={flags.reload} />}
            {flags.data?.flags.length === 0 && <p className="t-13 c-sec">No open alerts.</p>}
            <div className="col g12">
              {flags.data?.flags.map((f) => {
                const t = flagText(f);
                return (
                  <Link key={f.id} to="/scans?tab=flags" className="alert-box">
                    <TriangleAlert size={16} style={{ flex: 'none', marginTop: 1 }} />
                    <div className="grow">
                      <p className="t-13 w6">{t.title}</p>
                      <p className="t-12" style={{ color: 'var(--text-secondary)' }}>
                        {t.sub}
                      </p>
                      <p className="t-12 c-muted">{ago(f.createdAt)}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

type Insights = {
  daily: { day: string; coupons: number; points: number }[];
  activeApplicators30d: number;
  registered: number;
  topApplicators: { id: string; name: string; mobile: string; city: string | null; coupons: number; points: number }[];
};

/** D1 "Coupons scanned — last 14 days": today in full colour, other days light. */
function Chart({ daily, metric, onMetric }: { daily: Insights['daily']; metric: 'coupons' | 'points'; onMetric: (m: 'coupons' | 'points') => void }) {
  const max = Math.max(1, ...daily.map((d) => d[metric]));
  const avg = Math.round(daily.reduce((s, d) => s + d[metric], 0) / daily.length);
  const today = daily.at(-1)!;
  return (
    <>
      <div style={{ position: 'absolute', right: 20, top: 20 }} className="d-only">
        <div className="segmented">
          <button className={metric === 'coupons' ? 'on' : ''} onClick={() => onMetric('coupons')}>
            Coupons
          </button>
          <button className={metric === 'points' ? 'on' : ''} onClick={() => onMetric('points')}>
            Points
          </button>
        </div>
      </div>
      <div className="bars" role="img" aria-label={`${metric} per day, last ${daily.length} days`}>
        {daily.map((d, i) => (
          <div key={d.day} className={`b ${i === daily.length - 1 ? 'today' : ''}`} title={`${d.day}: ${n(d[metric])}`}>
            <i style={{ height: `${(d[metric] / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="bar-labels">
        {daily.map((d) => (
          <span key={d.day}>{Number(d.day.slice(8))}</span>
        ))}
      </div>
      <div className="row g16 mt12 t-12">
        <span className="row g6">
          <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--primary-700)' }} />
          Today {n(today[metric])}
        </span>
        <span className="row g6">
          <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--primary-100)' }} />
          {daily.length}-day avg {n(avg)}
        </span>
      </div>
    </>
  );
}

function MiniKpi({ to, icon, tone, value, label, sub, subClass }: { to: string; icon: React.ReactNode; tone: string; value: number; label: string; sub: string; subClass: string }) {
  const staff = useStaff();
  const body = (
    <>
      <span className={`kpi-icon ${tone}`}>{icon}</span>
      <div className="grow">
        <p className="t-num">{n(value)}</p>
        <p className="t-12 c-sec">{label}</p>
        {sub && <p className={`t-12 ${subClass}`}>{sub}</p>}
      </div>
    </>
  );
  return can(staff.role, to.split('?')[0]) ? (
    <Link to={to} className="card mini">
      {body}
    </Link>
  ) : (
    <div className="card mini">{body}</div>
  );
}

// D1b: factory sees printing + shipping tasks only.
type Order = { id: string; giftName: string; step: string; dates: { booked: string }; courier: { name: string; awb: string } | null; address: Record<string, string> | null; applicator: { name: string; mobile: string }; stale: boolean };
function FactoryHome() {
  const staff = useStaff();
  const toast = useToast();
  const { refresh } = useCounts();
  useHead(`Hello ${staff.name.split(' ')[0]}`, 'Factory login · you see only printing and shipping');
  const batches = useLoad<{ batches: { id: number; ref: string; status: string; quantity: number; valuePoints: number; createdAt: string }[] }>(() => api.get('/coupon-batches'));
  const orders = useLoad(async () => {
    const [b, p, s] = await Promise.all(['booked', 'packed', 'shipped'].map((step) => api.get<{ rows: Order[]; counts: Record<string, number> }>(`/gift-orders?step=${step}`)));
    return { rows: [...b.rows, ...p.rows, ...s.rows], counts: b.counts };
  });
  const toPrint = batches.data?.batches.filter((b) => b.status === 'generated') ?? [];
  const printed = batches.data?.batches.filter((b) => b.status === 'printed') ?? [];
  const oldest = orders.data?.rows.filter((o) => o.step === 'booked').sort((a, b) => a.dates.booked.localeCompare(b.dates.booked))[0];
  const c = orders.data?.counts ?? {};

  const mark = async (id: number, status: 'printed' | 'in_market') => {
    try {
      await api.patch(`/coupon-batches/${id}`, { status });
      toast(status === 'printed' ? 'Marked as printed' : 'Batch is now in market');
      batches.reload();
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
  const pack = async (id: string) => {
    try {
      await api.post(`/gift-orders/${id}/pack`);
      toast(`${id} marked packed · applicator told on WhatsApp`);
      orders.reload();
      refresh();
    } catch (e) {
      toast(errMsg(e), true);
    }
  };

  return (
    <>
      <div className="note" style={{ color: 'var(--navy-brand)', fontSize: 13, lineHeight: '18px', fontWeight: 500, padding: '14px 18px' }}>
        <Info size={18} style={{ flex: 'none' }} />
        Your login shows only Coupons (printing), Scans log (view) and Gifts &amp; courier. Owners set this in Settings → Staff logins.
      </div>
      <div className="grid grid-2">
        <div className="card col g12" style={{ padding: 24 }}>
          <div className="row g12">
            <img src={scrollImg} alt="" width={44} height={44} />
            <div>
              <p className="t-title w7">Coupon batches to print</p>
              <p className="t-13 c-sec">{toPrint[0] ? `${toPrint[0].ref} · ${toPrint[0].valuePoints} pt · made ${ago(toPrint[0].createdAt)}` : printed[0] ? `${printed[0].ref} printed — move it to In market when it leaves the factory` : 'Nothing to print'}</p>
            </div>
          </div>
          <p style={{ fontSize: 36, lineHeight: '40px', fontWeight: 700, letterSpacing: -0.54 }}>
            {toPrint.length} batch{toPrint.length === 1 ? '' : 'es'} · {n(toPrint.reduce((s, b) => s + b.quantity, 0))} coupons
          </p>
          <div className="row g10 wrap">
            {toPrint[0] ? (
              <>
                <button className="btn primary" onClick={() => download(`/coupon-batches/${toPrint[0].id}/print.pdf`, `${toPrint[0].ref}.pdf`).catch((e) => toast(errMsg(e), true))}>
                  <Download size={16} />
                  Download print PDF
                </button>
                <button className="btn" onClick={() => download(`/coupon-batches/${toPrint[0].id}/export.csv`, `${toPrint[0].ref}.csv`).catch((e) => toast(errMsg(e), true))}>
                  CSV
                </button>
                <button className="btn" onClick={() => mark(toPrint[0].id, 'printed')}>
                  <Check size={16} />
                  Mark as printed
                </button>
              </>
            ) : printed[0] ? (
              <button className="btn" onClick={() => mark(printed[0].id, 'in_market')}>
                <Check size={16} />
                Mark {printed[0].ref} in market
              </button>
            ) : null}
          </div>
        </div>
        <div className="card col g12" style={{ padding: 24 }}>
          <div className="row g12">
            <img src={giftImg} alt="" width={44} height={44} />
            <div>
              <p className="t-title w7">Gifts to pack and ship</p>
              <p className="t-13 c-sec">{oldest ? `Oldest booked ${ago(oldest.dates.booked)} (${oldest.applicator.name}${oldest.address?.city ? ` · ${oldest.address.city}` : ''})` : 'No gifts waiting'}</p>
            </div>
          </div>
          <p style={{ fontSize: 36, lineHeight: '40px', fontWeight: 700, letterSpacing: -0.54 }}>
            {n(c.booked ?? 0)} to pack · {n(c.packed ?? 0)} to ship
          </p>
          <div>
            <Link className="btn primary" to="/gifts">
              <ArrowRight size={16} />
              Open gift orders
            </Link>
          </div>
        </div>
      </div>

      <div className="card col g16">
        <div className="between">
          <p className="t-card w7">Gift orders in progress</p>
          <Link className="link" to="/gifts">
            Open board
          </Link>
        </div>
        {orders.loading && <Loading />}
        {orders.error && <ErrorBox error={orders.error} retry={orders.reload} />}
        {orders.data && (
          <div className="table-wrap">
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Applicator</th>
                  <th>Gift</th>
                  <th>City</th>
                  <th>Status</th>
                  <th>Do next</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="c-sec">
                      No open gift orders.
                    </td>
                  </tr>
                )}
                {orders.data.rows.slice(0, 12).map((o) => (
                  <tr key={o.id}>
                    <td data-l="Order">{o.id}</td>
                    <td data-l="Applicator">
                      <div className="person">
                        <span className="avatar">{initials(o.applicator.name)}</span>
                        <div>
                          <p className="w6">{o.applicator.name}</p>
                          <p className="t-12 c-sec">{spacedMobile(o.applicator.mobile)}</p>
                        </div>
                      </div>
                    </td>
                    <td data-l="Gift">{o.giftName}</td>
                    <td data-l="City">{o.address?.city ?? '—'}</td>
                    <td data-l="Status">
                      <span className={`pill ${STEP[o.step]?.tone}`}>
                        {STEP[o.step]?.label}
                        {o.courier ? ` · ${o.courier.name}` : ''}
                      </span>
                    </td>
                    <td data-l="Do next">
                      {o.step === 'booked' ? (
                        <button className="btn sm" onClick={() => pack(o.id)}>
                          Mark packed
                        </button>
                      ) : (
                        <Link className="btn sm" to={`/gifts?order=${o.id}`}>
                          {o.step === 'packed' ? 'Add AWB' : 'Add proof photo'}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
