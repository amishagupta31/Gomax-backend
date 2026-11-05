import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Ban, Check, CircleCheck, CircleX, Download, FileText, Hash, List, Lock, MoreHorizontal, Package, Plus, QrCode, ScanLine, Send, ShieldCheck } from 'lucide-react';
import { api, csvText, download } from '../api';
import { useStaff } from '../auth';
import { BATCH_STATUS } from '../labels';
import { canEdit } from '../roles';
import { useHead } from '../Shell';
import { Client, date, dateTime, ErrorBox, errMsg, Loading, n, NotConnected, ReasonDialog, useLoad, useToast } from '../ui';

// D2a Coupon batches (21:6720) · D2b–d Create batch steps 1–3 (21:7108, 21:7313, 21:7594).
// Generated → Printed → In market → Partly / Fully scanned. Owners make batches;
// factory downloads the print file and marks Printed / In market.
export type Batch = {
  id: number;
  ref: string;
  valuePoints: number;
  line: string;
  quantity: number;
  status: 'generated' | 'printed' | 'in_market' | 'blocked';
  expiresAt: string;
  note: string | null;
  area: string | null;
  blockedReason: string | null;
  createdAt: string;
  printedAt: string | null;
  inMarketAt: string | null;
  scanned: number;
  progress: 'none' | 'partly_scanned' | 'fully_scanned';
};
type Filter = 'all' | 'generated' | 'printed' | 'in_market' | 'partly_scanned' | 'fully_scanned';

/** Codes are stored as 8 characters and printed as GMX-XXXX-XXXX. */
export const printedCode = (c: string) => (c.length === 8 ? `GMX-${c.slice(0, 4)}-${c.slice(4)}` : c);
const LINES: [string, string][] = [
  ['standard', 'Any product'],
  ['ultra', 'GoMax Ultra'],
];
const lineLabel = (l: string) => LINES.find(([v]) => v === l)?.[1] ?? l;

export default function Coupons() {
  const [creating, setCreating] = useState(false);
  return creating ? <CreateBatch onDone={() => setCreating(false)} /> : <BatchList onCreate={() => setCreating(true)} />;
}

function statusOf(b: Batch) {
  if (b.status === 'blocked') return { key: 'blocked', ...BATCH_STATUS.blocked, icon: Ban };
  if (b.status === 'in_market' && b.progress === 'fully_scanned') return { key: 'fully_scanned', label: 'Fully scanned', tone: 'ok', icon: Check };
  if (b.status === 'in_market' && b.progress === 'partly_scanned') return { key: 'partly_scanned', label: 'Partly scanned', tone: 'pri', icon: ScanLine };
  if (b.status === 'in_market') return { key: 'in_market', label: 'In market', tone: 'info', icon: Package };
  if (b.status === 'printed') return { key: 'printed', label: 'Printed', tone: 'warn', icon: FileText };
  return { key: 'generated', label: 'Generated', tone: '', icon: Hash };
}

