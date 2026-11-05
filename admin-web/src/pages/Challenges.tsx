import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowLeft, Camera, Check, Coins, Info, MapPin, Pencil, Plus, ScanLine, Sparkles, Star, UserPlus, X } from 'lucide-react';
import { api, viewable } from '../api';
import { useStaff } from '../auth';
import { useCounts, useHead } from '../Shell';
import { date, dateTime, Empty, ErrorBox, errMsg, initials, Loading, n, ReasonDialog, Toggle, useLoad, useToast } from '../ui';

// D7c Challenges list (21:12770) · D7d Challenge builder (21:13015) · D7e Streak photo review (21:13222).
type Kind = 'scan_count' | 'ultra_scan_count' | 'invite_count' | 'streak_days';
type Milestone = { at: number; title: string; sub?: string; scratchCards?: number };
type Challenge = {
  id: string;
  kind: Kind;
  period: 'week' | 'range';
  tag: string;
  tone: string;
  title: string;
  shortTitle: string;
  goal: number;
  rewardRuns: number;
  rewardScratchCards: number;
  bonusText: string | null;
  art: string;
  milestones: Milestone[];
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  sort: number;
};
type Photo = { id: string; day: string; takenAt: string; lat: number | null; lng: number | null; status: string; reason: string | null; name: string; mobile: string; url: string };
type Tab = 'live' | 'scheduled' | 'ended' | 'photos';

const TYPES: { key: string; kind: Kind; label: string; icon: typeof ScanLine; period: 'week' | 'range' }[] = [
  { key: 'scan', kind: 'scan_count', label: 'Scan coupons', icon: ScanLine, period: 'week' },
  { key: 'ultra', kind: 'ultra_scan_count', label: 'Coupon value', icon: Star, period: 'range' },
  { key: 'streak', kind: 'streak_days', label: 'Daily photo streak', icon: Camera, period: 'range' },
  { key: 'invite', kind: 'invite_count', label: 'Invite friends', icon: UserPlus, period: 'range' },
  { key: 'festival', kind: 'scan_count', label: 'Festival', icon: Sparkles, period: 'range' },
];
const iconFor = (c: Challenge) => (c.kind === 'streak_days' ? Camera : c.kind === 'invite_count' ? UserPlus : c.kind === 'ultra_scan_count' ? Star : c.period === 'range' && c.tag.toLowerCase().includes('fest') ? Sparkles : ScanLine);
const stateOf = (c: Challenge, now = Date.now()): 'live' | 'scheduled' | 'ended' => {
  if (c.endsAt && new Date(c.endsAt).getTime() < now) return 'ended';
  if (!c.active) return 'ended';
  if (c.startsAt && new Date(c.startsAt).getTime() > now) return 'scheduled';
  return 'live';
};
const goalText = (c: Challenge) => (c.kind === 'streak_days' ? (c.milestones.length ? `${c.milestones.map((m) => m.at).join(' / ')} days` : `${c.goal} days`) : c.kind === 'invite_count' ? `${c.goal} friends` : c.kind === 'ultra_scan_count' ? `${c.goal} × Ultra coupons` : `${c.goal} coupons`);

