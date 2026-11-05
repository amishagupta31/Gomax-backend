import { useEffect, useMemo, useState } from 'react';
import { Check, Gift, Lock, Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { useStaff } from '../auth';
import { useHead } from '../Shell';
import { Client, ErrorBox, errMsg, Loading, n, Segmented, useLoad, useToast } from '../ui';

// D7a Spin wheel odds (21:12274) · D7b Scratch card rule (21:12542). Owners only.
// Odds live on the server (Settings → spinOdds / scratch); the app only shows the wheel.
// 100 runs is always 0% — the API rejects any odds for it.
type Odds = { runs: number; weight: number }[];
type Scratch = { couponsPerCard: number; expiryDays: number; prizes: { kind: 'runs' | 'points'; amount: number; weight: number }[] };
type S = { spinOdds: Odds; scratch: Scratch; ranks: { name: string; spins: number }[] };
const WHEEL = [5, 10, 20, 50, 100];

export default function Games() {
  const [tab, setTab] = useState<'spin' | 'scratch'>('spin');
  const { data, error, reload } = useLoad<{ settings: S }>(() => api.get('/settings'));
  useHead('Games & odds', tab === 'spin' ? 'Owner only · changes apply from the next spin' : 'Scratch card · CLIENT sample card awaited');
  return (
    <>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          ['spin', 'Spin wheel'],
          ['scratch', 'Scratch card'],
        ]}
      />
      {error && <ErrorBox error={error} retry={reload} />}
      {!data ? <div className="card"><Loading rows={6} /></div> : tab === 'spin' ? <Spin s={data.settings} onSaved={reload} /> : <ScratchRule s={data.settings} onSaved={reload} />}
    </>
  );
}

/** The 10-segment wheel from the design (5 · 10 · 20 · 10 · 20 · 5 · 50 · 10 · 5 · 100). */
function Wheel() {
  const segs = [5, 10, 20, 5, 50, 10, 5, 100, 10, 20];
  const colors: Record<number, string> = { 5: '#c05336', 10: '#0a1628', 20: '#1f4f8c', 50: '#e07a62', 100: '#001e42' };
  const R = 150;
  const arc = (i: number) => {
    const a0 = ((i * 36 - 90 - 18) * Math.PI) / 180;
    const a1 = (((i + 1) * 36 - 90 - 18) * Math.PI) / 180;
    return `M0 0 L${R * Math.cos(a0)} ${R * Math.sin(a0)} A${R} ${R} 0 0 1 ${R * Math.cos(a1)} ${R * Math.sin(a1)} Z`;
  };
  return (
    <svg viewBox="-160 -172 320 332" width="300" height="312" role="img" aria-label="Spin wheel with 5, 10, 20, 50 and 100 runs">
      {segs.map((v, i) => {
        const mid = ((i * 36 - 90) * Math.PI) / 180;
        return (
          <g key={i}>
            <path d={arc(i)} fill={colors[v]} stroke="#fff" strokeWidth="3" />
            <text x={R * 0.66 * Math.cos(mid)} y={R * 0.66 * Math.sin(mid) + 6} fill="#fff" fontSize="16" fontWeight="700" textAnchor="middle">
              {v}
            </text>
          </g>
        );
      })}
      <circle r="26" fill="#fff" />
      <text y="5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#c05336">
        SPIN
      </text>
      <rect x="-8" y="-170" width="16" height="26" rx="5" fill="#f5a524" />
    </svg>
  );
}

