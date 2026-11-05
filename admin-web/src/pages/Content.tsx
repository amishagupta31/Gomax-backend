import { useEffect, useState } from 'react';
import { CalendarClock, GripVertical, Pencil, Plus, Save } from 'lucide-react';
import { api } from '../api';
import { useStaff } from '../auth';
import { useHead } from '../Shell';
import { Client, date, Drawer, ErrorBox, errMsg, Loading, Segmented, Toggle, useLoad, useToast } from '../ui';

// D8a Home content (21:13735): cards on the app Home (3 languages, rule, order,
// live) and the "How GoMax works" + T&C text per language. Owners edit.
type L3 = { en: string; hi?: string; pa?: string };
type Card = { id: number; title: L3; body: L3; art: string; rule: Rule; startsAt: string | null; endsAt: string | null; link: string | null; sort: number; active: boolean };
type Rule = 'always' | 'first_7_days' | 'from_2nd_visit' | 'date_range';
type Lang = 'en' | 'hi' | 'pa';
const RULES: [Rule, string][] = [
  ['first_7_days', 'First 7 days (first-time user)'],
  ['always', 'Always'],
  ['date_range', 'Date range (e.g. festival)'],
  ['from_2nd_visit', 'From 2nd visit'],
];
const GROUPS: { title: string; sub: string; rules: Rule[] }[] = [
  { title: 'Hero — first-time user', sub: 'Shown only in the first 7 days', rules: ['first_7_days'] },
  { title: 'Hero — normal days', sub: 'Always on, or for a date range', rules: ['always', 'date_range'] },
  { title: 'Small cards', sub: 'From the 2nd visit', rules: ['from_2nd_visit'] },
];
const LANGS: [Lang, string][] = [
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['pa', 'Punjabi'],
];
const ART: Record<string, string> = { coin: '🪙', sparkles: '✨', trophy: '🏆', chart: '📈', party: '🎉', card: '💳', scroll: '📜', gift: '🎁', qr: '🔳' };