export default function Challenges() {
  const [params, setParams] = useSearchParams();
  const staff = useStaff();
  const { counts } = useCounts();
  const canList = staff.role === 'owner' || staff.role === 'helpline' || staff.role === 'ops';
  const canPhotos = staff.role === 'owner' || staff.role === 'ops';
  const tab = (params.get('tab') as Tab) || (canList && staff.role !== 'ops' ? 'live' : 'photos');
  const [editing, setEditing] = useState<Challenge | 'new' | null>(null);
  const list = useLoad<{ challenges: Challenge[] }>(() => (staff.role === 'ops' ? Promise.resolve({ challenges: [] }) : api.get('/challenges')));
  const all = list.data?.challenges ?? [];
  const count = (t: Tab) => all.filter((c) => stateOf(c) === t).length;
  useHead(editing ? (editing === 'new' ? 'New challenge' : 'Edit challenge') : 'Challenges', editing ? `Challenges › ${editing === 'new' ? 'New' : editing.title}` : tab === 'photos' ? `${counts?.photos ?? 0} photos to check` : `${count('live')} live`);

  if (editing) return <Builder c={editing === 'new' ? null : editing} onDone={() => (setEditing(null), list.reload())} />;
  return (
    <>
      <div className="between wrap">
        <div className="segmented" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {staff.role !== 'ops' &&
            (
              [
                ['live', 'Live'],
                ['scheduled', 'Scheduled'],
                ['ended', 'Ended'],
              ] as [Tab, string][]
            ).map(([t, l]) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setParams({ tab: t })}>
                {l} <span className="count">{count(t)}</span>
              </button>
            ))}
          {canPhotos && (
            <button className={tab === 'photos' ? 'on' : ''} onClick={() => setParams({ tab: 'photos' })}>
              Photo review <span className="count">{counts?.photos ?? 0}</span>
            </button>
          )}
        </div>
        {staff.role === 'owner' && tab !== 'photos' && (
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus size={16} />
            New challenge
          </button>
        )}
      </div>
      {tab === 'photos' ? (
        <PhotoReview />
      ) : (
        <>
          {list.error && <ErrorBox error={list.error} retry={list.reload} />}
          {list.loading && !list.data && (
            <div className="card">
              <Loading />
            </div>
          )}
          {list.data && all.filter((c) => stateOf(c) === tab).length === 0 && (
            <div className="card">
              <Empty title={`No ${tab} challenges`} sub="4–5 live at a time works best." />
            </div>
          )}
          {all
            .filter((c) => stateOf(c) === tab)
            .map((c) => (
              <ChallengeRow key={c.id} c={c} owner={staff.role === 'owner'} onEdit={() => setEditing(c)} onChanged={list.reload} />
            ))}
          <div className="note" style={{ fontSize: 13, lineHeight: '18px', color: 'var(--navy-brand)', padding: '14px 18px' }}>
            <Info size={18} style={{ flex: 'none' }} />
            How applicators reach a challenge: Home → “This week’s challenge” card · Challenges tab · WhatsApp on start. Streak shows lightly on Home (day count).
          </div>
        </>
      )}
    </>
  );
}

