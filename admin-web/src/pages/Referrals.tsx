import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Coins, Search, TriangleAlert, UserPlus, Users } from 'lucide-react';
import { api } from '../api';
import { useHead } from '../Shell';
import { Client, Empty, ErrorBox, initials, Loading, n, spacedMobile, useLoad } from '../ui';
import type { Row } from './Applicators';
import { LevelTable, TreeList, treeStats, useTree } from './ReferralTree';

// D6a Referral tree — one applicator (21:11573) · D6b all applicators (21:11892).
// Referral pays RUNS: +50 on a direct friend's 1st coupon, and every level L1–L4 earns
// 10% of the points scanned by the person below. Levels are shown only here, never in the app.
type Referral = { firstCouponBonusRuns: number; levelSharePct: number; levels: number; monthlyCapRuns: number };

export default function Referrals() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = useLoad<{ settings: { referral: Referral } }>(() => api.get('/settings')).data?.settings.referral;
  const person = useLoad<{ id: string; name: string; mobile: string; city: string | null; inviteCode: string; flags: { status: string }[] } | null>(() => (id ? api.get(`/applicators/${id}`) : Promise.resolve(null)), [id]);
  useHead('Referral tree', 'Admin only · levels are never shown in the app');

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await api.get<{ rows: Row[] }>(`/applicators?limit=10&q=${encodeURIComponent(q.trim())}`);
      setResults(r.rows);
      if (r.rows.length === 1) {
        setParams({ id: r.rows[0]!.id });
        setResults(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="row g12" style={{ background: '#fff', border: '1.5px solid var(--primary-700)', borderRadius: 14, padding: '8px 8px 8px 16px' }} onSubmit={search}>
        <Search size={18} color="var(--text-secondary)" />
        <input className="grow" style={{ border: 0, outline: 0, fontSize: 15, fontWeight: 500, background: 'none' }} placeholder={person.data ? `${person.data.name} · ${spacedMobile(person.data.mobile)} · code ${person.data.inviteCode}` : 'Name, mobile or invite code (e.g. RAM245)'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find applicator" />
        <button className="btn primary" disabled={busy}>
          Show tree
        </button>
      </form>
      {results && (
        <div className="card col g4">
          {results.length === 0 && <p className="t-13 c-sec">No one found.</p>}
          {results.map((r) => (
            <button
              key={r.id}
              className="list-row"
              onClick={() => {
                setParams({ id: r.id });
                setResults(null);
                setQ('');
              }}
            >
              <span className="avatar">{initials(r.name)}</span>
              <span className="grow">
                <span className="t-13 w6" style={{ display: 'block' }}>
                  {r.name}
                </span>
                <span className="t-12 c-sec">
                  {spacedMobile(r.mobile)} · {r.inviteCode} · {r.city ?? ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {id ? <OneTree id={id} name={person.data?.name ?? '…'} openFlags={person.data?.flags.filter((f) => f.status === 'open').length ?? 0} rules={rules} /> : <Overview rules={rules} />}
    </>
  );
}

function OneTree({ id, name, openFlags, rules }: { id: string; name: string; openFlags: number; rules?: Referral }) {
  const tree = useTree(id);
  if (tree.error) return <ErrorBox error={tree.error} retry={tree.reload} />;
  if (!tree.data) return <div className="card"><Loading rows={5} /></div>;
  const s = treeStats(tree.data);
  const per = (lv: number) => tree.data!.levels.find((l) => l.level === lv)?.people.length ?? 0;
  return (
    <>
      <div className="grid grid-4 m2">
        <Mini icon={<UserPlus size={18} />} tone="tone-pri" v={s.l1} l="Joined with their code (L1)" sub={`${s.l1Scanning} scanning`} subClass="c-pri" />
        <Mini icon={<Users size={18} />} tone="tone-gift" v={s.total} l="Whole team (L1–L4)" sub={`L2 ${per(2)} · L3 ${per(3)} · L4 ${per(4)}`} subClass="c-info" />
        <Mini icon={<Coins size={18} />} tone="tone-ok" v={s.runs} l="Runs earned from team" sub={rules ? `Cap ${rules.monthlyCapRuns} runs/month` : ''} subClass="c-ok" />
        <Mini icon={<TriangleAlert size={18} />} tone="tone-bad" v={openFlags} l="Open flags on this person" sub="" subClass="c-bad" />
      </div>
      <div className="grid grid-main">
        <div className="card col g12">
          <div>
            <p className="t-card w7">Team tree</p>
            <p className="t-12 c-sec">Tap a person to open their profile</p>
          </div>
          <TreeList rootId={id} rootName={name} tree={tree.data} />
        </div>
        <div className="col g20">
          <div className="card col g12">
            <p className="t-card w7">Runs earned by level</p>
            <LevelTable tree={tree.data} />
          </div>
          <Rules rules={rules} />
        </div>
      </div>
    </>
  );
}

type Top = { id: string; name: string; mobile: string; city: string | null; inviteCode: string; joined: number; joinedScanning: number; runsEarned: number; runsThisMonth: number };
function Overview({ rules }: { rules?: Referral }) {
  const [, setParams] = useSearchParams();
  const { data, error, reload } = useLoad<{ rows: Top[]; monthlyCapRuns: number }>(() => api.get('/referrals/top?limit=50'));
  return (
    <div className="grid grid-main">
      <div className="card col g12">
        <p className="t-card w7">Top referrers</p>
        {error && <ErrorBox error={error} retry={reload} />}
        {!data && !error && <Loading rows={5} />}
        {data && data.rows.length === 0 && <Empty icon={<Users size={28} />} title="Nobody has joined with a code yet" sub="Search a person above to see their tree." />}
        {data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Applicator</th>
                  <th>Code</th>
                  <th>City</th>
                  <th className="num">Joined (L1)</th>
                  <th className="num">Runs earned</th>
                  <th>This month / cap</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const capped = r.runsThisMonth >= data.monthlyCapRuns;
                  return (
                    <tr key={r.id}>
                      <td data-l="Applicator">
                        <div className="person">
                          <span className="avatar">{initials(r.name)}</span>
                          <div>
                            <p className="w6">{r.name}</p>
                            <p className="t-12 c-sec">{spacedMobile(r.mobile)}</p>
                          </div>
                        </div>
                      </td>
                      <td data-l="Code" className="mono w6">
                        {r.inviteCode}
                      </td>
                      <td data-l="City">{r.city ?? '—'}</td>
                      <td data-l="Joined (L1)" className="num">
                        {n(r.joined)} <span className="t-12 c-sec">({n(r.joinedScanning)} scanning)</span>
                      </td>
                      <td data-l="Runs earned" className="num w6" style={{ color: 'var(--gift-text)' }}>
                        {n(r.runsEarned)}
                      </td>
                      <td data-l="This month / cap" className={capped ? 'c-warn w6' : 'c-sec'}>
                        {n(r.runsThisMonth)} / {n(data.monthlyCapRuns)}
                        {capped ? ' (cap)' : ''}
                      </td>
                      <td>
                        <button className="btn sm" onClick={() => setParams({ id: r.id })}>
                          <Users size={14} />
                          View tree
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="t-12 c-sec">Referral flags (same phone, fake joins) show up in Scans log → Flags as “accounts on one phone”.</p>
      </div>
      <Rules rules={rules} />
    </div>
  );
}

function Rules({ rules }: { rules?: Referral }) {
  return (
    <div className="card col g10">
      <div>
        <p className="t-card w7">Rules + caps</p>
        <p className="t-12 c-sec">Change in Settings → Referral</p>
      </div>
      {!rules ? (
        <Loading />
      ) : (
        <div className="kv" style={{ gridTemplateColumns: '70px 1fr' }}>
          <span>L1</span>
          <span>
            +{rules.firstCouponBonusRuns} runs on friend’s 1st coupon + {rules.levelSharePct}% of their scanned points
          </span>
          {[2, 3, 4].slice(0, Math.max(0, rules.levels - 1)).map((lv) => (
            <Fragment2 key={lv} a={`L${lv}`} b={`${rules.levelSharePct}% of points scanned by the person below${lv === rules.levels ? ' · tree stops here' : ''}`} />
          ))}
          <span>Cap</span>
          <span>{rules.monthlyCapRuns} runs / month (all referral runs)</span>
          <span>Safety</span>
          <span>No runs if same phone (self-invite)</span>
        </div>
      )}
      <Client>Cap 200 runs/month · CLIENT to confirm</Client>
    </div>
  );
}
const Fragment2 = ({ a, b }: { a: string; b: string }) => (
  <>
    <span>{a}</span>
    <span>{b}</span>
  </>
);

function Mini({ icon, tone, v, l, sub, subClass }: { icon: React.ReactNode; tone: string; v: number; l: string; sub: string; subClass: string }) {
  return (
    <div className="card mini">
      <span className={`kpi-icon ${tone}`}>{icon}</span>
      <div>
        <p className="t-num">{n(v)}</p>
        <p className="t-12 c-sec">{l}</p>
        {sub && <p className={`t-12 ${subClass}`}>{sub}</p>}
      </div>
    </div>
  );
}

