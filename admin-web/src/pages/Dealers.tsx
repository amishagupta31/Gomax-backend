import { useState } from 'react';
import { CircleCheck, Copy, Download, Info, KeyRound, Landmark, MessageCircle, MoreHorizontal, Phone, Power, Search, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useStaff } from '../auth';
import { useHead } from '../Shell';
import { ago, Client, date, Drawer, Empty, ErrorBox, errMsg, Loading, n, ReasonDialog, spacedMobile, useLoad, useToast } from '../ui';

// D10 Dealers — list (21:18147) · create login drawer (21:18377) · login created +
// share on WhatsApp (21:18688) · reset password (21:18964) · deactivate (21:19254).
// Dealers cannot sign up; owners create logins, helpline can reset passwords.
type Dealer = {
  id: string;
  loginId: string;
  firm: string;
  ownerName: string;
  mobile: string;
  gst: string | null;
  area: string;
  areaTeam: string | null;
  active: boolean;
  deactivatedReason: string | null;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};
type Issued = { dealer: Dealer; tempPassword: string; kind: 'created' | 'reset' };
const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GST_STATE: Record<string, string> = { '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh' };
const APP_LINK = 'gomax.in/app';

const shareText = (i: Issued) =>
  i.kind === 'created'
    ? `Namaste ${i.dealer.firm}! Your GoMax dealer account is ready.\nLogin ID: ${i.dealer.loginId}\nPassword: ${i.tempPassword} (change it after first login)\nApp: ${APP_LINK}\nHelp: GoMax helpline 92158 44410`
    : `Namaste ${i.dealer.firm}! Your GoMax dealer password was reset.\nLogin ID: ${i.dealer.loginId}\nNew password: ${i.tempPassword} (change it after login)\nHelp: GoMax helpline 92158 44410`;
const waLink = (i: Issued) => `https://wa.me/91${i.dealer.mobile}?text=${encodeURIComponent(shareText(i))}`;