function Spin({ s, onSaved }: { s: S; onSaved: () => void }) {
  const staff = useStaff();
  const toast = useToast();
  const owner = staff.role === 'owner';
  const [pct, setPct] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<Record<number, number> | null>(null);
  useEffect(() => {
    const total = s.spinOdds.reduce((x, o) => x + o.weight, 0) || 1;
    setPct(Object.fromEntries(WHEEL.map((r) => [r, String(Math.round(((s.spinOdds.find((o) => o.runs === r)?.weight ?? 0) / total) * 1000) / 10)])));
  }, [s]);
  const vals = WHEEL.map((r) => ({ runs: r, p: r === 100 ? 0 : Number(pct[r]) || 0 }));
  const total = Math.round(vals.reduce((x, v) => x + v.p, 0) * 10) / 10;
  const avg = vals.reduce((x, v) => x + (v.runs * v.p) / 100, 0);
  const ok = total === 100;
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/settings/spinOdds', { value: vals.filter((v) => v.runs !== 100).map((v) => ({ runs: v.runs, weight: v.p })) });
      toast('Odds saved · saved in the Audit log');
      onSaved();
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };
  const simulate = () => {
    const out: Record<number, number> = {};
    for (let i = 0; i < 1000; i++) {
      let r = Math.random() * 100;
      const hit = vals.find((v) => (r -= v.p) < 0) ?? vals[0]!;
      out[hit.runs] = (out[hit.runs] ?? 0) + 1;
    }
    setTest(out);
  };

  return (
    <div className="grid grid-side">
      <div className="card col g12" style={{ alignItems: 'center' }}>
        <div style={{ alignSelf: 'stretch' }}>
          <p className="t-card w7">What the applicator sees</p>
          <p className="t-12 c-sec">Wheel shows all 5 numbers. Odds are hidden.</p>
        </div>
        <Wheel />
        <p className="t-12 c-sec" style={{ alignSelf: 'stretch' }}>
          Home → tap “Spin the wheel” → spin → result → back to Home.
        </p>
        <div className="note bad" style={{ alignSelf: 'stretch' }}>
          <Lock size={16} style={{ flex: 'none' }} />
          The server picks the result, not the phone. 100 is never given.
        </div>
      </div>
      <div className="card col g16">
        <div className="between">
          <div>
            <p className="t-card w7">Odds per segment</p>
            <p className="t-12 c-sec">Must add up to 100%</p>
          </div>
          <span className={`pill ${ok ? 'ok' : 'bad'}`}>
            Total {total}% {ok ? <Check size={13} /> : ''}
          </span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Segment</th>
                <th>Chance</th>
                <th className="d-only" style={{ width: '30%' }} />
                <th className="num">Avg runs / spin</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {vals.map((v) => (
                <tr key={v.runs} style={v.runs === 100 ? { background: 'var(--danger-50)' } : undefined}>
                  <td className="w6">{v.runs} runs</td>
                  <td>
                    <div className="row g4">
                      <input
                        className="input"
                        style={{ width: 80 }}
                        inputMode="decimal"
                        aria-label={`Chance for ${v.runs} runs`}
                        disabled={!owner || v.runs === 100}
                        value={v.runs === 100 ? '0' : (pct[v.runs] ?? '')}
                        onChange={(e) => setPct({ ...pct, [v.runs]: e.target.value.replace(/[^\d.]/g, '') })}
                      />
                      <span className="c-muted">%</span>
                    </div>
                  </td>
                  <td className="d-only">
                    <div className="progress">
                      <i style={{ width: `${Math.min(100, v.p)}%` }} />
                    </div>
                  </td>
                  <td className="num">{((v.runs * v.p) / 100).toFixed(2)}</td>
                  <td>
                    {v.runs === 100 ? (
                      <span className="row g4 c-bad t-12 w5">
                        <Lock size={13} />
                        Never · locked
                      </span>
                    ) : v.p === 0 ? (
                      <span className="pill">
                        <Lock size={12} />
                        Off
                      </span>
                    ) : (
                      <span className="t-12 c-sec">{test ? `${test[v.runs] ?? 0} of 1,000 in test` : ''}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid grid-3" style={{ gap: 12 }}>
          <Stat label="Average per spin" value={`${avg.toFixed(2)} runs`} />
          <Stat label="Free spins per day (by rank)" value={s.ranks.map((r) => r.spins).join(' / ')} />
          <Stat label="Spins per rank" value={s.ranks.map((r) => `${r.name} ${r.spins}`).join(' · ')} />
        </div>
        <div className="row g10 wrap">
          {owner && (
            <button className="btn primary" disabled={!ok || busy} onClick={save}>
              <Check size={16} />
              Save odds
            </button>
          )}
          <button className="btn" onClick={simulate} disabled={!ok}>
            <Sparkles size={16} />
            Test 1,000 spins
          </button>
          <span className="t-12 c-muted">Saved in the Audit log. Spins per rank are changed in Settings → Ranks.</span>
        </div>
        <Client>CLIENT to confirm the final odds table (5 and 10 mostly)</Client>
      </div>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: '12px 14px' }}>
    <p className="t-12 c-sec">{label}</p>
    <p className="t-13 w6">{value}</p>
  </div>
);

function ScratchRule({ s, onSaved }: { s: S; onSaved: () => void }) {
  const staff = useStaff();
  const toast = useToast();
  const owner = staff.role === 'owner';
  const [per, setPer] = useState(String(s.scratch.couponsPerCard));
  const [days, setDays] = useState(String(s.scratch.expiryDays));
  const [prizes, setPrizes] = useState(s.scratch.prizes.map((p) => ({ ...p, weight: String(p.weight) })));
  const [busy, setBusy] = useState(false);
  const total = useMemo(() => prizes.reduce((x, p) => x + (Number(p.weight) || 0), 0), [prizes]);
  const avg = prizes.reduce((x, p) => x + (p.amount * (Number(p.weight) || 0)) / (total || 1), 0);
  const valid = Number(per) > 0 && Number(days) > 0 && prizes.length > 0 && prizes.every((p) => p.amount > 0) && total > 0;
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/settings/scratch', { value: { couponsPerCard: Number(per), expiryDays: Number(days), prizes: prizes.map((p) => ({ kind: p.kind, amount: p.amount, weight: Number(p.weight) || 0 })) } });
      toast('Scratch card rule saved');
      onSaved();
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="row g16" style={{ background: 'var(--navy-900)', color: '#fff', borderRadius: 16, padding: '24px 28px' }}>
        <Gift size={40} color="#f5a524" />
        <div className="grow">
          <p className="t-title w7" style={{ fontSize: 22, lineHeight: '28px' }}>
            {per || '?'} coupons in a day = 1 scratch card
          </p>
          <p className="t-13" style={{ color: 'var(--side-text)' }}>
            Day = 12:00 am to 12:00 am (India time). Count resets at midnight. Max 1 card a day.
          </p>
        </div>
        <span className="pill ok">
          <Check size={13} />
          Live
        </span>
      </div>
      <div className="grid grid-2">
        <div className="card col g16">
          <p className="t-card w7">Rule settings</p>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="per">Coupons needed in a day</label>
              <input id="per" className="input" inputMode="numeric" disabled={!owner} value={per} onChange={(e) => setPer(e.target.value.replace(/\D/g, ''))} />
            </div>
            <div className="field">
              <span className="label">Max cards per day</span>
              <input className="input" value="1 (fixed)" disabled />
            </div>
            <div className="field">
              <span className="label">Day starts at</span>
              <input className="input" value="12:00 am IST" disabled />
            </div>
            <div className="field">
              <label htmlFor="exp">Card expires after (days, if not scratched)</label>
              <input id="exp" className="input" inputMode="numeric" disabled={!owner} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
            </div>
          </div>
          <p className="caps">Prizes inside a card</p>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Prize</th>
                  <th>Weight</th>
                  <th className="num">Chance</th>
                  <th className="num">Avg cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {prizes.map((p, i) => {
                  const ch = total ? (Number(p.weight) || 0) / total : 0;
                  return (
                    <tr key={i}>
                      <td>
                        <div className="row g4">
                          <input
                            className="input"
                            style={{ width: 70 }}
                            inputMode="numeric"
                            disabled={!owner}
                            aria-label="Prize amount"
                            value={p.amount}
                            onChange={(e) => setPrizes(prizes.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value.replace(/\D/g, '')) } : x)))}
                          />
                          <select className="select" disabled={!owner} value={p.kind} aria-label="Prize kind" onChange={(e) => setPrizes(prizes.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'runs' | 'points' } : x)))}>
                            <option value="runs">runs</option>
                            <option value="points">points</option>
                          </select>
                        </div>
                      </td>
                      <td>
                        <input className="input" style={{ width: 70 }} inputMode="decimal" disabled={!owner} aria-label="Weight" value={p.weight} onChange={(e) => setPrizes(prizes.map((x, j) => (j === i ? { ...x, weight: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
                      </td>
                      <td className="num">{Math.round(ch * 1000) / 10}%</td>
                      <td className="num">{(p.amount * ch).toFixed(2)}</td>
                      <td>
                        {owner && prizes.length > 1 && (
                          <button className="btn ghost sm" aria-label="Remove prize" onClick={() => setPrizes(prizes.filter((_, j) => j !== i))}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="w7">Total</td>
                  <td />
                  <td className="num w7">100%</td>
                  <td className="num w7">{avg.toFixed(2)} / card</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          {owner && (
            <div className="row g10">
              <button className="btn" onClick={() => setPrizes([...prizes, { kind: 'runs', amount: 10, weight: '0' }])}>
                <Plus size={16} />
                Add prize
              </button>
              <button className="btn primary" disabled={!valid || busy} onClick={save}>
                <Check size={16} />
                Save rule
              </button>
            </div>
          )}
        </div>
        <div className="col g20">
          <div className="card col g12">
            <div>
              <p className="t-card w7">In the app</p>
              <p className="t-12 c-sec">Home shows progress; the card opens after the {per}th coupon</p>
            </div>
            <div className="card col g6">
              <p className="t-13 w6">Scratch card</p>
              <p className="t-12 c-sec">
                7 of {per} coupons today
              </p>
              <div className="progress">
                <i style={{ width: `${Math.min(100, (7 / (Number(per) || 10)) * 100)}%` }} />
              </div>
              <p className="t-12 c-pri">{Math.max(0, (Number(per) || 10) - 7)} more coupons for a card</p>
            </div>
          </div>
          <div className="note warn" style={{ fontSize: 13, lineHeight: '18px' }}>
            <TriangleAlert size={16} style={{ flex: 'none' }} />
            CLIENT to send: sample scratch card design + final prize list.
          </div>
          <div className="card">
            <p className="t-card w7">Today</p>
            <p className="t-12 c-sec mt8">Cards given / scratched today: not connected yet (needs a games-stats endpoint). Average {n(Math.round(avg * 100) / 100)} per card.</p>
          </div>
        </div>
      </div>
    </>
  );
}
