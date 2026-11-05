import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Box, Camera, Check, Coins, Image, List, Package, Pencil, Plus, Truck, Upload, X } from 'lucide-react';
import { api, upload, viewable } from '../api';
import { useStaff } from '../auth';
import { STEP } from '../labels';
import { canEdit } from '../roles';
import { useCounts, useHead } from '../Shell';
import { ago, Client, date, dateTime, Drawer, Empty, ErrorBox, errMsg, initials, Loading, n, ReasonDialog, spacedMobile, Toggle, useLoad, useToast } from '../ui';

// D5a Gift catalogue (21:10343) · D5b Orders board (21:10615) · D5c Order detail + courier (21:10905).
// Booked → Packed → Shipped (courier + AWB) → Delivered (photo proof). Each step updates the app + WhatsApp.
type Gift = { id: string; name: string; runsPrice: number; stock: number | null; active: boolean; photos: string[]; sizes: string[]; marketValueInr: number | null; sort: number };
type Address = { name: string; mobile: string; street: string; city: string; pin: string };
type Order = {
  id: string;
  giftId: string;
  giftName: string;
  runs: number;
  size: string | null;
  step: 'booked' | 'packed' | 'shipped' | 'delivered' | 'cancelled';
  dates: { booked: string; packed: string | null; shipped: string | null; delivered: string | null; cancelled: string | null };
  eta: string | null;
  courier: { name: string; awb: string; url: string | null } | null;
  receivedBy: string | null;
  deliveryPhotoUrl: string | null;
  address: Address | null;
  applicator: { name: string; mobile: string };
  stale: boolean;
};
type Board = { rows: Order[]; counts: Record<string, number> };
const COURIERS = ['DTDC', 'Delhivery', 'India Post', 'Blue Dart', 'Xpressbees', 'Ekart', 'Other'];
const GRADIENTS = ['#c7ccd6,#9aa3b5', '#e8a58f,#c05336', '#6fc2b0,#1f7a6d', '#8ea4e8,#1f3f9c', '#f5c96a,#c47a1a', '#b8bdc7,#565d6a', '#ef8f8f,#b91c1c'];

export default function Gifts() {
  const [params, setParams] = useSearchParams();
  const staff = useStaff();
  const tab = params.get('tab') === 'catalogue' ? 'catalogue' : 'orders';
  const { counts } = useCounts();
  useHead('Gifts & courier', tab === 'orders' ? `${counts?.gifts ?? 0} to act on (booked + packed)` : 'Gift catalogue · runs price, stock, live');
  return (
    <>
      <div className="segmented">
        <button className={tab === 'catalogue' ? 'on' : ''} onClick={() => setParams({ tab: 'catalogue' })}>
          Catalogue
        </button>
        <button className={tab === 'orders' ? 'on' : ''} onClick={() => setParams({})}>
          Orders <span className="count">{counts?.gifts ?? 0}</span>
        </button>
      </div>
      {tab === 'catalogue' ? <Catalogue owner={staff.role === 'owner'} /> : <OrdersBoard openId={params.get('order')} />}
    </>
  );
}

