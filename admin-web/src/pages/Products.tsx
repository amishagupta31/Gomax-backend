import { useRef, useState } from 'react';
import { Box, FileText, Info, Languages, Pencil, Plus, Upload } from 'lucide-react';
import { api, upload } from '../api';
import { useStaff } from '../auth';
import { useHead } from '../Shell';
import { date, Drawer, ErrorBox, errMsg, Loading, NotConnected, Toggle, useLoad, useToast } from '../ui';

// D9a Products & TDS (21:14811). Info only — no points, no prices, no dealer list.
// A new TDS PDF replaces the old one (versioned in storage).
type Product = { id: string; name: string; category: string; data: Record<string, any>; tdsObject: string | null; tdsBytes: number | null; tdsUpdatedAt: string | null; sort: number; active: boolean };
const CATS: [string, string][] = [
  ['adhesive', 'Tile adhesive'],
  ['grout', 'Grout & epoxy'],
  ['waterproofing', 'Waterproofing'],
  ['other', 'Others'],
];
const catLabel = (c: string) => CATS.find(([v]) => v === c)?.[1] ?? c;
const GRAD: Record<string, string> = { adhesive: '#9aa3b5,#c7ccd6', grout: '#c47a1a,#f5c96a', waterproofing: '#1f7a6d,#6fc2b0', other: '#b91c1c,#ef8f8f' };

