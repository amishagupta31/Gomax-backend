import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import QRCode from 'qrcode';
import { AlertTriangle, Check, CircleAlert, CircleCheck, CircleX, Copy, Eye, FileText, IdCard, Info, Lock, MessageCircle, QrCode, Send, ShieldCheck, Smartphone, Upload } from 'lucide-react';
import { api, upload, viewable } from '../api';
import { useStaff } from '../auth';
import { WD_STATUS } from '../labels';
import { canEdit } from '../roles';
import { useCounts, useHead } from '../Shell';
import { ago, Client, dateTime, Drawer, Empty, ErrorBox, errMsg, inr, initials, Loading, n, PinDialog, ReasonDialog, spacedMobile, spacedUtr, time, useLoad, useToast } from '../ui';

// D4a queue (21:9013) · D4c review drawer (21:9667) · D11a manual UPI "To pay" (21:19619)
// · D11b pay manually (21:20241) · D11c upload proof + UTR (21:21058).
// requested → approve (PIN) → approved → lock 15 min, pay in UPI app, screenshot + UTR → paid.
export type Wd = {
  id: string;
  amount: number;
  status: 'requested' | 'held' | 'approved' | 'paid' | 'rejected' | 'failed';
  reason: string | null;
  name: string;
  mobile: string;
  upiId: string;
  upiName: string | null;
  panName: string | null;
  nameDiffers: boolean;
  cashHold: boolean;
  hasQr: boolean;
  lockedBy: string | null;
  requestedAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  utr: string | null;
  payoutMode: 'manual' | 'razorpayx' | null;
  payoutStatus: string | null;
  payoutRef: string | null;
  payoutError: string | null;
  upiIntent: string;
};
type List = { rows: Wd[]; nextCursor: string | null; paidLast24h: { n: number; total: number } };
type Tab = 'waiting' | 'approved' | 'paid' | 'failed' | 'rejected';

/** D4a "Checks" column. */
export function checkOf(w: Wd): { label: string; tone: string; icon: typeof Check; review: boolean } {
  if (w.cashHold) return { label: 'Fraud flag', tone: 'bad', icon: AlertTriangle, review: true };
  if (!w.panName) return { label: 'PAN missing', tone: 'warn', icon: IdCard, review: true };
  if (w.nameDiffers) return { label: 'Name mismatch', tone: 'warn', icon: AlertTriangle, review: true };
  if (w.status === 'held') return { label: 'Under check', tone: 'warn', icon: Eye, review: true };
  return { label: 'KYC ok', tone: 'ok', icon: CircleCheck, review: false };
}

const REJECT_PICKS = ['UPI name does not match', 'PAN missing', 'Suspicious scans', 'Over monthly limit'];

export default function Withdrawals() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'waiting';
  const setTab = (t: Tab) => setParams(t === 'waiting' ? {} : { tab: t });
  const { counts } = useCounts();
  const approved = useLoad<List>(() => api.get('/withdrawals?status=approved'), [tab]);
  useHead(
    'Withdrawals',
    tab === 'approved'
      ? `${approved.data?.rows.length ?? 0} to pay · ${inr(approved.data?.rows.reduce((s, r) => s + r.amount, 0))}`
      : `${counts?.withdrawals ?? 0} waiting · pay within 24–48 hrs`,
  );
  return (
    <>
      <div className="between wrap">
        <div className="segmented" role="tablist" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {(
            [
              ['waiting', 'Waiting', counts?.withdrawals],
              ['approved', 'To pay', approved.data?.rows.length],
              ['paid', 'Paid'],
              ['failed', 'Failed'],
              ['rejected', 'Rejected'],
            ] as [Tab, string, number?][]
          ).map(([t, l, c]) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {l} {c !== undefined && <span className="count" style={tab === t ? { background: 'rgba(255,255,255,0.18)', color: '#fff' } : {}}>{c}</span>}
            </button>
          ))}
        </div>
      </div>
      {tab === 'waiting' && <Waiting />}
      {tab === 'approved' && <ToPay list={approved} />}
      {(tab === 'paid' || tab === 'failed' || tab === 'rejected') && <History status={tab} />}
    </>
  );
}