export default function Content() {
  const staff = useStaff();
  const owner = staff.role === 'owner';
  const { data, error, loading, reload } = useLoad<{ cards: Card[]; pages: { key: string; body: L3 }[] }>(() => api.get('/content'));
  const [edit, setEdit] = useState<Card | 'new' | null>(null);
  useHead('Home content', 'Cards and text on the app Home · changes go live on the next app open');
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !data) return <div className="card"><Loading rows={6} /></div>;
  const cards = data!.cards;
  return (
    <>
      {owner && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={() => setEdit('new')}>
            <Plus size={16} />
            Add card
          </button>
        </div>
      )}
      <div className="grid grid-main">
        <div className="col g20">
          {GROUPS.map((g) => {
            const rows = cards.filter((c) => g.rules.includes(c.rule));
            return (
              <div key={g.title} className="card col g10">
                <div>
                  <p className="t-card w7">{g.title}</p>
                  <p className="t-12 c-sec">{g.sub}</p>
                </div>
                {rows.length === 0 && <p className="t-13 c-sec">No cards yet.</p>}
                {rows.map((c, i) => (
                  <div key={c.id} className="row g12" style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: '10px 12px' }}>
                    <GripVertical size={16} color="var(--text-muted)" />
                    <span style={{ fontSize: 22 }}>{ART[c.art] ?? '✨'}</span>
                    <div className="grow">
                      <p className="t-13 w6">
                        {i + 1} · {c.title.en}
                      </p>
                      <p className="t-12 c-sec ellipsis">“{c.body.en}”</p>
                    </div>
                    {c.rule === 'date_range' && c.startsAt && c.endsAt && new Date(c.startsAt) > new Date() ? (
                      <span className="pill warn">
                        <CalendarClock size={12} />
                        Scheduled · {date(c.startsAt)}
                      </span>
                    ) : c.active ? (
                      <span className="pill ok">Live</span>
                    ) : (
                      <span className="pill">Off</span>
                    )}
                    {owner && (
                      <button className="btn ghost sm" aria-label={`Edit ${c.title.en}`} onClick={() => setEdit(c)}>
                        <Pencil size={15} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          <div className="card col g10">
            <div>
              <p className="t-card w7">Hero card order — app shows the first one that applies</p>
              <p className="t-12 c-sec">Built into the app (not editable here)</p>
            </div>
            {['First-time pager · new users, first open', 'Withdraw ready · points 500 or more', 'Free spin left · spins left today', 'Active challenge · joined a live challenge', 'Scan coupon · default card'].map((t, i) => (
              <p key={t} className="t-13" style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: '10px 12px' }}>
                {i + 1} · {t}
              </p>
            ))}
          </div>
          <PageEditor title="How GoMax works" pageKey="how_it_works" initial={data!.pages.find((p) => p.key === 'how_it_works')?.body} owner={owner} onSaved={reload} />
          <PageEditor title="Terms & conditions" pageKey="terms" initial={data!.pages.find((p) => p.key === 'terms')?.body} owner={owner} onSaved={reload} />
        </div>
        <div className="card col g12" style={{ alignSelf: 'start' }}>
          <p className="t-card w7">Live preview</p>
          <div className="col g10" style={{ border: '3px solid var(--navy-900)', borderRadius: 18, padding: 14, background: 'var(--primary-50)' }}>
            <p className="t-13 w6">← Home</p>
            {cards
              .filter((c) => c.active)
              .slice(0, 3)
              .map((c, i) => (
                <div key={c.id} className={i === 0 ? 'col g4' : 'row g8'} style={i === 0 ? { background: 'var(--navy-900)', color: '#fff', borderRadius: 12, padding: 12 } : { background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px' }}>
                  <span style={{ fontSize: i === 0 ? 22 : 16 }}>{ART[c.art] ?? '✨'}</span>
                  <span className="t-13 w6">{c.title.en}</span>
                  {i === 0 && <span className="t-12" style={{ color: 'var(--side-text)' }}>{c.body.en}</span>}
                </div>
              ))}
            {cards.filter((c) => c.active).length === 0 && <p className="t-12 c-sec">No live cards — the app shows its built-in cards.</p>}
          </div>
          <p className="t-12 c-sec">Bag / product photos are never shown on Home — only coupon and points visuals.</p>
        </div>
      </div>
      {edit && (
        <CardDrawer
          card={edit === 'new' ? null : edit}
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

function PageEditor({ title, pageKey, initial, owner, onSaved }: { title: string; pageKey: string; initial?: L3; owner: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [lang, setLang] = useState<Lang>('en');
  const [body, setBody] = useState<L3>(initial ?? { en: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => setBody(initial ?? { en: '' }), [initial]);
  return (
    <div className="card col g12">
      <div className="between wrap">
        <div>
          <p className="t-card w7">{title}</p>
          <p className="t-12 c-sec">English is required; Hindi / Punjabi fall back to English when empty</p>
        </div>
        <Segmented value={lang} onChange={setLang} options={LANGS} />
      </div>
      <textarea className="textarea" style={{ minHeight: 160 }} disabled={!owner} value={body[lang] ?? ''} onChange={(e) => setBody({ ...body, [lang]: e.target.value })} aria-label={`${title} in ${lang}`} />
      {pageKey === 'terms' && <Client>T&C: CLIENT to send final text (all 3 languages)</Client>}
      {owner && (
        <button
          className="btn primary"
          style={{ alignSelf: 'flex-start' }}
          disabled={busy || !body.en.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api.put(`/content/pages/${pageKey}`, { body: { en: body.en, ...(body.hi ? { hi: body.hi } : {}), ...(body.pa ? { pa: body.pa } : {}) } });
              toast(`${title} saved · in the Audit log`);
              onSaved();
            } catch (e) {
              toast(errMsg(e), true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save size={16} />
          Save
        </button>
      )}
    </div>
  );
}

function CardDrawer({ card, onClose, onSaved }: { card: Card | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [lang, setLang] = useState<Lang>('en');
  const [title, setTitle] = useState<L3>(card?.title ?? { en: '' });
  const [body, setBody] = useState<L3>(card?.body ?? { en: '' });
  const [art, setArt] = useState(card?.art ?? 'sparkles');
  const [rule, setRule] = useState<Rule>(card?.rule ?? 'always');
  const [startsAt, setStartsAt] = useState(card?.startsAt?.slice(0, 10) ?? '');
  const [endsAt, setEndsAt] = useState(card?.endsAt?.slice(0, 10) ?? '');
  const [sort, setSort] = useState(String(card?.sort ?? 0));
  const [active, setActive] = useState(card?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = (t: L3) => ({ en: t.en.trim(), ...(t.hi?.trim() ? { hi: t.hi.trim() } : {}), ...(t.pa?.trim() ? { pa: t.pa.trim() } : {}) });
  const ok = title.en.trim() && body.en.trim() && (rule !== 'date_range' || (startsAt && endsAt));
  const save = async () => {
    setBusy(true);
    setError(null);
    const b = {
      title: clean(title),
      body: clean(body),
      art,
      rule,
      startsAt: startsAt ? new Date(`${startsAt}T00:00:00+05:30`).toISOString() : null,
      endsAt: endsAt ? new Date(`${endsAt}T23:59:59+05:30`).toISOString() : null,
      sort: Number(sort) || 0,
      active,
    };
    try {
      if (card) await api.patch(`/content/cards/${card.id}`, b);
      else await api.post('/content/cards', b);
      toast('Card saved');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title={card ? 'Edit card' : 'Add card'}
      sub="Shown on the app Home in the applicator’s language. Saved in the Audit log."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok || busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <Segmented value={lang} onChange={setLang} options={LANGS} />
      <div className="field">
        <label htmlFor="ct">Title ({lang === 'en' ? 'required' : 'optional'})</label>
        <input id="ct" className="input" maxLength={80} value={title[lang] ?? ''} onChange={(e) => setTitle({ ...title, [lang]: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="cb">Text ({lang === 'en' ? 'required' : 'optional'})</label>
        <textarea id="cb" className="textarea" maxLength={300} value={body[lang] ?? ''} onChange={(e) => setBody({ ...body, [lang]: e.target.value })} />
      </div>
      <div className="field">
        <span className="label">Icon</span>
        <div className="row wrap g6">
          {Object.entries(ART).map(([k, e]) => (
            <button key={k} className={`pill ${art === k ? 'pri' : ''}`} style={{ fontSize: 18, cursor: 'pointer', border: art === k ? '1.5px solid var(--primary-700)' : '1px solid var(--border)' }} onClick={() => setArt(k)} aria-label={k}>
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="cr">When to show</label>
          <select id="cr" className="select" value={rule} onChange={(e) => setRule(e.target.value as Rule)}>
            {RULES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cs">Order</label>
          <input id="cs" className="input" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="cf">From {rule === 'date_range' && <span className="c-bad">*</span>}</label>
          <input id="cf" className="input" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cu">Till {rule === 'date_range' && <span className="c-bad">*</span>}</label>
          <input id="cu" className="input" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
      </div>
      <label className="row g10 t-13">
        <Toggle on={active} onChange={setActive} label="Live" />
        Live in the app
      </label>
      {error && <ErrorBox error={error} />}
    </Drawer>
  );
}
