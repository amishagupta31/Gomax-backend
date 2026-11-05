import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Award, Download, HardHat, Search } from 'lucide-react';
import { api } from '../api';
import { rankTone } from '../labels';
import { useHead } from '../Shell';
import { ago, date, Empty, ErrorBox, errMsg, initials, Loading, n, spacedMobile, useLoad, useToast } from '../ui';
import { useStaff } from '../auth';
import { rememberApplicator } from './Mobile';

// D9b Applicators & KYC / PAN (21:15164) — list; the profile is ApplicatorProfile (D9b panel + M5).
export type Row = { id: string; name: string; mobile: string; city: string | null; inviteCode: string; points: number; runs: number; lifetimePoints: number; status: 'active' | 'blocked'; cashHold: boolean; createdAt: string; panAdded?: boolean; upiAdded?: boolean; upiMatchesPan?: boolean | null };
export type Rank = { id: string; name: string; min: number };
type Filter = 'all' | 'active' | 'kyc' | 'no_pan' | 'blocked' | 'hold' | 'callbacks';

export const rankFor = (lifetime: number, ranks: Rank[]) => [...ranks].sort((a, b) => b.min - a.min).find((r) => lifetime >= r.min) ?? ranks[0];

export function useRanks() {
  return useLoad<{ settings: { ranks: Rank[]; withdraw: { minPoints: number } } }>(() => api.get('/settings')).data?.settings;
}