function ChallengeRow({ c, owner, onEdit, onChanged }: { c: Challenge; owner: boolean; onEdit: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [active, setActive] = useState(c.active);
  const Icon = iconFor(c);
  return (
    <div className="card row g16 wrap">
      <span className="kpi-icon tone-pri" style={{ width: 44, height: 44, borderRadius: 12 }}>
        <Icon size={20} />
      </span>
      <div className="grow" style={{ minWidth: 200 }}>
        <p className="t-card w6">{c.title}</p>
        <p className="t-12 c-sec">
          {c.tag} · {c.period === 'week' ? 'weekly · resets Monday 12 am' : 'one time'}
        </p>
      </div>
      <div style={{ minWidth: 130 }}>
        <p className="t-12 c-muted">Goal</p>
        <p className="t-13 w6">{goalText(c)}</p>
      </div>
      <div style={{ minWidth: 130 }}>
        <p className="t-12 c-muted">Reward</p>
        <span className="pill" style={{ background: '#e8f4f7', color: 'var(--gift-text)' }}>
          <Coins size={13} />
          {n(c.rewardRuns)} runs{c.rewardScratchCards ? ` + ${c.rewardScratchCards} card` : ''}
        </span>
      </div>
      <div style={{ minWidth: 140 }}>
        <p className="t-12 c-muted">Dates</p>
        <p className="t-13">{c.period === 'week' ? 'Every week' : c.startsAt || c.endsAt ? `${c.startsAt ? date(c.startsAt) : 'Now'} – ${c.endsAt ? date(c.endsAt) : 'no end'}` : 'Always on'}</p>
      </div>
      <Toggle
        on={active}
        disabled={!owner}
        label={`${c.title} live`}
        onChange={async (v) => {
          setActive(v);
          try {
            await api.patch(`/challenges/${c.id}`, { active: v });
            toast(v ? 'Challenge is live' : 'Challenge stopped');
            onChanged();
          } catch (e) {
            setActive(!v);
            toast(errMsg(e), true);
          }
        }}
      />
      {owner && (
        <button className="btn ghost sm" aria-label={`Edit ${c.title}`} onClick={onEdit}>
          <Pencil size={16} />
        </button>
      )}
    </div>
  );
}

// ── D7d builder ──
function Builder({ c, onDone }: { c: Challenge | null; onDone: () => void }) {
  const toast = useToast();
  const start = c ? (TYPES.find((t) => t.kind === c.kind && (c.kind !== 'scan_count' || (c.period === 'range') === (t.key === 'festival'))) ?? TYPES[0]!) : TYPES[0]!;
  const [type, setType] = useState(start);
  const [title, setTitle] = useState(c?.title ?? '');
  const [short, setShort] = useState(c?.shortTitle ?? '');
  const [tag, setTag] = useState(c?.tag ?? 'This week');
  const [goal, setGoal] = useState(String(c?.goal ?? 20));
  const [reward, setReward] = useState(String(c?.rewardRuns ?? 150));
  const [cards, setCards] = useState(String(c?.rewardScratchCards ?? 0));
  const [startsAt, setStartsAt] = useState(c?.startsAt?.slice(0, 10) ?? '');
  const [endsAt, setEndsAt] = useState(c?.endsAt?.slice(0, 10) ?? '');
  const [streak, setStreak] = useState<{ days: number; runs: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStreak = type.kind === 'streak_days';
  useEffect(() => {
    if (isStreak && !streak)
      api
        .get<{ settings: { streak: { rewards: { days: number; runs: number }[] } } }>('/settings')
        .then((r) => setStreak(r.settings.streak.rewards))
        .catch(() => setStreak([]));
  }, [isStreak, streak]);
  const id = (c?.id ?? (title || type.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 40);
  const period = type.key === 'scan' ? 'week' : 'range';
  const valid = title.trim().length >= 3 && (short.trim() || title.trim()).length >= 3 && Number(goal) > 0 && id.length >= 2 && (!endsAt || !startsAt || endsAt >= startsAt);

  const save = async (active: boolean) => {
    setBusy(true);
    setError(null);
    const body = {
      kind: type.kind,
      period,
      tag: tag.trim() || type.label,
      title: title.trim(),
      shortTitle: (short.trim() || title.trim()).slice(0, 40),
      goal: Number(goal),
      rewardRuns: Number(reward) || 0,
      rewardScratchCards: Number(cards) || 0,
      art: type.key === 'streak' ? 'fire' : type.key === 'invite' ? 'handshake' : type.key === 'festival' ? 'sparkles' : 'bullseye',
      startsAt: startsAt ? new Date(`${startsAt}T00:00:00+05:30`).toISOString() : null,
      endsAt: endsAt ? new Date(`${endsAt}T23:59:59+05:30`).toISOString() : null,
      active,
    };
    try {
      if (c) await api.patch(`/challenges/${c.id}`, body);
      else await api.post('/challenges', { id, ...body });
      if (isStreak && streak) await api.put('/settings/streak', { value: { rewards: streak.filter((s) => s.days > 0) } });
      toast(active ? 'Saved and live' : 'Saved as draft (not live)');
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onDone}>
        <ArrowLeft size={16} />
        Challenges
      </button>
      <div className="grid grid-main">
        <div className="card col g16" style={{ padding: 24 }}>
          <p className="label">Challenge type</p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
            {TYPES.map((t) => (
              <button
                key={t.key}
                disabled={!!c}
                className="card col g6"
                style={{ alignItems: 'center', padding: '14px 8px', borderColor: type.key === t.key ? 'var(--primary-700)' : undefined, borderWidth: type.key === t.key ? 1.5 : 1, background: type.key === t.key ? 'var(--primary-50)' : undefined, color: type.key === t.key ? 'var(--primary-700)' : undefined }}
                onClick={() => setType(t)}
              >
                <t.icon size={18} />
                <span className="t-13 w5">{t.label}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="ct">Name (English)</label>
              <input id="ct" className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Scan 20 coupons this week" />
              {!c && id && <p className="hint">ID: {id}</p>}
            </div>
            <div className="field">
              <label htmlFor="cs">Short name (cards)</label>
              <input id="cs" className="input" value={short} maxLength={40} onChange={(e) => setShort(e.target.value)} placeholder="Scan 20 coupons" />
            </div>
            <div className="field">
              <label htmlFor="ctag">Tag shown on the card</label>
              <input id="ctag" className="input" value={tag} maxLength={30} onChange={(e) => setTag(e.target.value)} />
            </div>
            <div className="field">
              <span className="label">Name (Hindi / Punjabi)</span>
              <input className="input" disabled value="Not connected yet — one language per challenge in the API" />
            </div>
          </div>
          {isStreak ? (
            <>
              <p className="caps">Milestones + reward (runs) · editable</p>
              {!streak ? (
                <Loading rows={1} />
              ) : (
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
                  {streak.map((m, i) => (
                    <div key={i} className="col g6" style={{ background: 'var(--surface-muted)', borderRadius: 12, padding: 12 }}>
                      <input className="input" inputMode="numeric" aria-label="Days" value={m.days || ''} onChange={(e) => setStreak(streak.map((x, j) => (j === i ? { ...x, days: Number(e.target.value.replace(/\D/g, '')) } : x)))} />
                      <span className="t-12 c-sec">days →</span>
                      <input className="input" inputMode="numeric" aria-label="Runs" value={m.runs} onChange={(e) => setStreak(streak.map((x, j) => (j === i ? { ...x, runs: Number(e.target.value.replace(/\D/g, '')) } : x)))} />
                      <span className="t-12 c-sec">runs</span>
                    </div>
                  ))}
                  <button className="btn" style={{ height: 'auto' }} onClick={() => setStreak([...streak, { days: 0, runs: 0 }])}>
                    <Plus size={16} />
                    Add
                  </button>
                </div>
              )}
              <p className="caps">Photo rules</p>
              {['Camera only (no gallery)', 'Time + GPS stamp on photo', 'Must be a work photo (office checks)', 'Miss 1 day = streak starts again'].map((r) => (
                <p key={r} className="row g10 t-13">
                  <Toggle on disabled label={r} />
                  {r}
                </p>
              ))}
              <div className="field" style={{ maxWidth: 200 }}>
                <label htmlFor="cg">Days for the card goal</label>
                <input id="cg" className="input" inputMode="numeric" value={goal} onChange={(e) => setGoal(e.target.value.replace(/\D/g, ''))} />
              </div>
            </>
          ) : (
            <div className="grid grid-3" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="cg2">Goal ({type.kind === 'invite_count' ? 'friends' : 'coupons'})</label>
                <input id="cg2" className="input" inputMode="numeric" value={goal} onChange={(e) => setGoal(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className="field">
                <label htmlFor="cr">Reward runs</label>
                <input id="cr" className="input" inputMode="numeric" value={reward} onChange={(e) => setReward(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className="field">
                <label htmlFor="cc">+ scratch cards (0–5)</label>
                <input id="cc" className="input" inputMode="numeric" value={cards} onChange={(e) => setCards(e.target.value.replace(/\D/g, '').slice(0, 1))} />
              </div>
            </div>
          )}
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="sa">Starts</label>
              <input id="sa" className="input" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              <p className="hint">{period === 'week' ? 'Weekly: resets every Monday 12 am.' : 'Empty = always on.'}</p>
            </div>
            <div className="field">
              <label htmlFor="ea">Ends</label>
              <input id="ea" className="input" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
          {error && <ErrorBox error={error} />}
          <div className="row g10 wrap">
            <button className="btn primary" disabled={!valid || busy} onClick={() => save(true)}>
              <Check size={16} />
              Save + go live
            </button>
            <button className="btn" disabled={!valid || busy} onClick={() => save(false)}>
              Save draft
            </button>
            {c?.active && (
              <button className="btn danger" style={{ background: 'var(--danger-50)', borderColor: 'var(--danger-50)' }} disabled={busy} onClick={() => save(false)}>
                End challenge
              </button>
            )}
          </div>
        </div>
        <div className="card col g12" style={{ alignSelf: 'start' }}>
          <p className="t-card w7">Preview in the app</p>
          <div className="col g10" style={{ border: '3px solid var(--navy-900)', borderRadius: 18, padding: 16, background: 'var(--primary-50)' }}>
            <p className="t-13 w6">Challenges</p>
            <div className="card col g6">
              <p className="t-13 w6">{short || title || 'Challenge name'}</p>
              <p className="t-12 c-sec">{isStreak ? `Day 12 of ${goal || '?'}` : `7 of ${goal || '?'}`}</p>
              <div className="progress">
                <i style={{ width: '60%' }} />
              </div>
              <p className="t-12 c-pri">{isStreak ? `3 more days → +${streak?.[0]?.runs ?? 0} runs` : `${Math.max(0, Number(goal) - 7)} more → +${reward || 0} runs`}</p>
            </div>
          </div>
          <p className="t-12 c-sec">Home shows a small card; the full card lives in Challenges.</p>
        </div>
      </div>
    </>
  );
}

// ── D7e ──
function PhotoReview() {
  const toast = useToast();
  const { refresh } = useCounts();
  const { data, error, loading, reload, setData } = useLoad<{ rows: Photo[] }>(() => api.get('/streak-photos?status=pending'));
  const [rejecting, setRejecting] = useState<Photo | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = data?.rows ?? [];
  const decide = async (p: Photo, decision: 'approved' | 'rejected', reason?: string) => {
    await api.post(`/streak-photos/${p.id}/review`, { decision, reason });
    setData({ rows: rows.filter((r) => r.id !== p.id) });
    refresh();
  };
  return (
    <>
      <div className="between wrap">
        <p className="t-13 c-sec">{rows.length} photos waiting · oldest first</p>
        <button
          className="btn"
          style={{ background: 'var(--success-50)', borderColor: 'var(--success-50)', color: 'var(--success-text)' }}
          disabled={!rows.length || busy}
          onClick={async () => {
            setBusy(true);
            let ok = 0;
            for (const p of rows) {
              try {
                await api.post(`/streak-photos/${p.id}/review`, { decision: 'approved' });
                ok++;
              } catch {
                /* left in the list */
              }
            }
            setBusy(false);
            toast(`${ok} photos approved`);
            reload();
            refresh();
          }}
        >
          <Check size={16} />
          Approve all ({rows.length})
        </button>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      {loading && !data && (
        <div className="card">
          <Loading />
        </div>
      )}
      {data && rows.length === 0 && (
        <div className="card">
          <Empty icon={<Camera size={28} />} title="No photos to check" sub="New daily work photos appear here." />
        </div>
      )}
      <div className="grid grid-4 m2">
        {rows.map((p) => {
          const url = viewable(p.url);
          return (
            <div key={p.id} className="card flush">
              <div className="photo" style={{ height: 170, borderRadius: 0, position: 'relative', backgroundImage: url ? `url(${url})` : 'linear-gradient(135deg,#b08a6a,#d9bfa0)' }}>
                {!url && <Camera size={28} color="#fff" />}
                <span className="pill" style={{ position: 'absolute', left: 10, bottom: 10, background: 'rgba(10,22,40,0.75)', color: '#fff' }}>
                  {dateTime(p.takenAt)}
                </span>
              </div>
              <div className="col g10" style={{ padding: 12 }}>
                <div className="person">
                  <span className="avatar sm">{initials(p.name)}</span>
                  <div className="grow">
                    <p className="t-13 w6">{p.name}</p>
                    <p className="t-12 c-sec">Day {date(p.day)}</p>
                  </div>
                </div>
                {p.lat != null && p.lng != null ? (
                  <a className="pill ok" style={{ alignSelf: 'flex-start' }} href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">
                    <MapPin size={13} />
                    Camera · GPS ok
                  </a>
                ) : (
                  <span className="pill warn" style={{ alignSelf: 'flex-start' }}>
                    No GPS
                  </span>
                )}
                <div className="row g6">
                  <button
                    className="btn sm grow"
                    style={{ background: 'var(--success-50)', borderColor: 'var(--success-50)', color: 'var(--success-text)' }}
                    onClick={() => decide(p, 'approved').catch((e) => toast(errMsg(e), true))}
                  >
                    <Check size={14} />
                    Approve
                  </button>
                  <button className="btn sm grow" onClick={() => setRejecting(p)}>
                    <X size={14} />
                    Reject
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {rejecting && (
        <ReasonDialog
          title={`Reject ${rejecting.name}’s photo?`}
          sub="That day does not count for the streak. They get the reason on WhatsApp."
          action="Reject photo"
          danger
          picks={['Not a work photo', 'Same photo as yesterday', 'Photo too dark / blurry']}
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => {
            await decide(rejecting, 'rejected', reason.slice(0, 120));
            toast('Photo rejected');
            setRejecting(null);
          }}
        />
      )}
    </>
  );
}