function BatchList({ onCreate }: { onCreate: () => void }) {
  const staff = useStaff();
  const toast = useToast();
  const owner = staff.role === 'owner';
  const factory = canEdit(staff.role, '/coupons');
  const [filter, setFilter] = useState<Filter>('all');
  const [menu, setMenu] = useState<number | null>(null);
  const [blocking, setBlocking] = useState<Batch | null>(null);
  const { data, error, loading, reload } = useLoad<{ batches: Batch[] }>(() => api.get('/coupon-batches'));
  const batches = data?.batches ?? [];

  const made = batches.reduce((s, b) => s + b.quantity, 0);
  const scanned = batches.reduce((s, b) => s + b.scanned, 0);
  const inMarket = batches.filter((b) => b.status === 'in_market');
  const notScanned = inMarket.reduce((s, b) => s + b.quantity - b.scanned, 0);
  const owedLater = inMarket.reduce((s, b) => s + (b.quantity - b.scanned) * b.valuePoints, 0);
  const blocked = batches.filter((b) => b.status === 'blocked');
  const count = (f: Filter) => (f === 'all' ? batches.length : batches.filter((b) => statusOf(b).key === f).length);
  const shown = filter === 'all' ? batches : batches.filter((b) => statusOf(b).key === filter);
  useHead('Coupons', data ? `${batches.length} batches · ${n(made)} coupons made · ${n(scanned)} scanned` : 'Make coupon batches, send for printing, track each batch');

  const step = async (b: Batch, status: 'printed' | 'in_market') => {
    setMenu(null);
    try {
      await api.patch(`/coupon-batches/${b.id}`, { status });
      toast(`${b.ref} ${status === 'printed' ? 'marked printed' : 'is now in market — the app accepts its codes'}`);
      reload();
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
  const pdf = (b: Batch) => {
    setMenu(null);
    download(`/coupon-batches/${b.id}/print.pdf`, `${b.ref}.pdf`)
      .then(() => toast(`${b.ref}.pdf downloaded · 48 per A4 · saved in the Audit log`))
      .catch((e) => toast(errMsg(e), true));
  };
  const csv = (b: Batch) => {
    setMenu(null);
    download(`/coupon-batches/${b.id}/export.csv`, `${b.ref}.csv`)
      .then(() => toast(`${b.ref}.csv downloaded · saved in the Audit log`))
      .catch((e) => toast(errMsg(e), true));
  };

  return (
    <>
      <div className="between wrap">
        <div className="segmented" role="tablist" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {(
            [
              ['all', 'All'],
              ['generated', 'Generated'],
              ['printed', 'Printed'],
              ['in_market', 'In market'],
              ['partly_scanned', 'Partly scanned'],
              ['fully_scanned', 'Fully scanned'],
            ] as [Filter, string][]
          ).map(([f, l]) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {l} <span className="count" style={filter === f ? { background: 'rgba(255,255,255,0.18)', color: '#fff' } : {}}>{count(f)}</span>
            </button>
          ))}
        </div>
        {owner && (
          <button className="btn primary" onClick={onCreate}>
            <Plus size={16} />
            Create batch
          </button>
        )}
      </div>

      <div className="grid grid-4 m2">
        <Kpi icon={<QrCode size={18} />} tone="tone-pri" value={n(made)} label="Coupons made (all time)" sub={`${batches.length} batches`} subClass="c-pri" />
        <Kpi icon={<ScanLine size={18} />} tone="tone-ok" value={n(scanned)} label="Scanned" sub={made ? `${Math.round((scanned / made) * 100)}% of made` : ''} subClass="c-ok" />
        <Kpi icon={<Package size={18} />} tone="tone-gift" value={n(notScanned)} label="In market, not scanned" sub={`Max ${n(owedLater)} points owed later`} subClass="c-info" />
        <Kpi icon={<CircleX size={18} />} tone="tone-bad" value={n(blocked.reduce((s, b) => s + b.quantity - b.scanned, 0))} label="Blocked" sub="Not scannable" subClass="c-bad" />
      </div>

      {error && <ErrorBox error={error} retry={reload} />}
      <div className="card flush">
        {loading && !data ? (
          <div style={{ padding: 20 }}>
            <Loading rows={5} />
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Value</th>
                  <th className="num">Qty</th>
                  <th>Product line</th>
                  <th>Made on</th>
                  <th>Valid</th>
                  <th>Status</th>
                  <th>Scanned</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={9} className="c-sec">
                      No batches here yet.
                    </td>
                  </tr>
                )}
                {shown.map((b) => {
                  const st = statusOf(b);
                  const pct = b.quantity ? Math.round((b.scanned / b.quantity) * 100) : 0;
                  return (
                    <tr key={b.id} className={b.status === 'generated' ? 'sel' : ''}>
                      <td data-l="Batch">
                        <p className="w6">{b.ref}</p>
                        <p className="t-12 c-sec">
                          ref {b.ref}-00001…{b.area ? ` · ${b.area}` : ''}
                        </p>
                      </td>
                      <td data-l="Value" className="w6">
                        {b.valuePoints} pt
                      </td>
                      <td data-l="Qty" className="num">
                        {n(b.quantity)}
                      </td>
                      <td data-l="Product line">{lineLabel(b.line)}</td>
                      <td data-l="Made on">{date(b.createdAt)}</td>
                      <td data-l="Valid">till {date(b.expiresAt)}</td>
                      <td data-l="Status">
                        <span className={`pill ${st.tone}`} title={b.blockedReason ?? undefined}>
                          <st.icon size={13} />
                          {st.label}
                        </span>
                      </td>
                      <td data-l="Scanned">
                        <div className="row g10" style={{ minWidth: 130 }}>
                          <div className="progress grow">
                            <i style={{ width: `${pct}%`, background: pct >= 99 ? '#22c55e' : undefined }} />
                          </div>
                          <span className="t-12 c-sec" style={{ width: 34 }}>
                            {pct}%
                          </span>
                        </div>
                      </td>
                      <td style={{ position: 'relative', width: 48 }}>
                        <button className="btn ghost sm" aria-label={`Actions for ${b.ref}`} onClick={() => setMenu(menu === b.id ? null : b.id)}>
                          <MoreHorizontal size={16} />
                        </button>
                        {menu === b.id && (
                          <div className="card col g4" style={{ position: 'absolute', right: 8, top: 44, zIndex: 10, padding: 6, width: 210, boxShadow: '0 10px 30px rgba(10,22,40,.15)' }}>
                            {factory && b.status !== 'blocked' && (
                              <>
                                <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => pdf(b)}>
                                  <FileText size={14} /> Download print PDF
                                </button>
                                <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => csv(b)}>
                                  <Download size={14} /> Download CSV
                                </button>
                              </>
                            )}
                            {factory && b.status === 'generated' && (
                              <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => step(b, 'printed')}>
                                <Check size={14} /> Mark as printed
                              </button>
                            )}
                            {factory && b.status === 'printed' && (
                              <button className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => step(b, 'in_market')}>
                                <Package size={14} /> Mark in market
                              </button>
                            )}
                            {owner && b.status !== 'blocked' && (
                              <button
                                className="btn ghost sm danger"
                                style={{ justifyContent: 'flex-start' }}
                                onClick={() => {
                                  setMenu(null);
                                  setBlocking(b);
                                }}
                              >
                                <Ban size={14} /> Block whole batch
                              </button>
                            )}
                            {!factory && !owner && <p className="t-12 c-sec" style={{ padding: 8 }}>View only</p>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="note warn" style={{ fontSize: 13, lineHeight: '18px' }}>
        <FileText size={16} style={{ flex: 'none' }} />
        Coupon T&amp;C (printed on every coupon and shown in the app): “If the code is damaged, torn or not readable, GoMax is not responsible. Each code works only once.”
      </div>

      <div className="card d-only">
        <p className="t-card w7">Batch life — what each status means</p>
        <div className="grid mt16" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 12 }}>
          {[
            [Hash, 'Generated', 'Codes made, not printed yet'],
            [FileText, 'Printed', 'Printer has made the coupons'],
            [Package, 'In market', 'Coupons put inside bags and sent to dealers'],
            [ScanLine, 'Partly scanned', 'Applicators have started scanning'],
            [Check, 'Fully scanned', 'All codes used (or expired)'],
          ].map(([Icon, t, s]) => {
            const I = Icon as typeof Hash;
            return (
              <div key={t as string} className="row g10" style={{ alignItems: 'flex-start', background: 'var(--surface-muted)', borderRadius: 12, padding: '12px 14px' }}>
                <I size={16} color="var(--primary-700)" style={{ flex: 'none', marginTop: 1 }} />
                <div>
                  <p className="t-13 w6">{t as string}</p>
                  <p className="t-12 c-sec">{s as string}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {blocking && (
        <ReasonDialog
          title={`Block batch ${blocking.ref}?`}
          sub="Every unscanned code in this batch stops working in the app (lost or stolen print sheets). Saved in the Audit log."
          action="Block batch"
          danger
          picks={['Print sheets lost', 'Stolen from factory', 'Printing error']}
          onClose={() => setBlocking(null)}
          onSubmit={async (reason) => {
            await api.patch(`/coupon-batches/${blocking.id}`, { status: 'blocked', reason });
            toast(`${blocking.ref} blocked`);
            setBlocking(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function Kpi({ icon, tone, value, label, sub, subClass }: { icon: React.ReactNode; tone: string; value: string; label: string; sub: string; subClass: string }) {
  return (
    <div className="card mini">
      <span className={`kpi-icon ${tone}`}>{icon}</span>
      <div className="grow">
        <p className="t-num">{value}</p>
        <p className="t-12 c-sec">{label}</p>
        <p className={`t-12 ${subClass}`}>{sub}</p>
      </div>
    </div>
  );
}

// ── D2b–d: create batch in 3 steps ──
const MAX_QTY = 50_000; // D2b: "Max 50,000 per batch"

function Steps({ at }: { at: 1 | 2 | 3 }) {
  const s = (i: number, label: string) => (
    <div className={`step ${at === i ? 'on' : at > i ? 'done' : ''}`}>
      <span className="n">{at > i ? <Check size={14} /> : i}</span>
      {label}
    </div>
  );
  return (
    <div className="steps wrap">
      {s(1, 'Batch details')}
      <span className="step-line" style={at > 1 ? { background: '#22c55e' } : {}} />
      {s(2, 'Preview codes')}
      <span className="step-line" style={at > 2 ? { background: '#22c55e' } : {}} />
      {s(3, 'Send for printing')}
    </div>
  );
}

function CreateBatch({ onDone }: { onDone: () => void }) {
  const staff = useStaff();
  const toast = useToast();
  const [at, setAt] = useState<1 | 2 | 3>(1);
  const [value, setValue] = useState<number>(20);
  const [other, setOther] = useState('');
  const [qty, setQty] = useState('5000');
  const [line, setLine] = useState('standard');
  const [months, setMonths] = useState(12);
  const [note, setNote] = useState('');
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [codes, setCodes] = useState<{ code: string; ref: string }[] | null>(null);
  const [q, setQ] = useState('');
  const [file, setFile] = useState<'pdf' | 'csv'>('pdf');
  useHead('Create coupon batch', batch ? `Coupons › New batch › ${batch.ref}` : 'Coupons › New batch');

  const pts = value === 0 ? Number(other) || 0 : value;
  const quantity = Number(qty.replace(/\D/g, '')) || 0;
  const till = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return d.toISOString();
  }, [months]);
  const valid = pts >= 1 && pts <= 1000 && quantity >= 1 && quantity <= MAX_QTY;

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api.post<Batch>('/coupon-batches', { valuePoints: pts, quantity, line, validMonths: months, note: note.trim() || undefined, area: area.trim() || undefined });
      setBatch({ ...b, scanned: 0, progress: 'none' });
      setAt(2);
      loadCodes(b.id);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  // The API serves codes only as the print CSV (each download is logged).
  const loadCodes = (id: number) =>
    fetchCsv(id)
      .then(setCodes)
      .catch(() => setCodes([]));

  if (at === 1)
    return (
      <>
        <Steps at={1} />
        <div className="grid grid-main" style={{ gridTemplateColumns: 'minmax(0,1fr) 396px' }}>
          <div className="card col g16" style={{ padding: 28 }}>
            <p className="t-title w7">1. Batch details</p>
            <div className="field">
              <span className="label">Points per coupon</span>
              <div className="grid grid-4 m2" style={{ gap: 12 }}>
                {[10, 20, 50, 0].map((v) => (
                  <button
                    key={v}
                    className="card"
                    style={{ textAlign: 'left', padding: '14px 16px', borderWidth: value === v ? 2 : 1, borderColor: value === v ? 'var(--primary-700)' : 'var(--border-strong)', background: value === v ? 'var(--primary-50)' : '#fff' }}
                    onClick={() => setValue(v)}
                  >
                    <p className="t-title w7" style={{ color: value === v ? 'var(--primary-700)' : undefined }}>
                      {v ? `${v} pt` : 'Other'}
                    </p>
                    <p className="t-12 c-sec">{v ? `₹${v}` : 'Owner only'}</p>
                  </button>
                ))}
              </div>
              {value === 0 && <input className="input" style={{ maxWidth: 200 }} inputMode="numeric" placeholder="Points, e.g. 30" value={other} onChange={(e) => setOther(e.target.value.replace(/\D/g, ''))} autoFocus />}
            </div>
            <div className="grid grid-2" style={{ gap: 16 }}>
              <div className="field">
                <label htmlFor="qty">How many coupons</label>
                <input id="qty" className="input" inputMode="numeric" value={quantity ? n(quantity) : qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
                <p className={quantity > MAX_QTY ? 'err' : 'hint'}>Max {n(MAX_QTY)} per batch</p>
              </div>
              <div className="field">
                <label htmlFor="line">Product line (optional)</label>
                <select id="line" className="select" value={line} onChange={(e) => setLine(e.target.value)}>
                  {LINES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <p className="hint">Only for reports and “Scan Ultra coupons” challenges. The app never shows the product.</p>
              </div>
              <div className="field">
                <span className="label">Valid from</span>
                <input className="input" value={date(new Date().toISOString())} disabled />
                <p className="hint">Codes work once the factory marks the batch “In market”.</p>
              </div>
              <div className="field">
                <label htmlFor="valid">Valid till</label>
                <select id="valid" className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                  {[6, 12, 18, 24, 36].map((m) => (
                    <option key={m} value={m}>
                      {m} months
                    </option>
                  ))}
                </select>
                <p className="hint">Till {date(till)}. Default 12 months. After this the code shows “Expired”.</p>
              </div>
              <div className="field">
                <label htmlFor="area">Area (optional)</label>
                <input id="area" className="input" maxLength={40} placeholder="All areas — or e.g. Punjab · Ludhiana" value={area} onChange={(e) => setArea(e.target.value)} />
                <p className="hint">Use to track which state gets this batch. <Client>CLIENT: area list (state → district)</Client></p>
              </div>
              <div className="field">
                <label htmlFor="note">Note for printer</label>
                <input id="note" className="input" maxLength={200} placeholder="Size 30 × 20 mm, scratch silver on code" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="field">
                <span className="label">How many times can one code be scanned</span>
                <input className="input" value="1 time (one code = one scan) · locked" disabled />
                <p className="hint">Fixed — cannot be changed. After this the app says “Already used”.</p>
              </div>
              <div className="field">
                <span className="label">Unique admin code (office only)</span>
                <input className="input" value="Auto: <batch>-00001 → last" disabled />
              </div>
            </div>
            <div className="note warn" style={{ fontSize: 13, lineHeight: '18px' }}>
              <FileText size={16} style={{ flex: 'none' }} />
              T&amp;C printed on back: “Scan inside the GoMax app. One code works one time. If the code is damaged GoMax is not responsible.”
            </div>
            {error && <ErrorBox error={error} />}
            <div className="row g10" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={onDone}>
                Cancel
              </button>
              <button className="btn primary" disabled={!valid || busy} onClick={make}>
                <ArrowRight size={16} />
                {busy ? 'Making codes…' : `Make ${n(quantity)} codes`}
              </button>
            </div>
          </div>
          <div className="card col g12" style={{ background: 'var(--navy-900)', color: '#fff', border: 0, padding: 24, alignSelf: 'start' }}>
            <p className="t-card">Summary</p>
            <p style={{ fontSize: 36, lineHeight: '42px', fontWeight: 700, letterSpacing: -0.6 }}>
              {n(quantity)} × {pts} pt
            </p>
            {[
              ['Total points if all scanned', `${n(quantity * pts)} pt (${'₹' + n(quantity * pts)})`],
              ['Batch number', 'Given when made (B-…)'],
              ['Code format', 'GMX-XXXX-XXXX (8 letters/digits, no 0/O, 1/I)'],
              ['Made by', staff.name],
            ].map(([k, v]) => (
              <div key={k}>
                <p className="t-12" style={{ color: 'var(--side-sub)' }}>
                  {k}
                </p>
                <p className="t-13 w6">{v}</p>
              </div>
            ))}
            <div className="row g10" style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 14px', alignItems: 'flex-start' }}>
              <ShieldCheck size={16} color="var(--primary-500)" style={{ flex: 'none' }} />
              <p className="t-12" style={{ color: 'var(--side-text)' }}>
                Only owners can make batches. Every batch is saved in the Audit log.
              </p>
            </div>
          </div>
        </div>
      </>
    );

  const b = batch!;
  if (at === 2) {
    const list = (codes ?? []).filter((c) => !q || c.code.includes(q.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^GMX/, '')) || c.ref.includes(q.toUpperCase()));
    return (
      <>
        <Steps at={2} />
        <div className="note ok" style={{ fontSize: 13, lineHeight: '18px', padding: '14px 18px' }}>
          <CircleCheck size={16} style={{ flex: 'none' }} />
          {n(b.quantity)} codes made for {b.ref} · {b.valuePoints} pt each · all unique, checked against every old code.
        </div>
        <div className="grid grid-main">
          <div className="card col g16">
            <div className="between wrap">
              <div>
                <p className="t-card w7">Codes in this batch</p>
                <p className="t-12 c-sec">{codes ? `Showing ${Math.min(list.length, 8)} of ${n(b.quantity)}` : 'Loading…'}</p>
              </div>
              <input className="input" style={{ width: 220 }} placeholder="Search code or ref" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {!codes ? (
              <Loading rows={6} />
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Coupon code (applicator scans)</th>
                      <th>Admin reference (office only)</th>
                      <th>Value</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, 8).map((c, i) => (
                      <tr key={c.code}>
                        <td>{i + 1}</td>
                        <td className="w6 mono">{printedCode(c.code)}</td>
                        <td className="c-sec">{c.ref}</td>
                        <td>{b.valuePoints} pt</td>
                        <td>
                          <span className="pill">Generated</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="t-12 c-sec">Code = what the applicator scans / types. Reference = our serial number, printed small, used to find a coupon if the code is damaged.</p>
          </div>
          <div className="col g16">
            <div className="card col g12">
              <div>
                <p className="t-card w7">Print preview (front)</p>
                <p className="t-12 c-sec">Actual size 60 × 40 mm</p>
              </div>
              <div style={{ border: '1.5px dashed var(--border-strong)', borderRadius: 12, padding: 16 }} className="col g10">
                <div className="between">
                  <div className="row g6">
                    <span className="logo-mark" style={{ width: 22, height: 22, fontSize: 12, borderRadius: 6 }}>
                      G
                    </span>
                    <b>GoMax</b>
                  </div>
                  <span className="pill pri w6">{b.valuePoints} POINTS</span>
                </div>
                <div className="row g12">
                  <span style={{ width: 58, height: 58, border: '2px solid var(--text-primary)', borderRadius: 6, display: 'grid', placeItems: 'center' }}>
                    <QrCode size={40} />
                  </span>
                  <div>
                    <p className="t-12 c-muted">Scratch here</p>
                    <p className="mono w7" style={{ background: '#d4d7dd', borderRadius: 6, padding: '6px 10px', fontSize: 16 }}>
                      {codes?.[0] ? printedCode(codes[0].code) : 'GMX-XXXX-XXXX'}
                    </p>
                    <p className="t-12 c-muted">Ref {codes?.[0]?.ref ?? `${b.ref}-00001`}</p>
                  </div>
                </div>
                <p className="t-12 c-sec">Scan in the GoMax app. One code works one time. If the code is damaged GoMax is not responsible.</p>
              </div>
            </div>
            <div className="card col g10">
              <p className="t-card w7">Before you send</p>
              {['Codes are unique (checked)', `Value ${b.valuePoints} pt is right`, `Validity till ${date(b.expiresAt)}`, `Product line: ${lineLabel(b.line)}`].map((t) => (
                <p key={t} className="row g10 t-13">
                  <CircleCheck size={16} color="#22c55e" />
                  {t}
                </p>
              ))}
            </div>
            <div className="row g10">
              <button className="btn" onClick={onDone}>
                <ArrowLeft size={16} />
                Back to batches
              </button>
              <button className="btn primary" onClick={() => setAt(3)}>
                <ArrowRight size={16} />
                Next: send for printing
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Steps at={3} />
      <div className="grid grid-main">
        <div className="card col g16">
          <div>
            <p className="t-card w7">Choose print file</p>
            <p className="t-12 c-sec">The file has codes + reference, ready for the printer</p>
          </div>
          {(
            [
              ['pdf', FileText, 'Print-ready PDF', `48 coupons per A4 sheet · ${Math.ceil(b.quantity / 48)} pages · with cut marks`],
              ['csv', List, 'CSV file for printer', `code, admin reference, value, expiry · ${n(b.quantity)} rows`],
            ] as const
          ).map(([k, I, t, sub]) => (
            <button key={k} className="card row g12" style={{ textAlign: 'left', borderColor: file === k ? 'var(--primary-700)' : undefined, borderWidth: file === k ? 1.5 : 1, background: file === k ? 'var(--primary-50)' : undefined }} onClick={() => setFile(k)}>
              <span className="kpi-icon" style={{ background: '#fff', width: 44, height: 44, borderRadius: 10 }}>
                <I size={18} />
              </span>
              <span className="grow">
                <span className="t-13 w6" style={{ display: 'block' }}>
                  {t}
                </span>
                <span className="t-12 c-sec">{sub}</span>
              </span>
              <span style={{ width: 18, height: 18, borderRadius: 9, border: file === k ? '5px solid var(--primary-700)' : '1.5px solid var(--border-strong)' }} />
            </button>
          ))}
          <div className="note" style={{ fontSize: 13, lineHeight: '18px', color: 'var(--navy-brand)' }}>
            <Lock size={16} style={{ flex: 'none' }} />
            The download needs a login and is saved in the Audit log (who, when). Do not share codes on WhatsApp groups. Send the file to the factory login (Shivansh) yourself.
          </div>
          <div className="row g10 wrap">
            <button className="btn" onClick={() => setAt(2)}>
              <ArrowLeft size={16} />
              Back
            </button>
            <button
              className="btn primary"
              onClick={() =>
                download(`/coupon-batches/${b.id}/${file === 'pdf' ? 'print.pdf' : 'export.csv'}`, `${b.ref}.${file}`)
                  .then(() => {
                    toast(`${b.ref}.${file} downloaded`);
                    onDone();
                  })
                  .catch((e) => toast(errMsg(e), true))
              }
            >
              <Send size={16} />
              Download {file.toUpperCase()} and finish
            </button>
          </div>
        </div>
        <div className="card col g16" style={{ alignSelf: 'start' }}>
          <p className="t-card w7">Batch {b.ref} — what happens next</p>
          {[
            ['Generated', `${dateTime(b.createdAt)} · ${staff.name}`, true],
            ['Sent for printing', 'Now · to the factory login', true],
            ['Printed', 'Factory marks when coupons come back', false],
            ['In market', 'Factory puts coupons in bags, marks batch “In market”', false],
            ['Scans start', 'App accepts codes only after “In market”', false],
          ].map(([t, s, done]) => (
            <div key={t as string} className="row g12" style={{ alignItems: 'flex-start' }}>
              <span className={`kpi-icon ${done ? 'tone-ok' : 'tone-muted'}`} style={{ width: 24, height: 24, borderRadius: 12 }}>
                <Check size={14} />
              </span>
              <div>
                <p className="t-13 w6">{t as string}</p>
                <p className="t-12 c-sec">{s as string}</p>
              </div>
            </div>
          ))}
          <div className="note warn">
            <ShieldCheck size={16} style={{ flex: 'none' }} />
            Safety: codes of a batch that is not “In market” are rejected in the app (“This coupon is not active yet”). Stops misuse of stolen print sheets.
          </div>
          <NotConnected what="“send to Shivansh” — there is no factory notification yet; tell the factory yourself." />
        </div>
      </div>
    </>
  );
}

/** Reads the print CSV (code,admin_ref,value_points,expires) for the preview. */
async function fetchCsv(id: number): Promise<{ code: string; ref: string }[]> {
  const text = await csvText(`/coupon-batches/${id}/export.csv`);
  return text
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [code, ref] = l.split(',');
      return { code: code!, ref: ref! };
    });
}
