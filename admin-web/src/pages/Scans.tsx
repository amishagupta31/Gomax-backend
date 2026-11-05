import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Ban, Check, CircleX, Copy, Download, FileText, Hash, Lock, MapPin, MessageCircle, Package, ScanLine, Search, Smartphone, TriangleAlert, WifiOff, Zap } from 'lucide-react';
import { api, ApiError } from '../api';
import { useStaff } from '../auth';
import { flagText, SCAN_RESULT, SCAN_SOURCE, type Flag } from '../labels';
import { useCounts, useHead } from '../Shell';
import { ago, date, dateTime, Drawer, Empty, ErrorBox, errMsg, initials, Loading, n, ReasonDialog, spacedMobile, time, useLoad, useToast } from '../ui';
import { printedCode } from './Coupons';

// D3 Scans log & coupon lookup: D3a lookup (21:7840) · D3b all scans (21:8059) ·
// D3c flags (21:8454) · D3d dispute drawer (21:8688). Owners decide flags; others view.
type Tab = 'lookup' | 'all' | 'flags';
type Attempt = { result: string; name: string; mobile: string; at: string; source: string; lat: number | null; lng: number | null; device: string | null };
type Lookup = {
  code: string;
  adminRef: string;
  value: number;
  batch: { id: number; ref: string; status: string; expiresAt: string; line: string };
  status: 'fresh' | 'scanned' | 'repeat_try_blocked' | 'blocked';
  scannedBy: { name: string; mobile: string; at: string; lat: number | null; lng: number | null; source: string } | null;
  attempts: Attempt[];
};
type ScanRow = { id: number; code: string | null; codeRaw: string; result: string; source: string; points: number; lat: number | null; lng: number | null; accuracy: number | null; deviceModel: string | null; appVersion: string | null; scannedAt: string; name: string; mobile: string; userId: string };

const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
const gps = (lat?: number | null, lng?: number | null) => (lat != null && lng != null ? `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E` : 'No GPS');
const mask = (m: string) => (/^\d{10}$/.test(m) ? `${m.slice(0, 2)}xxx x${m.slice(-4)}` : m);

export default function Scans() {
  const [params, setParams] = useSearchParams();
  const { counts } = useCounts();
  const tab = (params.get('tab') as Tab) || (params.get('q') ? 'all' : 'lookup');
  const set = (t: Tab) => setParams(t === 'lookup' ? {} : { tab: t });
  useHead('Scans log', tab === 'lookup' ? 'Search a coupon to see its full story' : tab === 'flags' ? `${counts?.flags ?? 0} open flags · owners decide` : 'Every scan try — also failed ones');
  return (
    <>
      <div className="segmented" role="tablist">
        <button className={tab === 'lookup' ? 'on' : ''} onClick={() => set('lookup')}>
          Coupon lookup
        </button>
        <button className={tab === 'all' ? 'on' : ''} onClick={() => set('all')}>
          All scans
        </button>
        <button className={tab === 'flags' ? 'on' : ''} onClick={() => set('flags')}>
          Flags <span className="count">{counts?.flags ?? 0}</span>
        </button>
      </div>
      {tab === 'lookup' && <CouponLookup initial={params.get('code') ?? ''} />}
      {tab === 'all' && <AllScans initialQ={params.get('q') ?? ''} />}
      {tab === 'flags' && <Flags />}
    </>
  );
}