export default function Products() {
  const staff = useStaff();
  const toast = useToast();
  const owner = staff.role === 'owner';
  const [cat, setCat] = useState('all');
  const [edit, setEdit] = useState<Product | 'new' | null>(null);
  const { data, error, loading, reload, setData } = useLoad<{ products: Product[] }>(() => api.get('/products'));
  const all = data?.products ?? [];
  const shown = cat === 'all' ? all : all.filter((p) => (cat === 'other' ? !CATS.slice(0, 3).some(([v]) => v === p.category) : p.category === cat));
  useHead('Products & TDS', `${all.length} products · ${all.filter((p) => p.tdsObject).length} with TDS PDF`);

  const put = async (p: Product, patch: Partial<Product>) => {
    const next = { ...p, ...patch };
    await api.put(`/products/${p.id}`, { name: next.name, category: next.category, data: next.data, sort: next.sort, active: next.active, ...(patch.tdsObject ? { tdsObject: patch.tdsObject, tdsBytes: patch.tdsBytes ?? undefined } : {}) });
  };
  const toggle = async (p: Product, active: boolean) => {
    setData({ products: all.map((x) => (x.id === p.id ? { ...x, active } : x)) });
    try {
      await put(p, { active });
      toast(`${p.name} ${active ? 'shown' : 'hidden'} in the app`);
    } catch (e) {
      toast(errMsg(e), true);
      reload();
    }
  };

  return (
    <>
      <div className="between wrap">
        <div className="segmented" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {[['all', 'All'] as [string, string], ...CATS].map(([v, l]) => (
            <button key={v} className={cat === v ? 'on' : ''} onClick={() => setCat(v)}>
              {l}
              <span className="count">{v === 'all' ? all.length : v === 'other' ? all.filter((p) => !CATS.slice(0, 3).some(([c]) => c === p.category)).length : all.filter((p) => p.category === v).length}</span>
            </button>
          ))}
        </div>
        {owner && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Plus size={16} />
            Add product
          </button>
        )}
      </div>
      <div className="note" style={{ fontSize: 13, lineHeight: '18px', color: 'var(--navy-brand)', padding: '14px 18px' }}>
        <Info size={18} style={{ flex: 'none' }} />
        No points on product pages. The app never links a coupon to a product. No “find a dealer” list.
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
                  <th>Product</th>
                  <th>Line</th>
                  <th>TDS PDF</th>
                  <th>Languages</th>
                  <th>Live</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td data-l="Product">
                      <div className="person">
                        <span className="kpi-icon" style={{ width: 40, height: 40, borderRadius: 10, background: `linear-gradient(135deg, ${GRAD[p.category] ?? GRAD.other})`, color: '#fff' }}>
                          <Box size={18} />
                        </span>
                        <div>
                          <p className="w6">{p.name}</p>
                          <p className="t-12 c-sec">{[p.data.pack, p.data.type].filter(Boolean).join(' · ')}</p>
                        </div>
                      </div>
                    </td>
                    <td data-l="Line">{catLabel(p.category)}</td>
                    <td data-l="TDS PDF">
                      {p.tdsObject ? (
                        <span className="row g6">
                          <FileText size={15} color="var(--danger-text)" />
                          <span>
                            {p.tdsObject.split('/').pop()}
                            <span className="t-12 c-sec" style={{ display: 'block' }}>
                              {p.tdsBytes ? `${Math.round(p.tdsBytes / 1024)} KB · ` : ''}
                              {date(p.tdsUpdatedAt)}
                            </span>
                          </span>
                        </span>
                      ) : (
                        <span className="pill warn">
                          <Upload size={13} />
                          TDS missing
                        </span>
                      )}
                    </td>
                    <td data-l="Languages">
                      <span className="pill">
                        <Languages size={13} />
                        English
                      </span>
                    </td>
                    <td data-l="Live">
                      <Toggle on={p.active} disabled={!owner} label={`${p.name} live`} onChange={(v) => toggle(p, v)} />
                    </td>
                    <td>
                      {owner && (
                        <div className="row g6" style={{ justifyContent: 'flex-end' }}>
                          <TdsButton p={p} onUploaded={reload} put={put} />
                          <button className="btn ghost sm" aria-label={`Edit ${p.name}`} onClick={() => setEdit(p)}>
                            <Pencil size={15} />
                          </button>
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
      <NotConnected what="Hindi / Punjabi product text — products have one language in the API today." />
      {edit && (
        <ProductDrawer
          p={edit === 'new' ? null : edit}
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

function TdsButton({ p, onUploaded, put }: { p: Product; onUploaded: () => void; put: (p: Product, patch: Partial<Product>) => Promise<void> }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className={`btn sm ${p.tdsObject ? '' : 'primary'}`} disabled={busy} onClick={() => ref.current?.click()}>
        <Upload size={14} />
        {busy ? 'Uploading…' : p.tdsObject ? 'Replace PDF' : 'Upload PDF'}
      </button>
      <input
        ref={ref}
        type="file"
        accept="application/pdf"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.type !== 'application/pdf') return toast('Upload a PDF', true);
          setBusy(true);
          try {
            const object = await upload('tds', f);
            await put(p, { tdsObject: object, tdsBytes: f.size });
            toast(`TDS for ${p.name} updated · the app shows the new PDF`);
            onUploaded();
          } catch (err) {
            toast(errMsg(err), true);
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

function ProductDrawer({ p, onClose, onSaved }: { p: Product | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(p?.name ?? '');
  const [category, setCategory] = useState(p?.category ?? 'adhesive');
  const [type, setType] = useState<string>(p?.data.type ?? '');
  const [pack, setPack] = useState<string>(p?.data.pack ?? '');
  const [coverage, setCoverage] = useState<string>(p?.data.coverage ?? '');
  const [summary, setSummary] = useState<string>(p?.data.summary ?? '');
  const [sort, setSort] = useState(String(p?.sort ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = (p?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 40);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/products/${id}`, { name: name.trim(), category, data: { ...(p?.data ?? {}), type, pack, coverage, summary }, sort: Number(sort) || 0, active: p?.active ?? true });
      toast(p ? 'Product saved' : 'Product added');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={p ? `Edit ${p.name}` : 'Add product'}
      sub="Shown on the app’s Products pages. No points, no prices. Saved in the Audit log."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || name.trim().length < 2 || id.length < 2} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="pn">Name</label>
        <input id="pn" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        {!p && id && <p className="hint">ID: {id}</p>}
      </div>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="pc">Line</label>
          <select id="pc" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ps">Order in the list</label>
          <input id="ps" className="input" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="pt">Type</label>
          <input id="pt" className="input" value={type} onChange={(e) => setType(e.target.value)} placeholder="Tile adhesive" />
        </div>
        <div className="field">
          <label htmlFor="pp">Pack</label>
          <input id="pp" className="input" value={pack} onChange={(e) => setPack(e.target.value)} placeholder="20 kg bag" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pv">Coverage</label>
        <input id="pv" className="input" value={coverage} onChange={(e) => setCoverage(e.target.value)} placeholder="45–55 sq ft" />
      </div>
      <div className="field">
        <label htmlFor="pm">Short text (shown on the product page)</label>
        <textarea id="pm" className="textarea" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <p className="hint">Other details (standards, jobs, set time…) are kept as they are.</p>
      {error && <ErrorBox error={error} />}
    </Drawer>
  );
}