// ── D4a: waiting queue ──
function Waiting() {
  const staff = useStaff();
  const toast = useToast();
  const { refresh } = useCounts();
  const can = canEdit(staff.role, '/withdrawals');
  const settings = useLoad<{ settings: { withdraw: { minPoints: number; maxPerRequest: number; maxPerMonth: number } } }>(() => api.get('/settings'));
  const list = useLoad(async () => {
    const [r, h] = await Promise.all([api.get<List>('/withdrawals?status=requested'), api.get<List>('/withdrawals?status=held')]);
    return [...r.rows, ...h.rows].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pin, setPin] = useState<Wd[] | null>(null);
  const [rejecting, setRejecting] = useState<Wd | null>(null);
  const [review, setReview] = useState<Wd | null>(null);
  const rows = list.data ?? [];
  const chosen = rows.filter((r) => sel.has(r.id));
  const w = settings.data?.settings.withdraw;
  const done = () => {
    setSel(new Set());
    list.reload();
    refresh();
  };

  return (
    <>
      <div className="note" style={{ fontSize: 13, lineHeight: '18px', color: 'var(--navy-brand)', padding: '14px 18px' }}>
        <Info size={18} style={{ flex: 'none' }} />
        Rules: minimum {n(w?.minPoints ?? 500)} pt · max {inr(w?.maxPerRequest ?? 5000)} per request · max {inr(w?.maxPerMonth ?? 15000)} per month per applicator · pay within 24–48 hrs by manual UPI · change in Settings.
      </div>
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      <div className="card flush">
        {list.loading && !list.data ? (
          <div style={{ padding: 20 }}>
            <Loading rows={5} />
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={<CircleCheck size={28} />} title="No withdrawals waiting" sub="New cash requests from the app appear here." />
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    {can && (
                      <input
                        type="checkbox"
                        aria-label="Select all with KYC ok"
                        checked={sel.size > 0 && rows.filter((r) => !checkOf(r).review).every((r) => sel.has(r.id))}
                        onChange={(e) => setSel(new Set(e.target.checked ? rows.filter((r) => !checkOf(r).review).map((r) => r.id) : []))}
                      />
                    )}
                  </th>
                  <th>Applicator</th>
                  <th>Amount</th>
                  <th>Pay to UPI</th>
                  <th>Checks</th>
                  <th>Asked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const c = checkOf(r);
                  const old = Date.now() - new Date(r.requestedAt).getTime() > 86_400_000;
                  return (
                    <tr key={r.id} className={sel.has(r.id) ? 'sel' : ''}>
                      <td>
                        {can && !c.review && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.name}`}
                            checked={sel.has(r.id)}
                            onChange={(e) => {
                              const s = new Set(sel);
                              if (e.target.checked) s.add(r.id);
                              else s.delete(r.id);
                              setSel(s);
                            }}
                          />
                        )}
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
                      <td data-l="Amount">
                        <p className="w7">{inr(r.amount)}</p>
                        <p className="t-12 c-sec">{n(r.amount)} pt</p>
                      </td>
                      <td data-l="Pay to UPI">
                        <p className="w5">{r.upiId}</p>
                        <p className="t-12 c-sec">
                          Name on UPI: {r.upiName ?? '—'} {r.nameDiffers ? '×' : '✓'}
                        </p>
                      </td>
                      <td data-l="Checks">
                        <span className={`pill ${c.tone}`}>
                          <c.icon size={13} />
                          {c.label}
                        </span>
                        {r.reason && r.status === 'held' && <p className="t-12 c-sec mt4">{r.reason}</p>}
                      </td>
                      <td data-l="Asked" className={old ? 'c-bad' : 'c-sec'}>
                        {ago(r.requestedAt)}
                      </td>
                      <td>
                        {can && (
                          <div className="row g6" style={{ justifyContent: 'flex-end' }}>
                            {c.review ? (
                              <button className="btn sm" style={{ background: 'var(--warning-50)', borderColor: 'var(--warning-50)', color: 'var(--warning-text)' }} onClick={() => setReview(r)}>
                                <Eye size={14} />
                                Review
                              </button>
                            ) : (
                              <button className="btn sm" style={{ background: 'var(--success-50)', borderColor: 'var(--success-50)', color: 'var(--success-text)' }} onClick={() => setPin([r])}>
                                <Check size={14} />
                                Approve
                              </button>
                            )}
                            <button className="btn sm" onClick={() => setRejecting(r)}>
                              Reject
                            </button>
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
      {chosen.length > 0 && (
        <div className="between wrap" style={{ background: 'var(--navy-900)', color: '#fff', borderRadius: 16, padding: '16px 20px', position: 'sticky', bottom: 16 }}>
          <p className="t-card w7">
            {chosen.length} selected · {inr(chosen.reduce((s, r) => s + r.amount, 0))}
          </p>
          <button className="btn" style={{ background: 'var(--success-50)', borderColor: 'var(--success-50)', color: 'var(--success-text)' }} onClick={() => setPin(chosen)}>
            <Check size={16} />
            Approve {chosen.length} → to pay
          </button>
        </div>
      )}
      {pin && (
        <PinDialog
          title={pin.length === 1 ? `Approve ${inr(pin[0]!.amount)} to ${pin[0]!.name}?` : `Approve ${pin.length} withdrawals?`}
          sub={`Total ${inr(pin.reduce((s, r) => s + r.amount, 0))}. They move to “To pay”. The applicator gets a WhatsApp.`}
          action={pin.length === 1 ? 'Approve' : `Approve ${pin.length}`}
          onClose={() => setPin(null)}
          onSubmit={async (p) => {
            let ok = 0;
            const failed: string[] = [];
            for (const r of pin) {
              try {
                await api.post(`/withdrawals/${r.id}/approve`, { pin: p });
                ok++;
              } catch (e) {
                // Wrong PIN / PIN locked on the first one: keep the PIN dialog open with the message.
                const status = (e as { status?: number }).status;
                if (ok === 0 && failed.length === 0 && (status === 403 || status === 423)) throw e;
                failed.push(`${r.name}: ${errMsg(e)}`);
              }
            }
            setPin(null);
            setReview(null);
            toast(failed.length ? `${ok} approved · ${failed.length} not: ${failed[0]}` : `${ok} approved → To pay`, failed.length > 0);
            done();
          }}
        />
      )}
      {rejecting && (
        <ReasonDialog
          title={`Reject ${inr(rejecting.amount)} for ${rejecting.name}?`}
          sub="Their points go back to their wallet. They see the reason in the app and on WhatsApp."
          action="Reject + return points"
          danger
          picks={REJECT_PICKS}
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => {
            await api.post(`/withdrawals/${rejecting.id}/reject`, { reason });
            toast(`Rejected · ${n(rejecting.amount)} points back to ${rejecting.name}`);
            setRejecting(null);
            setReview(null);
            done();
          }}
        />
      )}
      {review && !pin && !rejecting && <ReviewDrawer w={review} onClose={() => setReview(null)} onApprove={() => setPin([review])} onReject={() => setRejecting(review)} onDone={done} />}
    </>
  );
}

// ── D4c: review / reject drawer ──
function ReviewDrawer({ w, onClose, onApprove, onReject, onDone }: { w: Wd; onClose: () => void; onApprove: () => void; onReject: () => void; onDone: () => void }) {
  const staff = useStaff();
  const toast = useToast();
  const [reason, setReason] = useState(w.nameDiffers ? REJECT_PICKS[0]! : !w.panName ? REJECT_PICKS[1]! : w.cashHold ? REJECT_PICKS[2]! : '');
  const person = useLoad(async () => {
    const r = await api.get<{ rows: { id: string; mobile: string }[] }>(`/applicators?q=${w.mobile}`);
    const id = r.rows.find((x) => x.mobile === w.mobile)?.id;
    return id ? api.get(`/applicators/${id}`) : null;
  });
  const p = person.data;
  const message =
    reason === REJECT_PICKS[0]
      ? `Your withdrawal of ${inr(w.amount)} is on hold. The name on your UPI is different from your GoMax name. Please add a UPI in your own name. Your ${n(w.amount)} points are safe in your wallet.`
      : `Your withdrawal of ${inr(w.amount)} was not approved: ${reason || '…'}. Your ${n(w.amount)} points are back in your wallet.`;

  return (
    <Drawer
      title={
        <span className="person">
          <span className="avatar lg">{initials(w.name)}</span>
          <span>
            <span className="t-card w6" style={{ display: 'block' }}>
              {w.name}
            </span>
            <span className="t-12 c-sec">
              {spacedMobile(w.mobile)}
              {p?.city ? ` · ${p.city}` : ''} · {w.id}
            </span>
          </span>
        </span>
      }
      onClose={onClose}
    >
      <div className="row g16 wrap" style={{ background: 'var(--success-50)', borderRadius: 16, padding: '18px 20px' }}>
        <div>
          <p className="t-12 c-ok">Wants to withdraw</p>
          <p style={{ fontSize: 36, lineHeight: '42px', fontWeight: 700, color: 'var(--success-text)' }}>{inr(w.amount)}</p>
        </div>
        {p && (
          <div className="t-13">
            <p className="w5">Wallet now {n(p.points)} pt (amount already taken)</p>
            <p className="c-sec">Lifetime {n(p.lifetimePoints)} pt · {p.rank?.name}</p>
          </div>
        )}
      </div>
      <p className="caps">Checks</p>
      <div className="col g12">
        <CheckLine ok text={`Mobile + password login${p ? `, joined ${ago(p.createdAt)}` : ''}`} />
        <CheckLine ok={!!w.panName} text={w.panName ? `PAN added · name ${w.panName}` : 'PAN not added'} />
        <CheckLine ok={!w.nameDiffers} text={w.nameDiffers ? `UPI name “${w.upiName ?? '—'}” ≠ PAN name “${w.panName ?? '—'}”` : `UPI name ${w.upiName} matches PAN`} />
        <CheckLine ok={!w.cashHold} bad={w.cashHold} text={w.cashHold ? 'Fraud flag open — an owner must clear it (Scans log → Flags)' : 'No fraud flags'} />
        {p && p.scans.failed > 0 && <CheckLine ok={false} bad={p.scans.failed > 5} text={`${n(p.scans.failed)} failed coupon tries in total (Scans log)`} />}
        {w.status === 'held' && w.reason && <CheckLine ok={false} text={`On hold: ${w.reason}`} />}
      </div>
      <p className="caps">Reject reason (sent to applicator on WhatsApp + app)</p>
      <div className="row wrap g6">
        {[...REJECT_PICKS, 'Other'].map((r) => (
          <button key={r} className={`pill ${reason === r ? 'navy' : ''}`} style={{ cursor: 'pointer', border: reason === r ? 0 : '1px solid var(--border-strong)', background: reason === r ? undefined : '#fff', padding: '7px 12px', fontSize: 13 }} onClick={() => setReason(r === 'Other' ? '' : r)}>
            {r}
          </button>
        ))}
      </div>
      <input className="input" placeholder="Or type a reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      <div style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: '14px 16px' }}>
        <p className="t-12 c-sec">Applicator will see:</p>
        <p className="t-13 mt4">“{message}”</p>
      </div>
      <div className="row g10 wrap">
        <button
          className="btn danger"
          style={{ background: 'var(--danger-50)', borderColor: 'var(--danger-50)' }}
          disabled={reason.trim().length < 3}
          onClick={async () => {
            try {
              await api.post(`/withdrawals/${w.id}/reject`, { reason: reason.trim() });
              toast(`Rejected · points back to ${w.name}`);
              onDone();
              onClose();
            } catch (e) {
              toast(errMsg(e), true);
            }
          }}
        >
          <CircleX size={16} />
          Reject + return points
        </button>
        <button className="btn" onClick={onApprove} disabled={w.cashHold && staff.role !== 'owner'}>
          <Check size={16} />
          Approve anyway
        </button>
        {w.status === 'requested' && (
          <button
            className="btn ghost c-pri"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              try {
                await api.post(`/withdrawals/${w.id}/hold`, { reason: reason.trim() });
                toast('On hold · applicator sees “Under check” · owner can decide');
                onDone();
                onClose();
              } catch (e) {
                toast(errMsg(e), true);
              }
            }}
          >
            <Send size={16} />
            Hold · ask owner
          </button>
        )}
      </div>
      <p className="t-12 c-muted">Approve anyway needs an owner login for flagged applicators. Every action goes to the Audit log.</p>
      <button className="link" style={{ alignSelf: 'flex-start' }} onClick={onReject}>
        Reject with a different reason…
      </button>
    </Drawer>
  );
}
const CheckLine = ({ ok, bad, text }: { ok: boolean; bad?: boolean; text: string }) => (
  <p className="row g10 t-13" style={{ alignItems: 'flex-start' }}>
    {ok ? <CircleCheck size={16} color="var(--success-text)" style={{ flex: 'none' }} /> : <AlertTriangle size={16} color={bad ? 'var(--danger-text)' : 'var(--warning-text)'} style={{ flex: 'none' }} />}
    {text}
  </p>
);

// ── D11a: approved, to pay by hand (or RazorpayX) ──
function ToPay({ list }: { list: ReturnType<typeof useLoad<List>> }) {
  const staff = useStaff();
  const toast = useToast();
  const { refresh } = useCounts();
  const can = canEdit(staff.role, '/withdrawals');
  const [paying, setPaying] = useState<Wd | null>(null);
  const rows = list.data?.rows ?? [];
  const today = list.data?.paidLast24h;
  const manual = rows.some((r) => r.payoutMode !== 'razorpayx');

  const start = async (w: Wd) => {
    try {
      await api.post(`/withdrawals/${w.id}/lock`);
      setPaying(w);
    } catch (e) {
      toast(errMsg(e), true);
      list.reload();
    }
  };

  return (
    <>
      {manual && (
        <div className="note" style={{ fontSize: 13, lineHeight: '18px', color: 'var(--navy-brand)', padding: '14px 18px' }}>
          <Info size={18} style={{ flex: 'none' }} />
          <span>
            Pay from the GoMax current-account UPI app. Last 24 hrs: {today?.n ?? 0} UPI payments · {inr(today?.total)} of ₹1,00,000 daily limit (~20 payments). Above the limit, use Bank bulk (NEFT) or the payout API. <Client>CLIENT to confirm bank + limit</Client>
          </span>
        </div>
      )}
      {list.error && <ErrorBox error={list.error} retry={list.reload} />}
      <div className="card flush">
        {list.loading && !list.data ? (
          <div style={{ padding: 20 }}>
            <Loading rows={4} />
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={<CircleCheck size={28} />} title="Nothing to pay" sub="Approved withdrawals appear here." />
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Amount</th>
                  <th>UPI ID / name on UPI</th>
                  <th>QR</th>
                  <th>KYC</th>
                  <th>Approved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const auto = r.payoutMode === 'razorpayx';
                  const lockedByOther = r.lockedBy && r.lockedBy !== staff.id;
                  return (
                    <tr key={r.id}>
                      <td data-l="Person">
                        <p className="w6">{r.name}</p>
                        <p className="t-12 c-sec">
                          {r.id} · {spacedMobile(r.mobile)}
                        </p>
                      </td>
                      <td data-l="Amount" className="w6">
                        {inr(r.amount)}
                      </td>
                      <td data-l="UPI">
                        <p className="w6">{r.upiId}</p>
                        <p className="t-12 c-sec">Name on UPI: {r.upiName ?? '—'}</p>
                      </td>
                      <td data-l="QR" className="t-12 c-sec">
                        {r.hasQr ? (
                          <span className="row g6">
                            <QrCode size={22} color="var(--text-primary)" />
                            QR uploaded
                          </span>
                        ) : (
                          'UPI ID only'
                        )}
                      </td>
                      <td data-l="KYC">{r.nameDiffers ? <span className="pill warn">Name check</span> : <span className="pill ok">PAN ✓</span>}</td>
                      <td data-l="Approved">{r.approvedAt ? `Approved ${time(r.approvedAt)}` : '—'}</td>
                      <td>
                        {auto ? (
                          <div className="col g4" style={{ alignItems: 'flex-end' }}>
                            <span className={`pill ${r.payoutStatus === 'error' ? 'bad' : 'info'}`}>RazorpayX · {r.payoutStatus ?? 'queued'}</span>
                            {r.payoutError && <span className="t-12 c-bad">{r.payoutError}</span>}
                          </div>
                        ) : !can ? null : lockedByOther ? (
                          <span className="pill">
                            <Lock size={13} />
                            Someone is paying
                          </span>
                        ) : (
                          <button className={`btn ${r.nameDiffers ? '' : 'primary'}`} onClick={() => start(r)}>
                            <QrCode size={16} />
                            Pay manually
                          </button>
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
      <div className="card row g12" style={{ alignItems: 'flex-start' }}>
        <ShieldCheck size={18} color="var(--success-text)" style={{ flex: 'none' }} />
        <p className="t-13">
          Safety: pay only rows that are Approved. Never pay a UPI ID typed on a call. If the name on UPI does not match the person, stop and call them. Each payment needs a screenshot + 12-digit UTR before it can be marked Paid.
        </p>
      </div>
      {paying && (
        <PayDrawer
          w={paying}
          onClose={() => {
            setPaying(null);
            list.reload();
          }}
          onDone={() => {
            setPaying(null);
            list.reload();
            refresh();
          }}
          toast={toast}
        />
      )}
    </>
  );
}

// ── D11b → D11c ──
function PayDrawer({ w, onClose, onDone, toast }: { w: Wd; onClose: () => void; onDone: () => void; toast: (t: string, bad?: boolean) => void }) {
  const staff = useStaff();
  const [stage, setStage] = useState<'pay' | 'proof'>('pay');
  const [qr, setQr] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [object, setObject] = useState<string | null>(null);
  const [utr, setUtr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<'back' | 'fail' | null>(null);
  const note = `GoMax ${w.id}`;

  useEffect(() => {
    QRCode.toDataURL(w.upiIntent, { margin: 1, width: 360 }).then(setQr);
    if (w.hasQr)
      api
        .get<{ url: string }>(`/withdrawals/${w.id}/qr`)
        .then((r) => setUploaded(viewable(r.url)))
        .catch(() => {});
  }, [w]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const copy = (t: string) =>
    navigator.clipboard
      .writeText(t)
      .then(() => toast('Copied'))
      .catch(() => toast('Could not copy', true));

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\//.test(f.type)) return setError('Upload the payment screenshot (a photo).');
    setError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setObject(null);
    try {
      setObject(await upload('payment_proof', f));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const markPaid = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/withdrawals/${w.id}/mark-paid`, { utr, proofObject: object });
      toast(`${inr(w.amount)} marked paid · ${w.name} gets the UTR on WhatsApp`);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'pay')
    return (
      <Drawer
        title={`Pay ${inr(w.amount)} to ${w.name}`}
        sub={`Withdrawal ${w.id} · Applicator · ${spacedMobile(w.mobile)}`}
        onClose={onClose}
        footer={
          <>
            <button className="btn" onClick={() => setAsk('back')}>
              <CircleAlert size={16} />
              Problem — send back
            </button>
            <button className="btn primary" onClick={() => setStage('proof')}>
              <Upload size={16} />I have paid → upload proof
            </button>
          </>
        }
      >
        <div className="row g20 wrap" style={{ background: 'var(--surface-muted)', borderRadius: 16, padding: 16, alignItems: 'flex-start' }}>
          <div className="col g6" style={{ alignItems: 'center' }}>
            {uploaded ? <img src={uploaded} alt="UPI QR uploaded by the applicator" width={172} height={172} style={{ objectFit: 'contain', background: '#fff', borderRadius: 8 }} /> : qr && <img src={qr} alt={`UPI QR for ${w.upiId}`} width={172} height={172} style={{ borderRadius: 8 }} />}
            <p className="t-12 c-sec">{uploaded ? `QR uploaded by ${w.name.split(' ')[0]}` : 'QR made from the UPI ID'}</p>
          </div>
          <div className="col g10 grow" style={{ minWidth: 200 }}>
            <Copyable label="UPI ID" value={w.upiId} onCopy={copy} />
            <div>
              <p className="t-12 c-sec">Name on UPI (check in your app)</p>
              <p className="t-card w7">{w.upiName ?? '—'}</p>
            </div>
            <Copyable label="Amount (pay exactly)" value={String(w.amount)} shown={inr(w.amount)} onCopy={copy} />
            <Copyable label="Note to add in UPI app" value={note} onCopy={copy} />
          </div>
        </div>
        <p className="caps">How to pay</p>
        {[
          'Open the GoMax company UPI app on your phone (current account).',
          'Scan this QR from the screen, or paste the UPI ID. On a phone: tap “Open UPI app” below.',
          `Check the name shown is ${w.upiName ?? w.name}. Pay ${inr(w.amount)} with note “${note}”.`,
          'Take a screenshot of the success screen and note the 12-digit UTR.',
        ].map((t, i) => (
          <div key={i} className="row g12" style={{ alignItems: 'flex-start' }}>
            <span className="kpi-icon tone-navy" style={{ width: 24, height: 24, borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
              {i + 1}
            </span>
            <p className="t-13">{t}</p>
          </div>
        ))}
        <a className="btn m-only" href={w.upiIntent}>
          <Smartphone size={16} />
          Open UPI app (pre-filled)
        </a>
        <div className="note">
          <Lock size={16} style={{ flex: 'none' }} />
          This row is locked to you ({staff.name.split(' ')[0]}) for 15 minutes so nobody pays it twice.
        </div>
        {ask === 'back' && (
          <ReasonDialog
            title="Send back to approval?"
            sub="Use this if the UPI name is wrong or the payment did not go. Nothing was paid. It goes back to Waiting with your reason."
            action="Send back"
            picks={['Name on UPI does not match', 'UPI ID not found', 'Bank limit reached today']}
            onClose={() => setAsk(null)}
            onSubmit={async (reason) => {
              await api.post(`/withdrawals/${w.id}/send-back`, { reason });
              toast('Sent back to Waiting');
              onDone();
            }}
          />
        )}
      </Drawer>
    );

  const utrOk = /^\d{12}$/.test(utr);
  return (
    <Drawer
      title={`Payment proof · ${inr(w.amount)} to ${w.name}`}
      sub={`${w.id} · ${w.upiId}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={() => setAsk('fail')}>
            Payment failed
          </button>
          <button className="btn" onClick={() => setStage('pay')}>
            Back
          </button>
          <button className="btn primary" disabled={!utrOk || !object || busy} onClick={markPaid}>
            <CircleCheck size={16} />
            {busy ? 'Saving…' : 'Mark as paid'}
          </button>
        </>
      }
    >
      <label className="row g16" style={{ background: 'var(--surface-muted)', borderRadius: 16, padding: 16, cursor: 'pointer', alignItems: 'flex-start' }}>
        <div className="photo" style={{ width: 120, height: 200, flex: 'none', backgroundColor: '#fff', backgroundImage: preview ? `url(${preview})` : 'none' }}>
          {!preview && <Upload size={24} />}
        </div>
        <div className="col g6">
          <p className="t-13 w6">{file ? file.name : 'Payment screenshot (required)'}</p>
          <p className="t-12 c-sec">{file ? `${Math.round(file.size / 1024)} KB · ${object ? 'uploaded' : 'uploading…'}` : 'Tap to choose the success screenshot from the UPI app'}</p>
          <span className="btn sm" style={{ alignSelf: 'flex-start' }}>
            <Upload size={14} />
            {file ? 'Replace' : 'Choose screenshot'}
          </span>
        </div>
        <input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      <div className="field">
        <label htmlFor="utr">
          UTR / UPI reference no. <span className="c-bad">*</span>
        </label>
        <input id="utr" className="input lg mono" inputMode="numeric" maxLength={12} placeholder="12 digits" value={utr} onChange={(e) => setUtr(e.target.value.replace(/\D/g, ''))} />
        <p className={utrOk ? 'hint c-ok' : 'hint'}>{utrOk ? `12 digits ✓ · ${spacedUtr(utr)} · checked for repeats when you save` : `${utr.length}/12 digits`}</p>
      </div>
      <p className="caps">What happens when you mark paid</p>
      <div className="card col g10">
        <p className="row g10 t-13">
          <Smartphone size={16} /> App: withdrawal shows “Paid” with the UTR
        </p>
        <p className="row g10 t-13">
          <MessageCircle size={16} /> WhatsApp: “{inr(w.amount)} sent to your UPI · UTR {utrOk ? spacedUtr(utr) : '…'}”
        </p>
        <p className="row g10 t-13">
          <FileText size={16} /> Ledger: points debit is final; proof + UTR saved for audit
        </p>
      </div>
      {error && <ErrorBox error={error} />}
      {ask === 'fail' && (
        <ReasonDialog
          title="Payment failed?"
          sub="Use this only if money did not reach them (wrong UPI). Their points go back and they are asked to fix their UPI."
          action="Mark failed + return points"
          danger
          picks={['Wrong UPI ID', 'UPI app declined', 'Bank server down']}
          onClose={() => setAsk(null)}
          onSubmit={async (reason) => {
            await api.post(`/withdrawals/${w.id}/fail`, { reason });
            toast('Marked failed · points back');
            onDone();
          }}
        />
      )}
    </Drawer>
  );
}

const Copyable = ({ label, value, shown, onCopy }: { label: string; value: string; shown?: string; onCopy: (v: string) => void }) => (
  <div>
    <p className="t-12 c-sec">{label}</p>
    <p className="row g6 t-card w7">
      {shown ?? value}
      <button className="btn ghost sm" style={{ padding: '0 6px', height: 24, color: 'var(--primary-700)' }} onClick={() => onCopy(value)} aria-label={`Copy ${label}`}>
        <Copy size={14} />
      </button>
    </p>
  </div>
);

// ── history ──
function History({ status }: { status: 'paid' | 'failed' | 'rejected' }) {
  const [rows, setRows] = useState<Wd[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad<List>(() => api.get(`/withdrawals?status=${status}&limit=50`), [status]);
  useEffect(() => {
    if (data) {
      setRows(data.rows);
      setCursor(data.nextCursor);
    }
  }, [data]);
  const total = useMemo(() => rows.reduce((s, r) => s + r.amount, 0), [rows]);
  const more = async () => {
    const r = await api.get<List>(`/withdrawals?status=${status}&limit=50&cursor=${cursor}`);
    setRows((x) => [...x, ...r.rows]);
    setCursor(r.nextCursor);
  };
  const exportCsv = () => {
    const head = 'id,name,mobile,amount,upi,status,utr,reason,requested,paid';
    const lines = rows.map((r) => [r.id, r.name, r.mobile, r.amount, r.upiId, r.status, r.utr ?? '', r.reason ?? '', r.requestedAt, r.paidAt ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `withdrawals-${status}.csv` }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="between">
        <p className="t-13 c-sec">
          {rows.length} shown · {inr(total)}
        </p>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          Export
        </button>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      <div className="card flush">
        {loading && !rows.length ? (
          <div style={{ padding: 20 }}>
            <Loading rows={5} />
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Applicator</th>
                  <th>Amount</th>
                  <th>UPI</th>
                  <th>{status === 'paid' ? 'UTR' : 'Reason'}</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="c-sec">
                      Nothing here yet.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-l="ID">{r.id}</td>
                    <td data-l="Applicator">
                      <p className="w6">{r.name}</p>
                      <p className="t-12 c-sec">{spacedMobile(r.mobile)}</p>
                    </td>
                    <td data-l="Amount" className="w6">
                      {inr(r.amount)}
                    </td>
                    <td data-l="UPI">{r.upiId}</td>
                    <td data-l={status === 'paid' ? 'UTR' : 'Reason'} className={status === 'paid' ? 'mono' : 'c-sec'}>
                      {status === 'paid' ? spacedUtr(r.utr) : r.reason}
                    </td>
                    <td data-l="Status">
                      <span className={`pill ${WD_STATUS[r.status]?.tone}`}>{WD_STATUS[r.status]?.label}</span>
                      {r.payoutMode === 'razorpayx' && <span className="t-12 c-sec"> · RazorpayX</span>}
                    </td>
                    <td data-l="When">{dateTime(r.paidAt ?? r.requestedAt)}</td>
                  </tr>
                ))}
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
    </>
  );
}