// ── D3a ──
export function CouponLookup({ initial }: { initial: string }) {
  const staff = useStaff();
  const toast = useToast();
  const [q, setQ] = useState(initial);
  const [data, setData] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dispute, setDispute] = useState(false);
  const [blocking, setBlocking] = useState(false);

  const look = async (code = q) => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      setData(await api.get(`/coupons/${encodeURIComponent(c)}`));
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError && e.status === 404 ? `“${c}” is not a GoMax coupon code. Check the letters (no 0/O, 1/I).` : errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initial) look(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const proofText = (l: Lookup) =>
    l.scannedBy
      ? `This coupon ${printedCode(l.code)} was already scanned on ${dateTime(l.scannedBy.at)} by another account (${mask(l.scannedBy.mobile)}). Each GoMax code works only once. — GoMax helpline 92158 44410`
      : `This coupon ${printedCode(l.code)} has not been scanned yet. — GoMax helpline 92158 44410`;

  return (
    <>
      <form
        className="row g12"
        style={{ background: '#fff', border: '1.5px solid var(--primary-700)', borderRadius: 14, padding: '10px 10px 10px 18px' }}
        onSubmit={(e) => {
          e.preventDefault();
          look();
        }}
      >
        <Search size={20} color="var(--text-secondary)" />
        <input
          className="grow mono"
          style={{ border: 0, outline: 0, fontSize: 18, fontWeight: 700, background: 'none' }}
          placeholder="GMX-XXXX-XXXX"
          value={q}
          onChange={(e) => setQ(e.target.value.toUpperCase())}
          aria-label="Coupon code"
          autoFocus
        />
        <span className="t-12 c-muted d-only">coupon code (8 letters/digits)</span>
        <button className="btn primary" disabled={busy || !q.trim()}>
          {busy ? 'Looking…' : 'Look up'}
        </button>
      </form>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Empty icon={<ScanLine size={28} />} title="Look up any coupon" sub="Type or paste the code the applicator sent. You see who scanned it, when, where (GPS) and every repeat try." />}
      {data && (
        <div className="grid grid-main">
          <div className="card col g16" style={{ padding: 24 }}>
            <div className="between wrap" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="row g10 wrap">
                  <h2 className="mono" style={{ fontSize: 22, lineHeight: '28px' }}>
                    {printedCode(data.code)}
                  </h2>
                  <StatusPill s={data.status} />
                </div>
                <p className="t-13 c-sec mt4">
                  Ref {data.adminRef} · Batch {data.batch.ref} · {data.value} pt · valid till {date(data.batch.expiresAt)}
                </p>
              </div>
              <div className="row g10">
                <button className="btn" onClick={() => setDispute(true)}>
                  <FileText size={16} />
                  Dispute proof
                </button>
                {staff.role === 'owner' && data.status !== 'blocked' && (
                  <button className="btn danger" style={{ background: 'var(--danger-50)', borderColor: 'var(--danger-50)' }} onClick={() => setBlocking(true)}>
                    <CircleX size={16} />
                    Block code
                  </button>
                )}
              </div>
            </div>
            {data.scannedBy ? (
              <div className="grid grid-2" style={{ gap: 12 }}>
                <Tile label="Scanned by">
                  <div className="person">
                    <span className="avatar">{initials(data.scannedBy.name)}</span>
                    <div>
                      <p className="t-13 w6">{data.scannedBy.name}</p>
                      <p className="t-12 c-sec">{spacedMobile(data.scannedBy.mobile)}</p>
                    </div>
                  </div>
                </Tile>
                <Tile label="Date & time">{dateTime(data.scannedBy.at)}</Tile>
                <Tile label="Points given">+{data.value} pt → wallet</Tile>
                <Tile label="Location (GPS)">
                  {data.scannedBy.lat != null && data.scannedBy.lng != null ? (
                    <a className="link" href={mapsUrl(data.scannedBy.lat, data.scannedBy.lng)} target="_blank" rel="noreferrer">
                      {gps(data.scannedBy.lat, data.scannedBy.lng)}
                    </a>
                  ) : (
                    'No GPS'
                  )}
                </Tile>
                <Tile label="Phone">{data.attempts.find((a) => a.result === 'added')?.device ?? '—'}</Tile>
                <Tile label="How scanned">{SCAN_SOURCE[data.scannedBy.source] ?? data.scannedBy.source}</Tile>
              </div>
            ) : (
              <div className="note">Not scanned yet. {data.batch.status !== 'in_market' && 'Its batch is not “In market”, so the app says “not active yet”.'}</div>
            )}
            <p className="caps">Coupon story</p>
            <div className="col g12">
              <Story icon={<Hash size={16} />} title={`Made in batch ${data.batch.ref}`} sub={`Status now: ${data.batch.status.replace('_', ' ')}`} />
              {data.attempts
                .slice()
                .reverse()
                .map((a, i) => (
                  <Story
                    key={i}
                    bad={a.result !== 'added'}
                    icon={a.result === 'added' ? <ScanLine size={16} /> : <CircleX size={16} />}
                    title={a.result === 'added' ? `Scanned by ${a.name} · +${data.value} pt` : `Tried by ${a.name} — rejected “${SCAN_RESULT[a.result]?.label ?? a.result}”`}
                    sub={`${dateTime(a.at)} · ${SCAN_SOURCE[a.source] ?? a.source}${a.device ? ` · ${a.device}` : ''}`}
                  />
                ))}
            </div>
          </div>
          <div className="col g16">
            <div className="card col g12">
              <p className="t-card w7">Where it was scanned</p>
              {data.attempts.filter((a) => a.lat != null).length === 0 && <p className="t-13 c-sec">No GPS on any try.</p>}
              {data.attempts
                .filter((a) => a.lat != null && a.lng != null)
                .map((a, i) => (
                  <a key={i} className="row g10" href={mapsUrl(a.lat!, a.lng!)} target="_blank" rel="noreferrer">
                    <span className={`pill ${a.result === 'added' ? 'navy' : 'bad'}`}>
                      <MapPin size={12} />
                      {a.name.split(' ')[0]} · {time(a.at)}
                    </span>
                    <span className="t-12 c-sec">{gps(a.lat, a.lng)}</span>
                  </a>
                ))}
              <p className="t-12 c-muted">Pin = phone GPS at the time of scan. Red = rejected try. Opens Google Maps.</p>
            </div>
            <div className="card col g12">
              <div>
                <p className="t-card w7">Dispute proof</p>
                <p className="t-12 c-sec">Send to an applicator or dealer who says “my coupon did not work”</p>
              </div>
              <p className="t-13">“{proofText(data)}”</p>
              <div className="row g10 wrap">
                <a className="btn" style={{ background: 'var(--success-50)', borderColor: 'var(--success-50)', color: 'var(--success-text)' }} href={`https://wa.me/?text=${encodeURIComponent(proofText(data))}`} target="_blank" rel="noreferrer">
                  <MessageCircle size={16} />
                  Send on WhatsApp
                </a>
                <button
                  className="btn"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(proofText(data))
                      .then(() => toast('Proof copied'))
                      .catch(() => toast('Could not copy', true))
                  }
                >
                  <Copy size={16} />
                  Copy
                </button>
              </div>
              <p className="t-12 c-muted">Mobile number is masked in the proof.</p>
            </div>
          </div>
        </div>
      )}
      {dispute && data && <DisputeDrawer data={data} proof={proofText(data)} onClose={() => setDispute(false)} />}
      {blocking && data && (
        <ReasonDialog
          title={`Block ${printedCode(data.code)}?`}
          sub="This one code stops working in the app. Saved in the Audit log."
          action="Block code"
          danger
          picks={['Lost / stolen', 'Damaged coupon', 'Fraud']}
          onClose={() => setBlocking(false)}
          onSubmit={async (reason) => {
            await api.post(`/coupons/${data.code}/block`, { reason });
            toast('Code blocked');
            setBlocking(false);
            look(data.code);
          }}
        />
      )}
    </>
  );
}

