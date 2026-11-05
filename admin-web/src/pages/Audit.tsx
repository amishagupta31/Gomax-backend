import { useEffect, useMemo, useState } from 'react';
import { Ban, Banknote, Download, Gift, LogIn, QrCode, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react';
import { api } from '../api';
import { useHead } from '../Shell';
import { dateTime, ErrorBox, initials, Loading, useLoad } from '../ui';

// D9d Audit log (21:15852): append-only, 7 years. Every change, approve, download and login.
type Row = { id: number; actorType: 'staff' | 'user' | 'system'; actorId: string | null; action: string; entity: string; entityId: string | null; before: unknown; after: unknown; ip: string | null; createdAt: string };
type StaffRow = { id: string; name: string; role: string };

const TYPE: Record<string, { label: string; tone: string; icon: typeof Banknote; page: string }> = {
  withdrawal: { label: 'Money', tone: 'ok', icon: Banknote, page: 'Withdrawals' },
  user: { label: 'People', tone: 'info', icon: UserRound, page: 'Applicators' },
  coupon_batch: { label: 'Coupon', tone: 'pri', icon: QrCode, page: 'Coupons' },
  coupon: { label: 'Block', tone: 'bad', icon: Ban, page: 'Scans log' },
  fraud_flag: { label: 'Flag', tone: 'bad', icon: Ban, page: 'Scans log' },
  gift: { label: 'Gift', tone: 'info', icon: Gift, page: 'Gifts & courier' },
  gift_order: { label: 'Gift', tone: 'info', icon: Gift, page: 'Gifts & courier' },
  setting: { label: 'Rule', tone: 'warn', icon: SlidersHorizontal, page: 'Settings' },
  challenge: { label: 'Rule', tone: 'warn', icon: SlidersHorizontal, page: 'Challenges' },
  streak_photo: { label: 'Photo', tone: '', icon: ShieldCheck, page: 'Challenges' },
  product: { label: 'Product', tone: '', icon: QrCode, page: 'Products & TDS' },
  staff: { label: 'Login', tone: '', icon: LogIn, page: '—' },
};
const words = (a: string) => a.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function what(r: Row) {
  const a = (r.after ?? {}) as Record<string, any>;
  const ref = r.entity === 'withdrawal' ? `W-${r.entityId}` : r.entity === 'gift_order' ? `G-${r.entityId}` : r.entityId;
  switch (r.action) {
    case 'login':
      return 'Logged in';
    case 'login_failed':
      return 'Wrong password or PIN';
    case 'withdrawal_paid':
      return `Paid ${ref}${a.utr ? ` · UTR ${a.utr}` : ''}${a.via ? ` · ${a.via}` : ''}`;
    case 'withdrawal_reject':
    case 'withdrawal_fail':
    case 'withdrawal_hold':
    case 'withdrawal_send_back':
      return `${words(r.action.replace('withdrawal_', ''))} ${ref}${a.reason ? ` · ${a.reason}` : ''}`;
    case 'create_batch':
      return `Created batch ${a.ref ?? ''} · ${a.valuePoints ?? '?'} pt × ${a.quantity ?? '?'}`;
    case 'export_batch':
      return `Downloaded print file for batch ${ref}`;
    case 'setting_update':
      return `Changed setting “${r.entityId}”`;
    case 'order_ship':
      return `${ref} shipped · ${a.courierName ?? ''} ${a.awb ?? ''}`;
    case 'adjust_balance':
      return `${a.amount > 0 ? '+' : ''}${a.amount} ${a.wallet} · ${a.reason ?? ''}`;
    case 'pan_view':
      return 'Viewed full PAN';
    default:
      return `${words(r.action)}${ref ? ` · ${ref}` : ''}${a.reason ? ` · ${a.reason}` : ''}`;
  }
}

export default function Audit() {
  const [range, setRange] = useState<'1' | '7' | '30' | 'all'>('7');
  const [entity, setEntity] = useState('');
  const [who, setWho] = useState('');
  const [moneyOnly, setMoneyOnly] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const staff = useLoad<{ staff: StaffRow[] }>(() => api.get('/staff'));
  const names = useMemo(() => new Map((staff.data?.staff ?? []).map((s) => [s.id, s])), [staff.data]);
  const from = range === 'all' ? '' : new Date(Date.now() - Number(range) * 86_400_000).toISOString();
  const qs = (c?: string | null) => {
    const p = new URLSearchParams({ limit: '100' });
    if (from) p.set('from', from);
    const e = moneyOnly ? 'withdrawal' : entity;
    if (e) p.set('entity', e);
    if (c) p.set('cursor', c);
    return p.toString();
  };
  const { data, error, loading, reload } = useLoad<{ rows: Row[]; nextCursor: string | null }>(() => api.get(`/audit?${qs()}`), [range, entity, moneyOnly]);
  useEffect(() => {
    if (data) {
      setRows(data.rows);
      setCursor(data.nextCursor);
    }
  }, [data]);
  useHead('Audit log', 'Every change, approve, download and login · cannot be edited or deleted');
  const shown = who ? rows.filter((r) => r.actorId === who) : rows;
  const more = async () => {
    const r = await api.get<{ rows: Row[]; nextCursor: string | null }>(`/audit?${qs(cursor)}`);
    setRows((x) => [...x, ...r.rows]);
    setCursor(r.nextCursor);
  };
  const actor = (r: Row) => (r.actorType === 'staff' ? (names.get(r.actorId ?? '') ?? { name: 'Staff', role: '' }) : r.actorType === 'user' ? { name: 'Applicator (app)', role: '' } : { name: 'System', role: 'automatic' });
  const exportCsv = () => {
    const head = 'when,who,role,action,entity,entity_id,what,ip';
    const lines = shown.map((r) => [r.createdAt, actor(r).name, actor(r).role, r.action, r.entity, r.entityId ?? '', what(r), r.ip ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'audit-log.csv' }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="row wrap g10">
        <select className="select" value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="Period">
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="all">All time</option>
        </select>
        <select className="select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who">
          <option value="">All people</option>
          {(staff.data?.staff ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="select" value={entity} disabled={moneyOnly} onChange={(e) => setEntity(e.target.value)} aria-label="Page">
          <option value="">All pages</option>
          {Object.entries(TYPE).map(([k, v]) => (
            <option key={k} value={k}>
              {v.page === '—' ? 'Logins' : `${v.page} (${words(k)})`}
            </option>
          ))}
        </select>
        <button className={`btn sm ${moneyOnly ? 'navy' : ''}`} style={{ height: 40 }} onClick={() => setMoneyOnly(!moneyOnly)}>
          ₹ Money only
        </button>
        <button className="btn" onClick={exportCsv} disabled={!shown.length}>
          <Download size={16} />
          Export CSV
        </button>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      <div className="card flush">
        {loading && !rows.length ? (
          <div style={{ padding: 20 }}>
            <Loading rows={6} />
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Type</th>
                  <th>What changed</th>
                  <th>Page</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="c-sec">
                      Nothing in this period.
                    </td>
                  </tr>
                )}
                {shown.map((r) => {
                  const t = TYPE[r.entity] ?? { label: words(r.entity), tone: '', icon: SlidersHorizontal, page: '—' };
                  const a = actor(r);
                  return (
                    <tr key={r.id}>
                      <td data-l="When" className="c-sec nowrap">
                        {dateTime(r.createdAt)}
                      </td>
                      <td data-l="Who">
                        <div className="person">
                          <span className="avatar">{initials(a.name)}</span>
                          <div>
                            <p className="w6">{a.name}</p>
                            <p className="t-12 c-sec">{a.role}</p>
                          </div>
                        </div>
                      </td>
                      <td data-l="Type">
                        <span className={`pill ${r.action.startsWith('login') ? '' : t.tone}`}>
                          {r.action.startsWith('login') ? <LogIn size={13} /> : <t.icon size={13} />}
                          {r.action.startsWith('login') ? 'Login' : t.label}
                        </span>
                      </td>
                      <td data-l="What changed" className={r.action === 'login_failed' ? 'c-bad' : ''}>
                        {what(r)}
                      </td>
                      <td data-l="Page">{t.page}</td>
                      <td data-l="IP" className="t-12 c-sec">
                        {r.ip ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {cursor && (
        <button className="btn" style={{ alignSelf: 'center' }} onClick={more}>
          Show more
        </button>
      )}
      <p className="row g6 t-12 c-ok">
        <ShieldCheck size={14} />
        Kept for 7 years. Only owners can open the audit log.
      </p>
    </>
  );
}