export default function Applicators() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [filter, setFilter] = useState<Filter>(((params.get('view') as Filter) || 'all'));
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const s = useRanks();
  const me = useStaff();
  const helpdesk = me.role === 'owner' || me.role === 'helpline';
  const { data, error, loading, reload } = useLoad<{ rows: Row[]; nextCursor: string | null }>(() => api.get(`/applicators?limit=50&view=${filter === 'callbacks' ? 'all' : filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q, filter]);
  useEffect(() => {
    if (data) {
      setRows(data.rows);
      setCursor(data.nextCursor);
    }
  }, [data]);
  useEffect(() => setText(q), [q]);
  useHead('Applicators', 'Every applicator: profile, rank, points, runs, PAN / UPI check (KYC)');

  const more = async () => {
    const r = await api.get<{ rows: Row[]; nextCursor: string | null }>(`/applicators?limit=50&view=${filter}&cursor=${encodeURIComponent(cursor!)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    setRows((x) => [...x, ...r.rows]);
    setCursor(r.nextCursor);
  };
  const minPts = s?.withdraw.minPoints ?? 500;
  const shown = rows;
  const exportCsv = () => {
    const head = 'name,mobile,city,code,points,runs,lifetime_points,status,cash_hold,joined';
    const lines = shown.map((r) => [r.name, r.mobile, r.city ?? '', r.inviteCode, r.points, r.runs, r.lifetimePoints, r.status, r.cashHold, r.createdAt].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'applicators.csv' }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="between wrap">
        <div className="segmented" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {(
            [
              ['all', 'All'],
              ['active', 'Active'],
              ['kyc', 'KYC to check'],
              ['no_pan', 'No PAN'],
              ['hold', 'Cash on hold'],
              ['blocked', 'Blocked'],
              ...(helpdesk ? ([['callbacks', 'Call-back requests']] as [Filter, string][]) : []),
            ] as [Filter, string][]
          ).map(([f, l]) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {l}
            </button>
          ))}
        </div>
        <div className="row g10 wrap">
          <form
            className="row g6"
            onSubmit={(e) => {
              e.preventDefault();
              setParams(text.trim() ? { q: text.trim() } : {});
            }}
          >
            <input className="input" style={{ width: 260 }} placeholder="Name, mobile or invite code" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search applicators" />
            <button className="btn">
              <Search size={16} />
              Search
            </button>
          </form>
          <button className="btn" onClick={exportCsv} disabled={!shown.length}>
            <Download size={16} />
            Export
          </button>
        </div>
      </div>
      {filter === 'kyc' && <p className="t-13 c-sec">PAN added but no UPI yet — usually the UPI name did not match the PAN and the app sent them to the helpline. Open a person and use “Mark KYC ok” after checking.</p>}
      {filter === 'callbacks' && <Callbacks />}
      {error && <ErrorBox error={error} retry={reload} />}
      {filter !== 'callbacks' && (
      <div className="card flush">
        {loading && !rows.length ? (
          <div style={{ padding: 20 }}>
            <Loading rows={6} />
          </div>
        ) : shown.length === 0 ? (
          <Empty icon={<HardHat size={28} />} title={q ? `No one matches “${q}”` : 'No applicators here'} />
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="tbl cards">
              <thead>
                <tr>
                  <th>Applicator</th>
                  <th>City</th>
                  <th>Rank</th>
                  <th>Points</th>
                  <th>Runs</th>
                  <th>PAN</th>
                  <th>UPI</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const rank = s ? rankFor(r.lifetimePoints, s.ranks) : null;
                  return (
                    <tr key={r.id} className="click" onClick={() => (rememberApplicator(r), nav(`/applicators/${r.id}`))}>
                      <td data-l="Applicator">
                        <div className="person">
                          <span className="avatar">{initials(r.name)}</span>
                          <div>
                            <p className="w6">{r.name}</p>
                            <p className="t-12 c-sec">{spacedMobile(r.mobile)}</p>
                          </div>
                        </div>
                      </td>
                      <td data-l="City">{r.city ?? '—'}</td>
                      <td data-l="Rank">
                        {rank && (
                          <span className={`pill ${rankTone(rank.id)}`}>
                            <Award size={13} />
                            {rank.name}
                          </span>
                        )}
                      </td>
                      <td data-l="Points" className={`w6 ${r.points >= minPts ? 'c-ok' : 'c-pri'}`}>
                        {n(r.points)} pt
                      </td>
                      <td data-l="Runs" style={{ color: 'var(--gift-text)' }}>
                        {n(r.runs)} runs
                      </td>
                      <td data-l="PAN">{r.panAdded ? <span className="pill ok">PAN ok</span> : <span className="pill">— No PAN</span>}</td>
                      <td data-l="UPI">{r.upiAdded ? <span className="pill ok">UPI ok</span> : r.panAdded ? <span className="pill warn">UPI missing</span> : <span className="pill">—</span>}</td>
                      <td data-l="Status">
                        {r.status === 'blocked' ? <span className="pill bad">Blocked</span> : r.cashHold ? <span className="pill warn">Cash on hold</span> : <span className="pill ok">Active</span>}
                      </td>
                      <td data-l="Joined" className="c-sec">
                        {date(r.createdAt)}
                      </td>
                      <td>
                        <button className="btn sm">Open</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
      {cursor && filter !== 'callbacks' && (
        <button className="btn" style={{ alignSelf: 'center' }} onClick={more}>
          Show more
        </button>
      )}
    </>
  );
}

/** A1-15/16: applicators who asked the helpline to call back (forgot password). */
function Callbacks() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad<{ rows: { id: number; mobile: string; name: string | null; userId: string | null; createdAt: string }[] }>(() => api.get('/helpline-requests'));
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (loading && !data) return <div className="card"><Loading /></div>;
  if (!data?.rows.length) return <div className="card"><Empty title="No call-back requests" sub="Requests from the app’s “Forgot password → call me” screen appear here." /></div>;
  return (
    <div className="card" style={{ padding: '4px 20px' }}>
      {data.rows.map((r) => (
        <div key={r.id} className="list-row">
          <span className="avatar">{initials(r.name ?? '?')}</span>
          <div className="grow">
            <p className="t-13 w6">{r.name ?? 'Not registered'}</p>
            <p className="t-12 c-sec">
              {spacedMobile(r.mobile)} · asked {ago(r.createdAt)}
            </p>
          </div>
          <a className="btn sm" href={`tel:+91${r.mobile}`}>
            Call
          </a>
          {r.userId && (
            <a className="btn sm" href={`/applicators/${r.userId}`}>
              Open
            </a>
          )}
          <button
            className="btn sm primary"
            onClick={() =>
              api
                .post(`/helpline-requests/${r.id}/done`)
                .then(() => (toast('Marked done'), reload()))
                .catch((e) => toast(errMsg(e), true))
            }
          >
            Done
          </button>
        </div>
      ))}
    </div>
  );
}