// ── D5a ──
function Catalogue({ owner }: { owner: boolean }) {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useLoad<{ gifts: Gift[] }>(() => api.get('/gifts'));
  const [edit, setEdit] = useState<Gift | 'new' | null>(null);
  const gifts = data?.gifts ?? [];
  const toggle = async (g: Gift, active: boolean) => {
    setData({ gifts: gifts.map((x) => (x.id === g.id ? { ...x, active } : x)) });
    try {
      await api.patch(`/gifts/${g.id}`, { active });
      toast(`${g.name} is ${active ? 'live in the app' : 'hidden from the app'}`);
    } catch (e) {
      toast(errMsg(e), true);
      reload();
    }
  };
  return (
    <>
      <div className="between wrap">
        <p className="t-13 c-sec">
          {gifts.filter((g) => g.active).length} gifts live · {gifts.filter((g) => g.stock !== null && g.stock <= 5).length} low on stock
        </p>
        {owner && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Plus size={16} />
            Add gift
          </button>
        )}
      </div>
      <div className="note warn" style={{ fontSize: 13, lineHeight: '18px', padding: '14px 18px' }}>
        <AlertTriangle size={16} style={{ flex: 'none' }} />
        <span className="grow">CLIENT to send: runs price for each gift (“kis gift par kitna”) and the final gift list with photos.</span>
        <b className="d-only">Needed from client</b>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      {loading && !data && (
        <div className="card">
          <Loading />
        </div>
      )}
      {data && gifts.length === 0 && (
        <div className="card">
          <Empty icon={<Box size={28} />} title="No gifts yet" sub={owner ? 'Add the first gift — it goes live in the app’s Gifts tab.' : 'Owners add gifts.'} />
        </div>
      )}
      <div className="grid grid-4 m2">
        {gifts.map((g, i) => {
          const photo = viewable(g.photos[0]);
          const low = g.stock !== null && g.stock <= 5;
          return (
            <div key={g.id} className="card flush">
              <div className="photo" style={{ height: 150, borderRadius: 0, background: photo ? `center / cover url(${photo})` : `linear-gradient(135deg, ${GRADIENTS[i % GRADIENTS.length]})`, color: 'rgba(255,255,255,0.85)' }}>
                {!photo && <Box size={42} strokeWidth={1.4} />}
              </div>
              <div className="col g10" style={{ padding: 16 }}>
                <div className="between">
                  <p className="t-card w6">{g.name}</p>
                  {owner && (
                    <button className="btn ghost sm" aria-label={`Edit ${g.name}`} onClick={() => setEdit(g)}>
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
                <div className="row g6 wrap">
                  <span className="pill" style={{ background: '#e8f4f7', color: 'var(--gift-text)' }}>
                    <Coins size={13} />
                    {n(g.runsPrice)} runs
                  </span>
                  {g.marketValueInr ? <span className="t-12 c-sec">worth ₹{n(g.marketValueInr)}</span> : <span className="t-12 c-warn">price: CLIENT</span>}
                </div>
                <div className="between">
                  <span className={`t-13 ${low ? 'c-warn w6' : 'c-sec'}`}>{g.stock === null ? 'Stock not tracked' : `Stock ${g.stock}`}</span>
                  <span className="row g6 t-12 c-sec">
                    Live
                    <Toggle on={g.active} disabled={!owner} label={`${g.name} live`} onChange={(v) => toggle(g, v)} />
                  </span>
                </div>
                {g.sizes.length > 0 && <p className="t-12 c-sec">Sizes: {g.sizes.join(', ')}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {edit && (
        <GiftDrawer
          gift={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function GiftDrawer({ gift, onClose, onSaved }: { gift: Gift | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(gift?.name ?? '');
  const [runs, setRuns] = useState(gift ? String(gift.runsPrice) : '');
  const [stock, setStock] = useState(gift?.stock != null ? String(gift.stock) : '');
  const [worth, setWorth] = useState(gift?.marketValueInr != null ? String(gift.marketValueInr) : '');
  const [sizes, setSizes] = useState(gift?.sizes.join(', ') ?? '');
  const [photos, setPhotos] = useState(gift?.photos.join('\n') ?? '');
  const [active, setActive] = useState(gift?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = (gift?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 40);
  const ok = name.trim().length >= 2 && Number(runs) > 0 && slug.length >= 2;
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      runsPrice: Number(runs),
      stock: stock === '' ? null : Number(stock),
      marketValueInr: worth === '' ? null : Number(worth),
      sizes: sizes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      photos: photos
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4),
      active,
    };
    try {
      if (gift) await api.patch(`/gifts/${gift.id}`, body);
      else await api.post('/gifts', { id: slug, ...body });
      toast(gift ? 'Gift saved' : `${body.name} added${active ? ' and live' : ''}`);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={gift ? `Edit ${gift.name}` : 'Add a gift'}
      sub="Goes live in the app’s Gifts tab with photo + runs price. Saved in the Audit log."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok || busy} onClick={save}>
            {busy ? 'Saving…' : gift ? 'Save' : active ? 'Save + make live' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="gn">Gift name</label>
        <input id="gn" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Wall clock" maxLength={80} />
        {!gift && slug && <p className="hint">ID: {slug}</p>}
      </div>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="gr">Runs price</label>
          <input id="gr" className="input" inputMode="numeric" value={runs} onChange={(e) => setRuns(e.target.value.replace(/\D/g, ''))} />
          <Client>CLIENT to share</Client>
        </div>
        <div className="field">
          <label htmlFor="gs">Stock (empty = not tracked)</label>
          <input id="gs" className="input" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="gw">Market value ₹ (optional)</label>
          <input id="gw" className="input" inputMode="numeric" value={worth} onChange={(e) => setWorth(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="gz">Sizes (optional, comma separated)</label>
          <input id="gz" className="input" value={sizes} onChange={(e) => setSizes(e.target.value)} placeholder="S, M, L, XL" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="gp">Photo links (up to 4, one per line)</label>
        <textarea id="gp" className="textarea" value={photos} onChange={(e) => setPhotos(e.target.value)} placeholder="https://…" />
        <p className="hint">Photo upload for gifts is not connected yet (the API takes photo links). Use links to images on the GoMax storage.</p>
      </div>
      <label className="row g10 t-13">
        <Toggle on={active} onChange={setActive} label="Live" />
        Live in the app
      </label>
      {error && <ErrorBox error={error} />}
    </Drawer>
  );
}

// ── D5b ──
const COLS: { step: Order['step']; label: string; icon: typeof List; tone: string }[] = [
  { step: 'booked', label: 'Booked', icon: List, tone: '' },
  { step: 'packed', label: 'Packed', icon: Package, tone: 'warn' },
  { step: 'shipped', label: 'Shipped', icon: Truck, tone: 'info' },
  { step: 'delivered', label: 'Delivered', icon: Package, tone: 'ok' },
];

function OrdersBoard({ openId }: { openId: string | null }) {
  const staff = useStaff();
  const toast = useToast();
  const { refresh } = useCounts();
  const can = canEdit(staff.role, '/gifts');
  const board = useLoad(async () => {
    const lists = await Promise.all(COLS.map((c) => api.get<Board>(`/gift-orders?step=${c.step}${c.step === 'delivered' ? '&limit=20' : ''}`)));
    return { counts: lists[0]!.counts, rows: lists.flatMap((l) => l.rows) };
  });
  const [open, setOpen] = useState<Order | null>(null);
  useEffect(() => {
    if (openId && board.data) setOpen(board.data.rows.find((o) => o.id === openId) ?? null);
  }, [openId, board.data]);
  const counts = board.data?.counts ?? {};
  const pack = async (o: Order) => {
    try {
      await api.post(`/gift-orders/${o.id}/pack`);
      toast(`${o.id} packed · ${o.applicator.name} told on WhatsApp`);
      board.reload();
      refresh();
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
  const exportCsv = () => {
    const rows = board.data?.rows ?? [];
    const head = 'order,gift,runs,step,applicator,mobile,city,pin,courier,awb,booked';
    const lines = rows.map((o) => [o.id, o.giftName, o.runs, o.step, o.applicator.name, o.applicator.mobile, o.address?.city ?? '', o.address?.pin ?? '', o.courier?.name ?? '', o.courier?.awb ?? '', o.dates.booked].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'gift-orders.csv' }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="between wrap">
        <p className="t-13 c-sec">Orders older than 2 days in Booked have an orange border.</p>
        <button className="btn" onClick={exportCsv} disabled={!board.data?.rows.length}>
          Export
        </button>
      </div>
      {board.error && <ErrorBox error={board.error} retry={board.reload} />}
      {board.loading && !board.data ? (
        <div className="card">
          <Loading rows={5} />
        </div>
      ) : (
        <div className="grid grid-4" style={{ alignItems: 'start' }}>
          {COLS.map((c) => {
            const rows = board.data?.rows.filter((o) => o.step === c.step) ?? [];
            return (
              <div key={c.step} className="col g12" style={{ background: '#eef0f3', borderRadius: 16, padding: 12 }}>
                <div className="row g6" style={{ padding: '4px 4px 0' }}>
                  <c.icon size={16} />
                  <span className="t-13 w6">{c.label}</span>
                  <span className={`pill ${c.tone}`} style={{ padding: '0 8px' }}>
                    {counts[c.step] ?? 0}
                  </span>
                </div>
                {rows.length === 0 && <p className="t-12 c-muted" style={{ padding: 8 }}>Nothing here</p>}
                {rows.map((o) => (
                  <div key={o.id} className="card col g10" style={{ padding: 14, cursor: 'pointer', borderColor: o.stale ? '#f0a35c' : undefined, borderWidth: o.stale ? 1.5 : 1 }} onClick={() => setOpen(o)}>
                    <div className="between">
                      <span className="t-12 c-sec">{o.id}</span>
                      <span className="pill" style={{ background: '#e8f4f7', color: 'var(--gift-text)' }}>
                        {n(o.runs)} runs
                      </span>
                    </div>
                    <p className="t-13 w6">{o.giftName}</p>
                    <div className="person">
                      <span className="avatar sm">{initials(o.applicator.name)}</span>
                      <div style={{ minWidth: 0 }}>
                        <p className="t-13 w6 ellipsis">{o.applicator.name}</p>
                        <p className="t-12 c-sec ellipsis">
                          {spacedMobile(o.applicator.mobile)}
                          {o.address?.city ? ` · ${o.address.city}` : ''}
                        </p>
                      </div>
                    </div>
                    {o.step === 'booked' && <p className={`t-12 ${o.stale ? 'c-bad' : 'c-sec'}`}>Booked {ago(o.dates.booked)}{o.size ? ` · Size: ${o.size}` : ''}</p>}
                    {o.step === 'packed' && <p className="t-12 c-sec">Packed {ago(o.dates.packed)}</p>}
                    {o.courier && o.step !== 'delivered' && (
                      <p className="row g6 t-12 c-info">
                        <Truck size={13} />
                        {o.courier.name} · AWB {o.courier.awb}
                      </p>
                    )}
                    {o.step === 'delivered' && (
                      <p className="row g6 t-12 c-ok">
                        <Image size={13} />
                        Photo proof · {o.receivedBy ?? 'received'}
                      </p>
                    )}
                    {can && o.step === 'booked' && (
                      <button
                        className="btn sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          pack(o);
                        }}
                      >
                        <Package size={14} />
                        Mark packed
                      </button>
                    )}
                    {can && o.step === 'packed' && (
                      <button className="btn sm primary">
                        <Truck size={14} />
                        Add courier + AWB
                      </button>
                    )}
                    {can && o.step === 'shipped' && (
                      <button className="btn sm">
                        <Camera size={14} />
                        Add delivery proof
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {open && (
        <OrderDrawer
          o={open}
          can={can}
          owner={staff.role === 'owner'}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            board.reload();
            refresh();
          }}
        />
      )}
    </>
  );
}

// ── D5c ──
function OrderDrawer({ o, can, owner, onClose, onDone }: { o: Order; can: boolean; owner: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [courier, setCourier] = useState('DTDC');
  const [other, setOther] = useState('');
  const [awb, setAwb] = useState('');
  const [url, setUrl] = useState('');
  const [eta, setEta] = useState('');
  const [received, setReceived] = useState(o.address?.name ?? o.applicator.name);
  const [photo, setPhoto] = useState<{ file: File; preview: string; object: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const courierName = courier === 'Other' ? other.trim() : courier;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(msg);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const st = STEP[o.step]!;
  const steps: [string, string | null][] = [
    ['Booked', o.dates.booked],
    ['Packed', o.dates.packed],
    ['Shipped', o.dates.shipped],
    ['Delivered', o.dates.delivered],
  ];
  const first = o.applicator.name.split(' ')[0];

  return (
    <Drawer
      wide
      title={
        <span className="row g10">
          {o.id} <span className={`pill ${st.tone}`}>{st.label}</span>
        </span>
      }
      sub={`${o.giftName} · ${n(o.runs)} runs${o.size ? ` · size ${o.size}` : ''} · ${o.applicator.name}${o.address?.city ? `, ${o.address.city}` : ''} (${spacedMobile(o.applicator.mobile)})`}
      onClose={onClose}
    >
      <div className="row g10 wrap">
        {steps.map(([l, d], i) => (
          <div key={l} className="row g10">
            <div>
              <p className="row g6 t-13 w5">
                <span style={{ width: 10, height: 10, borderRadius: 5, background: d ? '#22c55e' : 'var(--border-strong)' }} />
                {l}
              </p>
              <p className="t-12 c-muted">{d ? dateTime(d) : '—'}</p>
            </div>
            {i < 3 && <span className="step-line" style={{ width: 28, background: steps[i + 1]![1] ? '#22c55e' : undefined }} />}
          </div>
        ))}
      </div>
      {o.address && (
        <div className="card col g4">
          <p className="caps">Address (from app)</p>
          <p className="t-13 w6">
            {o.address.name} · {spacedMobile(o.address.mobile)}
          </p>
          <p className="t-13">
            {o.address.street}, {o.address.city} {o.address.pin}
          </p>
        </div>
      )}
      {can && (o.step === 'booked' || o.step === 'packed') && (
        <div className="card col g12">
          <p className="t-card w7">Ship it</p>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="cr">Courier</label>
              <select id="cr" className="select" value={courier} onChange={(e) => setCourier(e.target.value)}>
                {COURIERS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              {courier === 'Other' && <input className="input" placeholder="Courier name" value={other} onChange={(e) => setOther(e.target.value)} />}
            </div>
            <div className="field">
              <label htmlFor="awb">AWB / tracking number</label>
              <input id="awb" className="input" value={awb} onChange={(e) => setAwb(e.target.value.trim())} placeholder="D71845601" />
            </div>
            <div className="field">
              <label htmlFor="eta">Expected delivery (optional)</label>
              <input id="eta" className="input" type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="trk">Tracking link (optional)</label>
              <input id="trk" className="input" value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="https://…" />
            </div>
          </div>
          <div className="row g10">
            {o.step === 'booked' && (
              <button className="btn" disabled={busy} onClick={() => run(() => api.post(`/gift-orders/${o.id}/pack`), `${o.id} packed`)}>
                <Package size={16} />
                Mark packed only
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy || awb.length < 4 || courierName.length < 2 || (!!url && !/^https?:\/\//.test(url))}
              onClick={() => run(() => api.post(`/gift-orders/${o.id}/ship`, { courierName, awb, trackingUrl: url || undefined, eta: eta || undefined }), `${o.id} shipped · ${first} gets the AWB on WhatsApp`)}
            >
              <Truck size={16} />
              Save + mark Shipped
            </button>
          </div>
        </div>
      )}
      {can && o.step === 'shipped' && (
        <div className="card col g12">
          <p className="t-card w7">Delivered</p>
          <p className="t-13 c-sec">
            {o.courier?.name} · AWB {o.courier?.awb}. A photo of the delivered gift is required.
          </p>
          <label className="row g12" style={{ cursor: 'pointer' }}>
            <div className="photo" style={{ width: 96, height: 96, flex: 'none', backgroundImage: photo ? `url(${photo.preview})` : undefined }}>
              {!photo && <Camera size={22} />}
            </div>
            <span className="btn sm">
              <Upload size={14} />
              {photo ? (photo.object ? 'Replace photo' : 'Uploading…') : 'Add delivery photo'}
            </span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const preview = URL.createObjectURL(f);
                setPhoto({ file: f, preview, object: null });
                try {
                  const object = await upload('delivery_photo', f);
                  setPhoto({ file: f, preview, object });
                } catch (err) {
                  setError(errMsg(err));
                }
              }}
            />
          </label>
          <div className="field">
            <label htmlFor="rcv">Who received it</label>
            <input id="rcv" className="input" value={received} onChange={(e) => setReceived(e.target.value)} />
          </div>
          <button
            className="btn ok"
            style={{ alignSelf: 'flex-start' }}
            disabled={busy || !photo?.object || received.trim().length < 2}
            onClick={() => run(() => api.post(`/gift-orders/${o.id}/deliver`, { photoObject: photo!.object, receivedBy: received.trim() }), `${o.id} delivered · ${first} told on WhatsApp`)}
          >
            <Check size={16} />
            Mark delivered
          </button>
        </div>
      )}
      {o.step === 'delivered' && (
        <div className="card col g10">
          <p className="t-card w7">Delivered {date(o.dates.delivered)}</p>
          <p className="t-13">Received by {o.receivedBy}</p>
          {viewable(o.deliveryPhotoUrl) ? <img src={viewable(o.deliveryPhotoUrl)!} alt="Delivery proof" style={{ borderRadius: 12, maxHeight: 280, objectFit: 'cover' }} /> : <p className="t-12 c-sec">Photo saved (preview not available in local dev).</p>}
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {(o.step === 'booked' || o.step === 'packed' || o.step === 'shipped') && (
        <>
          <p className="caps">What {first} will see</p>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="card col g6" style={{ border: '3px solid var(--navy-900)', borderRadius: 18 }}>
              <p className="t-13 w6">My gifts</p>
              <p className="t-13 w6">{o.giftName}</p>
              <div className="row g4">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= (o.step === 'shipped' ? 3 : 2) ? 'var(--gift-text)' : 'var(--border-strong)' }} />
                ))}
              </div>
              <p className="t-13 w6" style={{ color: 'var(--gift-text)' }}>
                {o.step === 'shipped' ? 'Delivered' : 'Shipped'}
              </p>
            </div>
            <div className="card col g6" style={{ background: '#efeae2' }}>
              <p className="t-12 w6">GoMax ✓</p>
              <p className="t-12" style={{ background: '#fff', borderRadius: 8, padding: 10 }}>
                {o.step === 'shipped' ? `Your GoMax gift is delivered! ${o.giftName}` : `Your GoMax gift is on the way! ${o.giftName} · Courier: ${courierName || '…'} · Tracking: ${awb || '…'}`}
              </p>
            </div>
          </div>
        </>
      )}
      {owner && o.step !== 'delivered' && o.step !== 'cancelled' && (
        <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => setCancel(true)}>
          <X size={16} />
          Cancel order (runs + stock go back)
        </button>
      )}
      {cancel && (
        <ReasonDialog
          title={`Cancel ${o.id}?`}
          sub={`${n(o.runs)} runs go back to ${o.applicator.name} and the stock goes back up.`}
          action="Cancel order"
          danger
          picks={['Out of stock', 'Address not reachable', 'Applicator asked to cancel']}
          onClose={() => setCancel(false)}
          onSubmit={async (reason) => {
            await api.post(`/gift-orders/${o.id}/cancel`, { reason });
            toast(`${o.id} cancelled · runs back`);
            onDone();
          }}
        />
      )}
    </Drawer>
  );
}
