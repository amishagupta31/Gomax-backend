import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BadgeCheck, Bell, Gift, LayoutDashboard, LogOut, QrCode, Search, UserRound } from 'lucide-react';
import { api } from './api';
import { useAuth, useStaff } from './auth';
import { can, NAV, ROLE_LABEL } from './roles';
import { initials } from './ui';

// D0: same left menu on every page, pages hidden by role. M0: under 600 px the
// menu becomes bottom tabs Home · Coupons · Approvals (centre, red badge) · Gifts · Me.

type Head = { title: ReactNode; sub?: ReactNode };
const HeadCtx = createContext<(h: Head) => void>(() => {});
/** Sets the top-bar title for the current page. */
export function useHead(title: ReactNode, sub?: ReactNode) {
  const set = useContext(HeadCtx);
  useEffect(() => set({ title, sub }), [set, title, sub]);
}

export type Counts = { withdrawals: number; gifts: number; flags: number; photos: number; approvals: number; coupons: number };
const CountsCtx = createContext<{ counts: Counts | null; refresh: () => void }>({ counts: null, refresh: () => {} });
export const useCounts = () => useContext(CountsCtx);

export default function Shell() {
  const staff = useStaff();
  const { logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [head, setHead] = useState<Head>({ title: '' });
  const [counts, setCounts] = useState<Counts | null>(null);
  const [q, setQ] = useState('');

  const refresh = () => {
    api
      .get('/dashboard')
      .then((d) =>
        setCounts({
          withdrawals: d.withdrawalsWaiting.n,
          gifts: d.giftsToShip,
          flags: d.openFlags,
          photos: d.streakPhotosWaiting,
          approvals: (staff.role === 'owner' || staff.role === 'accounts' ? d.withdrawalsWaiting.n : 0) + (staff.role === 'owner' || staff.role === 'ops' ? d.streakPhotosWaiting : 0),
          coupons: 0,
        }),
      )
      .catch(() => {});
  };
  // D1: numbers refresh every 5 min.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5 * 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  const badge = (key?: string) => {
    if (!counts || !key) return 0;
    return ({ withdrawals: counts.withdrawals, gifts: counts.gifts, flags: counts.flags, photos: counts.photos } as Record<string, number>)[key] ?? 0;
  };
  const items = NAV.filter((i) => can(staff.role, i.to));
  const groups = [...new Set(items.map((i) => i.group))];

  // Top-bar search: a coupon code opens the lookup, anything else searches applicators.
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    const code = v.replace(/[\s-]/g, '').toUpperCase().replace(/^GMX(?=.{8}$)/, '');
    if (/^[A-Z2-9]{8}$/.test(code) && /[A-Z]/.test(code) && can(staff.role, '/scans')) nav(`/scans?code=${encodeURIComponent(code)}`);
    else if (can(staff.role, '/applicators')) nav(`/applicators?q=${encodeURIComponent(v)}`);
    else if (can(staff.role, '/scans')) nav(`/scans?q=${encodeURIComponent(v)}`);
    setQ('');
  };

  return (
    <HeadCtx.Provider value={setHead}>
      <CountsCtx.Provider value={{ counts, refresh }}>
        <div className="shell">
          <nav className="sidebar" aria-label="Main menu">
            <div className="logo">
              <div className="logo-mark">G</div>
              <div>
                <p className="logo-name">GoMax Admin</p>
                <p className="logo-sub">admin.gomax.in</p>
              </div>
            </div>
            {groups.map((g) => (
              <div key={g} className="col" style={{ gap: 1 }}>
                <p className="nav-group">{g}</p>
                {items
                  .filter((i) => i.group === g)
                  .map((i) => {
                    const b = badge(i.badge);
                    return (
                      <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <i.icon size={16} />
                        <span className="grow">{i.label}</span>
                        {b > 0 && <span className="nav-badge">{b}</span>}
                      </NavLink>
                    );
                  })}
              </div>
            ))}
            <div className="user-chip" style={{ marginTop: 'auto' }}>
              <div className="avatar">{initials(staff.name)}</div>
              <div className="grow">
                <p className="t-13 w6 ellipsis">{staff.name}</p>
                <p className="t-12 ellipsis" style={{ color: 'var(--side-sub)' }}>
                  {ROLE_LABEL[staff.role]}
                </p>
              </div>
              <button onClick={logout} aria-label="Log out" title="Log out">
                <LogOut size={16} />
              </button>
            </div>
          </nav>

          <div className="main">
            <header className={`topbar ${loc.pathname === '/' && staff.role !== 'factory' ? 'home' : ''}`}>
              <div className="grow">
                <h1 className="t-page ellipsis">{head.title}</h1>
                {head.sub && <p className="t-12 c-sec ellipsis d-only">{head.sub}</p>}
              </div>
              <form className="search" onSubmit={search} role="search">
                <Search size={16} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Coupon code, mobile or name…" aria-label="Search" />
                <span className="kbd">↵</span>
              </form>
              <button className="icon-btn" aria-label="Fraud alerts" onClick={() => nav(can(staff.role, '/scans') ? '/scans?tab=flags' : '/')}>
                <Bell size={18} />
                {(counts?.flags ?? 0) > 0 && <span className="dot" />}
              </button>
              <div className="avatar d-only" style={{ width: 40, height: 40, borderRadius: 20 }} title={staff.name}>
                {initials(staff.name)}
              </div>
            </header>
            <main className="content">
              <Outlet />
            </main>
          </div>

          <nav className="tabbar" aria-label="Tabs">
            <NavLink to="/" end>
              <LayoutDashboard size={22} />
              Home
            </NavLink>
            <NavLink to="/m/coupons">
              <QrCode size={22} />
              Coupons
            </NavLink>
            <NavLink to="/m/approvals" className={({ isActive }) => `centre ${isActive ? 'active' : ''}`}>
              <span className="ring">
                <BadgeCheck size={26} />
                {(counts?.approvals ?? 0) > 0 && <span className="tab-badge">{counts!.approvals}</span>}
              </span>
              Approvals
            </NavLink>
            <NavLink to="/gifts">
              <Gift size={22} />
              Gifts
            </NavLink>
            <NavLink to="/m/me">
              <UserRound size={22} />
              Me
            </NavLink>
          </nav>
        </div>
      </CountsCtx.Provider>
    </HeadCtx.Provider>
  );
}