export default function Dealers() {
  const staff = useStaff();
  const toast = useToast();
  const owner = staff.role === 'owner';
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [area, setArea] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [deact, setDeact] = useState<Dealer | null>(null);
  const all = useLoad<{ rows: Dealer[] }>(() => api.get('/dealers'));
  const list = useLoad<{ rows: Dealer[] }>(() => api.get(`/dealers?status=${status}${search ? `&q=${encodeURIComponent(search)}` : ''}${area ? `&area=${area}` : ''}`), [status, search, area]);
  const everyone = all.data?.rows ?? [];
  const areas = [...new Set(everyone.map((d) => d.area))].sort();
  useHead('Dealers', `${everyone.length} dealers · ${everyone.filter((d) => d.lastLoginAt).length} using the app · ${everyone.filter((d) => d.active && !d.lastLoginAt).length} never logged in`);
  const reload = () => (all.reload(), list.reload());

  const reset = async (d: Dealer) => {
    setMenu(null);
    try {
      const r = await api.post<{ dealer: Dealer; tempPassword: string }>(`/dealers/${d.id}/reset-password`);
      setIssued({ ...r, kind: 'reset' });
      reload();
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
  const exportCsv = () => {
    const rows = list.data?.rows ?? [];
    const head = 'login_id,firm,owner,mobile,gst,area,area_team,active,last_login,created';
    const lines = rows.map((d) => [d.loginId, d.firm, d.ownerName, d.mobile, d.gst ?? '', d.area, d.areaTeam ?? '', d.active, d.lastLoginAt ?? '', d.createdAt].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'dealers.csv' }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="grid grid-4 m2">
        <Kpi label="Dealers" value={everyone.length} sub={`across ${areas.length} areas`} />
        <Kpi label="Using the app" value={everyone.filter((d) => d.lastLoginAt).length} sub="dealer app: phase 2" />
        <Kpi label="Never logged in" value={everyone.filter((d) => d.active && !d.lastLoginAt).length} sub="resend login on WhatsApp" tone="var(--warning-text)" />
        <Kpi label="Deactivated" value={everyone.filter((d) => !d.active).length} sub="cannot log in" />
      </div>
      <div className="between wrap">
        <div className="row wrap g10">
          <form
            className="row g6"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <div className="search" style={{ background: '#fff', border: '1px solid var(--border-strong)' }}>
              <Search size={16} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Firm, owner, mobile or Login ID…" aria-label="Search dealers" />
            </div>
          </form>
          <select className="select" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area">
            <option value="">All areas</option>
            {areas.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            <option value="all">Status: All</option>
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
          </select>
        </div>
        <div className="row g10">
          <button className="btn" onClick={exportCsv} disabled={!list.data?.rows.length}>
            <Download size={16} />
            Export
          </button>
          {owner && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <UserPlus size={16} />
              Create dealer login
            </button>
          )}
        </div>
      </div>
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      <div className="card flush">
        {list.loading && !list.data ? (
          <div style={{ padding: 20 }}>
            <Loading rows={5} />
          </div>
        ) : !list.data?.rows.length ? (
          <Empty icon={<Landmark size={28} />} title={everyone.length ? 'No dealers match' : 'No dealer logins yet'} sub={owner ? 'Create the first dealer login — the dealer gets the Login ID + password on WhatsApp.' : 'Owners create dealer logins.'} />
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Dealer firm / owner</th>
                  <th>Login ID</th>
                  <th>Area</th>
                  <th>Area team</th>
                  <th>Last login</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((d) => (
                  <tr key={d.id}>
                    <td data-l="Dealer">
                      <p className="w6">{d.firm}</p>
                      <p className="t-12 c-sec">
                        {d.ownerName} · {spacedMobile(d.mobile)}
                      </p>
                    </td>
                    <td data-l="Login ID" className="mono">
                      {d.loginId}
                    </td>
                    <td data-l="Area">{d.area}</td>
                    <td data-l="Area team">{d.areaTeam ?? '—'}</td>
                    <td data-l="Last login">{d.lastLoginAt ? ago(d.lastLoginAt) : 'Never'}</td>
                    <td data-l="Status">
                      {!d.active ? (
                        <span className="pill bad" title={d.deactivatedReason ?? undefined}>
                          Deactivated
                        </span>
                      ) : !d.lastLoginAt ? (
                        <span className="pill warn">Never logged in</span>
                      ) : (
                        <span className="pill ok">Active</span>
                      )}
                    </td>
                    <td style={{ position: 'relative', width: 48 }}>
                      <button className="btn ghost sm" aria-label={`Actions for ${d.firm}`} onClick={() => setMenu(menu === d.id ? null : d.id)}>
                        <MoreHorizontal size={16} />
                      </button>
                      {menu === d.id && (
                        <div className="card col g4" style={{ position: 'absolute', right: 8, top: 44, zIndex: 10, padding: 6, width: 220, boxShadow: '0 10px 30px rgba(10,22,40,.15)' }}>
                          <a className="btn ghost sm" style={{ justifyContent: 'flex-start' }} href={`tel:+91${d.mobile}`}>
                            <Phone size={14} /> Call {d.ownerName.split(' ')[0]}
                          </a>
                          {d.active && (
                            <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => reset(d)}>
                              <KeyRound size={14} /> Reset password
                            </button>
                          )}
                          {owner && d.active && (
                            <button
                              className="btn ghost sm danger"
                              style={{ justifyContent: 'flex-start' }}
                              onClick={() => {
                                setMenu(null);
                                setDeact(d);
                              }}
                            >
                              <Power size={14} /> Deactivate
                            </button>
                          )}
                          {owner && !d.active && (
                            <button
                              className="btn ghost sm"
                              style={{ justifyContent: 'flex-start' }}
                              onClick={() => {
                                setMenu(null);
                                api
                                  .post(`/dealers/${d.id}/reactivate`)
                                  .then(() => (toast(`${d.firm} can log in again`), reload()))
                                  .catch((e) => toast(errMsg(e), true));
                              }}
                            >
                              <Power size={14} /> Reactivate
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="note" style={{ fontSize: 13, lineHeight: '18px', color: 'var(--navy-brand)', padding: '14px 18px' }}>
        <Info size={18} style={{ flex: 'none' }} />
        Dealers cannot sign up in the app. Only owners create a dealer login; the helpline team can reset passwords. The dealer app (their own scans, outstanding, withdrawals) is phase 2.
      </div>
      {creating && (
        <CreateDrawer
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setIssued({ ...r, kind: 'created' });
            reload();
          }}
        />
      )}
      {issued && <IssuedDrawer i={issued} onClose={() => setIssued(null)} />}
      {deact && (
        <ReasonDialog
          title={`Deactivate ${deact.firm}?`}
          sub="They can no longer log in. All their data is kept and you can reactivate later. Saved in the Audit log."
          action="Deactivate"
          danger
          picks={['Shop closed', 'Stopped dealing GoMax', 'Fraud']}
          onClose={() => setDeact(null)}
          onSubmit={async (reason) => {
            await api.post(`/dealers/${deact.id}/deactivate`, { reason });
            toast(`${deact.firm} deactivated`);
            setDeact(null);
            reload();
          }}
        />
      )}
    </>
  );
}

const Kpi = ({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: string }) => (
  <div className="card">
    <p className="t-13 c-sec">{label}</p>
    <p className="t-big" style={{ color: tone }}>
      {n(value)}
    </p>
    <p className="t-12 c-sec">{sub}</p>
  </div>
);

function CreateDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { dealer: Dealer; tempPassword: string }) => void }) {
  const [firm, setFirm] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [mobile, setMobile] = useState('');
  const [gst, setGst] = useState('');
  const [area, setArea] = useState('');
  const [areaTeam, setAreaTeam] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gstOk = !gst || GST_RE.test(gst);
  const ok = firm.trim().length >= 2 && ownerName.trim().length >= 2 && /^[6-9]\d{9}$/.test(mobile) && /^[A-Z]{2,5}$/.test(area) && gstOk;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.post('/dealers', { firm: firm.trim(), ownerName: ownerName.trim(), mobile, gst: gst || undefined, area, areaTeam: areaTeam.trim() || undefined }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title="Create dealer login"
      sub="The dealer gets the Login ID + password on WhatsApp"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok || busy} onClick={create}>
            <MessageCircle size={16} />
            {busy ? 'Creating…' : 'Create login'}
          </button>
        </>
      }
    >
      <p className="caps">Business</p>
      <div className="field">
        <label htmlFor="df">
          Dealer firm name <span className="c-bad">*</span>
        </label>
        <input id="df" className="input" value={firm} maxLength={80} onChange={(e) => setFirm(e.target.value)} placeholder="Bansal Tile Centre" />
      </div>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="do">
            Owner name <span className="c-bad">*</span>
          </label>
          <input id="do" className="input" value={ownerName} maxLength={60} onChange={(e) => setOwnerName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dm">
            Mobile (WhatsApp) <span className="c-bad">*</span>
          </label>
          <input id="dm" className="input" inputMode="numeric" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} placeholder="98880 41207" />
        </div>
        <div className="field">
          <label htmlFor="dg">GST no.</label>
          <input id="dg" className="input mono" maxLength={15} value={gst} onChange={(e) => setGst(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))} placeholder="03AAKFB7781Q1Z2" />
          {gst && <p className={gstOk ? 'hint c-ok' : 'err'}>{gstOk ? `Valid · ${GST_STATE[gst.slice(0, 2)] ?? `state ${gst.slice(0, 2)}`}` : 'GST number looks wrong (15 characters)'}</p>}
        </div>
        <div className="field">
          <label htmlFor="da">
            Area code <span className="c-bad">*</span>
          </label>
          <input id="da" className="input mono" maxLength={5} value={area} onChange={(e) => setArea(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} placeholder="LDH" />
          <p className="hint">
            2–5 letters (LDH, JAL, PTA, AMB…) <Client>CLIENT: area codes list</Client>
          </p>
        </div>
      </div>
      <div className="field">
        <label htmlFor="dt">Area team (optional)</label>
        <input id="dt" className="input" maxLength={60} value={areaTeam} onChange={(e) => setAreaTeam(e.target.value)} placeholder="Not set" />
      </div>
      <p className="caps">Login (made by the system)</p>
      <div className="grid grid-2" style={{ gap: 12, background: 'var(--surface-muted)', borderRadius: 12, padding: 14 }}>
        <div className="field">
          <span className="label">Login ID</span>
          <input className="input mono" disabled value={area ? `GMD-${area}-<next no.>` : 'GMD-<area>-<no.>'} />
        </div>
        <div className="field">
          <span className="label">Temporary password</span>
          <input className="input" disabled value="Made when you create" />
        </div>
        <p className="t-12 c-sec" style={{ gridColumn: '1 / -1' }}>
          Dealer must set a new password at first login. The temporary password expires in 7 days if not used.
        </p>
      </div>
      {error && <ErrorBox error={error} />}
    </Drawer>
  );
}

function IssuedDrawer({ i, onClose }: { i: Issued; onClose: () => void }) {
  const toast = useToast();
  const copy = (t: string) =>
    navigator.clipboard
      .writeText(t)
      .then(() => toast('Copied'))
      .catch(() => toast('Could not copy', true));
  return (
    <Drawer
      title={i.kind === 'created' ? 'Dealer login created' : 'Password reset'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => copy(shareText(i))}>
            <Copy size={16} />
            Copy all details
          </button>
          <a className="btn" style={{ background: '#128c7e', borderColor: '#128c7e', color: '#fff' }} href={waLink(i)} target="_blank" rel="noreferrer">
            <MessageCircle size={16} />
            Send on WhatsApp
          </a>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="row g12" style={{ background: 'var(--success-50)', borderRadius: 14, padding: '14px 16px' }}>
        <CircleCheck size={28} color="var(--success-text)" />
        <div>
          <p className="t-card w6">{i.kind === 'created' ? `${i.dealer.firm} can now log in` : `New temporary password for ${i.dealer.firm}`}</p>
          <p className="t-12 c-ok">Send it on WhatsApp to +91 {spacedMobile(i.dealer.mobile)} · shown only now</p>
        </div>
      </div>
      <div className="card col g10">
        {(
          [
            ['Login ID', i.dealer.loginId],
            ['Temporary password', i.tempPassword],
            ['App link', APP_LINK],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="between">
            <span className="t-13 c-sec" style={{ width: 150 }}>
              {k}
            </span>
            <span className="grow t-card w6 mono">{v}</span>
            <button className="link" onClick={() => copy(v)}>
              <Copy size={13} style={{ verticalAlign: -2 }} /> Copy
            </button>
          </div>
        ))}
      </div>
      <p className="caps">WhatsApp message</p>
      <div style={{ background: '#efeae2', borderRadius: 14, padding: 14 }}>
        <p className="t-13" style={{ background: '#fff', borderRadius: 10, padding: 12, whiteSpace: 'pre-line' }}>
          {shareText(i)}
        </p>
      </div>
      <p className="t-12 c-sec">
        The temporary password expires {i.dealer.tempPasswordExpiresAt ? `on ${date(i.dealer.tempPasswordExpiresAt)}` : 'in 7 days'} if not used. It is not shown again — reset the password to make a new one.
      </p>
    </Drawer>
  );
}