function StatusPill({ s }: { s: Lookup['status'] }) {
  const m = { fresh: ['Fresh', 'info'], scanned: ['Scanned', 'ok'], repeat_try_blocked: ['Repeat try blocked', 'warn'], blocked: ['Blocked', 'bad'] }[s];
  return (
    <span className={`pill ${m[1]}`}>
      {s === 'scanned' && <Check size={13} />}
      {m[0]}
    </span>
  );
}
const Tile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: '12px 14px' }}>
    <p className="t-12 c-sec">{label}</p>
    <div className="t-13 w6 mt4">{children}</div>
  </div>
);
const Story = ({ icon, title, sub, bad }: { icon: React.ReactNode; title: string; sub: string; bad?: boolean }) => (
  <div className="row g12" style={{ alignItems: 'flex-start' }}>
    <span className={`kpi-icon ${bad ? 'tone-bad' : 'tone-muted'}`} style={{ borderRadius: 16 }}>
      {icon}
    </span>
    <div>
      <p className={`t-13 w6 ${bad ? 'c-bad' : ''}`}>{title}</p>
      <p className="t-12 c-sec">{sub}</p>
    </div>
  </div>
);

// D3d: "my coupon is not working" — reply with proof, goodwill points (owner), or fraud check.
function DisputeDrawer({ data, proof, onClose }: { data: Lookup; proof: string; onClose: () => void }) {
  const staff = useStaff();
  const toast = useToast();
  const [choice, setChoice] = useState<'proof' | 'goodwill'>('proof');
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const repeat = data.attempts.find((a) => a.result === 'already_used');
  const go = async () => {
    if (choice === 'proof') {
      window.open(`https://wa.me/${mobile ? `91${mobile}` : ''}?text=${encodeURIComponent(proof)}`, '_blank', 'noreferrer');
      onClose();
      return;
    }
    setBusy(true);
    try {
      const found = await api.get<{ rows: { id: string; name: string }[] }>(`/applicators?q=${mobile}`);
      const u = found.rows[0];
      if (!u) throw new Error('No applicator with this mobile');
      await api.post(`/applicators/${u.id}/adjust`, { wallet: 'points', amount: data.value, reason: `Goodwill for coupon ${printedCode(data.code)}` });
      toast(`+${data.value} pt given to ${u.name} · logged`);
      onClose();
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title="“My coupon says Already used”"
      sub={`Coupon ${printedCode(data.code)} · Ref ${data.adminRef}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn ok" disabled={busy || (choice === 'goodwill' && !/^\d{10}$/.test(mobile))} onClick={go}>
            <MessageCircle size={16} />
            {choice === 'proof' ? 'Send reply on WhatsApp' : 'Give points'}
          </button>
        </>
      }
    >
      <p className="caps">What the system says</p>
      <div className="alert-box" style={{ flexDirection: 'column', gap: 6 }}>
        {data.scannedBy ? (
          <>
            <p className="t-body w6">Already scanned on {dateTime(data.scannedBy.at)}</p>
            <p className="t-13" style={{ color: 'var(--text-primary)' }}>
              By {data.scannedBy.name} ({spacedMobile(data.scannedBy.mobile)}) · {gps(data.scannedBy.lat, data.scannedBy.lng)} · {SCAN_SOURCE[data.scannedBy.source]}
            </p>
          </>
        ) : (
          <p className="t-body w6">Not scanned yet — ask the applicator to try again in the app.</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="dm">Applicator’s mobile (who raised it)</label>
        <input id="dm" className="input" inputMode="numeric" maxLength={10} placeholder={repeat ? `e.g. ${repeat.name}` : '10 digits'} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, ''))} />
      </div>
      <p className="caps">Decide</p>
      {(
        [
          ['proof', 'Reply with proof (no points)', 'Send “this coupon was scanned here” proof on WhatsApp'],
          ['goodwill', 'Give points as goodwill', `Owner only · +${data.value} pt · logged`],
        ] as const
      ).map(([v, t, s]) => (
        <button
          key={v}
          className="card row g12"
          disabled={v === 'goodwill' && staff.role !== 'owner'}
          style={{ textAlign: 'left', borderColor: choice === v ? 'var(--primary-700)' : undefined, background: choice === v ? 'var(--primary-50)' : undefined, opacity: v === 'goodwill' && staff.role !== 'owner' ? 0.5 : 1 }}
          onClick={() => setChoice(v)}
        >
          <span style={{ width: 18, height: 18, borderRadius: 9, border: choice === v ? '5px solid var(--primary-700)' : '1.5px solid var(--border-strong)', flex: 'none' }} />
          <span>
            <span className="t-13 w6" style={{ display: 'block' }}>
              {t}
            </span>
            <span className="t-12 c-sec">{s}</span>
          </span>
        </button>
      ))}
      <p className="t-12 c-muted">Disputes are not saved as tickets yet (not connected) — the goodwill points are logged in the Audit log.</p>
    </Drawer>
  );
}

// ── D3b ──
function AllScans({ initialQ }: { initialQ: string }) {
  const [q, setQ] = useState(initialQ);
  const [search, setSearch] = useState(initialQ);
  const [result, setResult] = useState('');
  const [source, setSource] = useState('');
  const [range, setRange] = useState<'today' | 'week' | 'all'>('today');
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const from = range === 'all' ? null : new Date(Date.now() - (range === 'today' ? sinceIstMidnight() : 7 * 86_400_000)).toISOString();
  const qs = (c?: string | null) => {
    const p = new URLSearchParams({ limit: '50' });
    if (from) p.set('from', from);
    if (result) p.set('result', result);
    if (source) p.set('source', source);
    if (search) p.set('q', search);
    if (c) p.set('cursor', c);
    return p.toString();
  };
  const { data, error, loading, reload } = useLoad<{ rows: ScanRow[]; nextCursor: string | null }>(() => api.get(`/scans?${qs()}`), [result, source, search, range]);
  useEffect(() => {
    if (data) {
      setRows(data.rows);
      setCursor(data.nextCursor);
    }
  }, [data]);
  const more = async () => {
    const r = await api.get<{ rows: ScanRow[]; nextCursor: string | null }>(`/scans?${qs(cursor)}`);
    setRows((x) => [...x, ...r.rows]);
    setCursor(r.nextCursor);
  };
  const exportCsv = () => {
    const head = 'time,code,applicator,mobile,points,lat,lng,phone,result,source';
    const lines = rows.map((r) => [r.scannedAt, r.code ?? r.codeRaw, r.name, r.mobile, r.points, r.lat ?? '', r.lng ?? '', r.deviceModel ?? '', r.result, r.source].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `scans-${range}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="between wrap">
        <div className="row wrap g10">
          <select className="select" value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="Period">
            <option value="today">Today</option>
            <option value="week">Last 7 days</option>
            <option value="all">All time</option>
          </select>
          <select className="select" value={result} onChange={(e) => setResult(e.target.value)} aria-label="Result">
            <option value="">Result: All</option>
            {Object.entries(SCAN_RESULT).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <select className="select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="How scanned">
            <option value="">Camera / typed / offline</option>
            {Object.entries(SCAN_SOURCE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <input className="input" style={{ width: 240 }} placeholder="Code, mobile or name" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
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
                  <th>Time</th>
                  <th>Coupon code</th>
                  <th>Applicator</th>
                  <th>Points</th>
                  <th>Place (GPS)</th>
                  <th>Phone</th>
                  <th>Result</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="c-sec">
                      No scans match.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const res = SCAN_RESULT[r.result] ?? { label: r.result, tone: '' };
                  return (
                    <tr key={r.id} style={r.result === 'already_used' ? { background: 'var(--danger-50)' } : undefined}>
                      <td data-l="Time" className="nowrap">
                        {range === 'today' ? time(r.scannedAt) : dateTime(r.scannedAt)}
                      </td>
                      <td data-l="Coupon code" className="w6 mono nowrap">
                        {r.code ? printedCode(r.code) : r.codeRaw}
                      </td>
                      <td data-l="Applicator">
                        <div className="person">
                          <span className="avatar">{initials(r.name)}</span>
                          <div>
                            <p className="w6">{r.name}</p>
                            <p className="t-12 c-sec">{spacedMobile(r.mobile)}</p>
                          </div>
                        </div>
                      </td>
                      <td data-l="Points">{r.points ? `${r.points} pt` : '—'}</td>
                      <td data-l="Place (GPS)">
                        {r.lat != null && r.lng != null ? (
                          <a className="row g4 c-sec" href={mapsUrl(r.lat, r.lng)} target="_blank" rel="noreferrer">
                            <MapPin size={14} />
                            {r.lat.toFixed(2)}, {r.lng.toFixed(2)}
                          </a>
                        ) : (
                          <span className="c-muted">No GPS</span>
                        )}
                      </td>
                      <td data-l="Phone">{r.deviceModel ?? '—'}</td>
                      <td data-l="Result">
                        <span className={`pill ${res.tone}`}>{res.label}</span>
                      </td>
                      <td data-l="How">
                        <span className="row g4 t-12 c-sec">
                          {r.source === 'offline' ? <WifiOff size={13} /> : r.source === 'typed' ? <Hash size={13} /> : <ScanLine size={13} />}
                          {SCAN_SOURCE[r.source]}
                        </span>
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
      <p className="row g6 t-12" style={{ color: 'var(--gift-text)' }}>
        <Smartphone size={14} />
        Later (phase 2): dealers get a read-only login to this page, only for coupons scanned in their area. They cannot block codes or see full mobile numbers.
      </p>
    </>
  );
}

function sinceIstMidnight() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return (ist.getHours() * 3600 + ist.getMinutes() * 60 + ist.getSeconds()) * 1000;
}

// ── D3c ──
function Flags() {
  const staff = useStaff();
  const toast = useToast();
  const { refresh } = useCounts();
  const owner = staff.role === 'owner';
  const [status, setStatus] = useState<'open' | 'cleared' | 'confirmed'>('open');
  const { data, error, loading, reload } = useLoad<{ flags: Flag[] }>(() => api.get(`/fraud-flags?status=${status}&limit=50`), [status]);
  const settings = useLoad<{ settings: { fraud: { burstScans: number; burstMinutes: number; jumpKm: number; jumpMinutes: number } } }>(() => api.get('/settings'));
  const fr = settings.data?.settings.fraud;
  const [ask, setAsk] = useState<{ flag: Flag; kind: 'block' | 'ok' | 'confirm' } | null>(null);
  const done = () => {
    setAsk(null);
    reload();
    refresh();
  };

  return (
    <>
      <div className="card">
        <p className="t-card w7">Auto-flag rules (change in Settings)</p>
        <div className="grid mt16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          {[
            [Copy, 'Same code tried again', 'by any other phone'],
            [Zap, 'Too fast', fr ? `more than ${fr.burstScans} scans in ${fr.burstMinutes} min` : '…'],
            [MapPin, 'GPS jump', fr ? `more than ${fr.jumpKm} km in ${fr.jumpMinutes} min` : '…'],
            [Smartphone, 'One phone, many accounts', '2 or more accounts'],
            [TriangleAlert, 'Many wrong codes', '10 wrong codes in 10 min'],
          ].map(([I, t, s]) => {
            const Icon = I as typeof Copy;
            return (
              <div key={t as string} className="row g10" style={{ alignItems: 'flex-start', background: 'var(--surface-muted)', borderRadius: 12, padding: '12px 14px' }}>
                <Icon size={16} color="var(--danger-text)" style={{ flex: 'none', marginTop: 1 }} />
                <div>
                  <p className="t-13 w5">{t as string}</p>
                  <p className="t-12 c-sec">{s as string}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="segmented">
        {(['open', 'cleared', 'confirmed'] as const).map((s) => (
          <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
            {s === 'open' ? 'Open' : s === 'cleared' ? 'Marked OK' : 'Confirmed fraud'}
          </button>
        ))}
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      {loading && !data && (
        <div className="card">
          <Loading />
        </div>
      )}
      {data?.flags.length === 0 && (
        <div className="card">
          <Empty icon={<Check size={28} />} title={status === 'open' ? 'No open flags' : 'Nothing here'} sub="New flags appear here as the app sees them." />
        </div>
      )}
      {data?.flags.map((f) => {
        const t = flagText(f);
        const high = f.rule === 'repeat_code' || f.rule === 'scan_burst' || f.rule === 'shared_device';
        return (
          <div key={f.id} className="card row g16 wrap" style={{ alignItems: 'flex-start', padding: 20 }}>
            <span className="kpi-icon tone-bad" style={{ width: 44, height: 44, borderRadius: 12 }}>
              <TriangleAlert size={20} />
            </span>
            <div className="grow col g10" style={{ minWidth: 260 }}>
              <div className="row g10 wrap">
                <p className="t-card w7">{t.title}</p>
                <span className={`pill ${high ? 'bad' : 'warn'}`}>{high ? 'High' : 'Medium'}</span>
                <span className="t-12 c-muted">{ago(f.createdAt)}</span>
              </div>
              <div className="person">
                <span className="avatar">{initials(f.name)}</span>
                <div>
                  <p className="t-13 w6">{f.name}</p>
                  <p className="t-12 c-sec">{spacedMobile(f.mobile)}</p>
                </div>
              </div>
              <p className="t-13 c-sec">{t.sub}. Cash withdrawals are on hold until an owner decides.</p>
              <div className="row g6 wrap">
                {Object.entries(f.details ?? {})
                  .filter(([, v]) => typeof v !== 'object')
                  .map(([k, v]) => (
                    <span key={k} className="pill">
                      {k}: {String(v)}
                    </span>
                  ))}
              </div>
            </div>
            {status === 'open' && (
              <div className="col g10" style={{ width: 170 }}>
                {owner ? (
                  <>
                    <button className="btn" style={{ background: 'var(--warning-50)', borderColor: 'var(--warning-50)', color: 'var(--warning-text)' }} onClick={() => setAsk({ flag: f, kind: 'confirm' })}>
                      <Lock size={16} />
                      Hold points
                    </button>
                    <button className="btn danger" style={{ background: 'var(--danger-50)', borderColor: 'var(--danger-50)' }} onClick={() => setAsk({ flag: f, kind: 'block' })}>
                      <Ban size={16} />
                      Block applicator
                    </button>
                    <button className="btn" onClick={() => setAsk({ flag: f, kind: 'ok' })}>
                      <Check size={16} />
                      Mark OK
                    </button>
                  </>
                ) : (
                  <span className="pill">Owners decide</span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {ask && (
        <ReasonDialog
          title={{ block: `Block ${ask.flag.name}?`, ok: 'Mark OK', confirm: 'Hold points' }[ask.kind]}
          sub={
            {
              block: 'They are logged out and cannot use the app. You can unblock later.',
              ok: 'Clears this flag. When no flags are left, their cash hold is lifted.',
              confirm: 'Confirms the flag: their cash stays on hold until an owner releases it on the applicator page. Saved in the Audit log.',
            }[ask.kind]
          }
          action={{ block: 'Block applicator', ok: 'Mark OK', confirm: 'Hold points' }[ask.kind]}
          danger={ask.kind === 'block' || ask.kind === 'confirm'}
          picks={ask.kind === 'ok' ? ['Brothers / same family', 'Dealer stock, checked', 'GPS error'] : ['Same code on 2 phones', 'Fake GPS app']}
          onClose={() => setAsk(null)}
          onSubmit={async (reason) => {
            const f = ask.flag;
            if (ask.kind === 'block') {
              await api.post(`/applicators/${f.userId}/block`, { blocked: true, reason });
              await api.post(`/fraud-flags/${f.id}/decide`, { decision: 'confirmed', note: reason });
            } else {
              const r = await api.post<{ cashHold: boolean }>(`/fraud-flags/${f.id}/decide`, { decision: ask.kind === 'ok' ? 'cleared' : 'confirmed', note: reason });
              if (ask.kind === 'ok') toast(r.cashHold ? 'Flag cleared · other flags still hold their cash' : 'Flag cleared · cash hold lifted');
            }
            if (ask.kind !== 'ok') toast('Done · saved in the Audit log');
            done();
          }}
        />
      )}
      {!owner && <p className="t-12 c-sec">Your login can view flags. Owners decide.</p>}
      <p className="t-12 c-muted">
        <Package size={12} style={{ verticalAlign: -2 }} /> {n(data?.flags.length ?? 0)} shown
      </p>
    </>
  );
}
