// The player's air force: squadrons at their bases, loadouts, one mission each per turn, replacements
// and new squadrons. Missions and purchases go into the draft; loadouts change at once (free and instant).
import { useState } from 'react';
import { combatRadius } from '../lib/air';
import { distanceM } from '../lib/geo';
import { LoadoutEditor, loadoutTotals } from '../lib/Loadout';
import { MISSION_NAME } from '../lib/submissions';
import type { Change, LoadoutEntry, PlayerAir, Pos } from '../lib/types';
import { setLoadout } from './client';
import { pointsLeft, usePlay } from './store';

type Sq = PlayerAir['squadrons'][number];
type MissionChange = Extract<Change, { op: 'mission' }>;
const km = (m: number) => `${Math.round(m / 1000)} km`;
const NO_SQ: Sq[] = [];

/** Aircraft that can still fly: strength minus the airframes its accumulated damage has written off. */
export const flyable = (q: Pick<Sq, 'aircraft' | 'damage'> & { airframe: { hp: number } }) => Math.max(0, q.aircraft - Math.floor(q.damage / Math.max(1, q.airframe.hp)));

export const missionOf = (draft: Change[], sq: string) => draft.find((c): c is MissionChange => c.op === 'mission' && c.feature_id === sq) ?? null;

/** Where a mission goes, for drawing and range checks. Strikes follow the target unit (as drafted or live). */
export function missionPoint(m: MissionChange['payload'], draft: Change[]): Pos | null {
  const st = usePlay.getState().state;
  if (m.type === 'escort') {
    const main = missionOf(draft, m.escort_of ?? '');
    return main ? missionPoint(main.payload, draft) : null;
  }
  if (m.target) return m.target;
  const f = st?.features.find((x) => x.id === m.target_unit);
  return f?.geometry.type === 'Point' ? (f.geometry.coordinates as Pos) : null;
}

export function AirBox({ refresh }: { refresh(): Promise<void> }) {
  const air = usePlay((s) => s.state!.air);
  const squadrons = usePlay((s) => s.state!.air?.squadrons ?? NO_SQ);
  const draft = usePlay((s) => s.draft);
  const editable = usePlay((s) => !!s.state?.turn && !s.state.turn.frozen && !s.viewing);
  const [loadoutOf, setLoadoutOf] = useState<string | null>(null);
  if (!air || (!squadrons.length && !air.bases.length)) return null;
  const pending = draft.filter((c): c is Extract<Change, { op: 'buy_squadron' }> => c.op === 'buy_squadron');
  const bases = air.bases.map((b) => ({ ...b, squadrons: squadrons.filter((q) => q.base === b.id) }));
  const stranded = squadrons.filter((q) => !q.base);
  const open = squadrons.find((q) => q.id === loadoutOf);
  return (
    <section className="section">
      <header><h3>Air{squadrons.length ? ` (${squadrons.length} squadron${squadrons.length === 1 ? '' : 's'})` : ''}</h3></header>
      <p className="tip">Each squadron flies one mission per turn from its base. Missions resolve at push, before ground combat.</p>
      {bases.map((b) => (
        <div key={b.id} className="airbase">
          <h4>{b.name} <small>· {b.used + pending.filter((c) => c.payload.base === b.id).length} / {b.capacity} squadrons</small></h4>
          {b.squadrons.map((q) => <SquadronCard key={q.id} q={q} air={air} editable={editable} onLoadout={() => setLoadoutOf(q.id)} />)}
          {pending.filter((c) => c.payload.base === b.id).map((c) => (
            <div key={c.feature_id} className="sqcard pending">
              <div className="sqline"><span><strong>{c.payload.name || 'New squadron'}</strong> <span className="tag">arrives at push</span></span>
                {editable && <button type="button" className="ib" aria-label="Cancel this squadron" onClick={() => usePlay.getState().drop(c.feature_id)}>✕</button>}</div>
            </div>
          ))}
          {editable && <NewSquadron base={b} air={air} pending={pending.filter((c) => c.payload.base === b.id).length} />}
        </div>
      ))}
      {stranded.length > 0 && (
        <div className="airbase">
          <h4>Stranded <small>· base destroyed; the owner can rebase them</small></h4>
          {stranded.map((q) => <SquadronCard key={q.id} q={q} air={air} editable={false} onLoadout={() => setLoadoutOf(q.id)} />)}
        </div>
      )}
      {open && <LoadoutModal q={open} air={air} editable={editable} refresh={refresh} onClose={() => setLoadoutOf(null)} />}
    </section>
  );
}

function SquadronCard({ q, air, editable, onLoadout }: { q: Sq; air: PlayerAir; editable: boolean; onLoadout(): void }) {
  const draft = usePlay((s) => s.draft);
  const airPick = usePlay((s) => s.airPick);
  const airSel = usePlay((s) => s.airSel);
  const st = usePlay.getState();
  const m = missionOf(draft, q.id);
  const up = flyable(q);
  const ratio = q.max ? up / q.max : 0;
  const buy = draft.find((c): c is Extract<Change, { op: 'buy_aircraft' }> => c.op === 'buy_aircraft' && c.payload.squadron === q.id);
  const room = q.max - q.aircraft;
  const cost = q.airframe.cost_per_aircraft;
  const missiles = q.loadout.map((e) => `${e.count}× ${air.weapons.find((w) => w.id === e.weapon)?.name ?? '?'}`).join(', ');
  const strikes = draft.filter((c): c is MissionChange => c.op === 'mission' && c.payload.type === 'strike' && c.feature_id !== q.id);
  const sqName = (id: string) => air.squadrons.find((x) => x.id === id)?.name ?? 'squadron';
  const picking = airPick?.squadron === q.id;

  const setBuy = (n: number) => {
    if (n <= 0) return buy && st.drop(buy.feature_id);
    if (n > (buy?.payload.count ?? 0) && pointsLeft().spawn < cost) return st.say(`Not enough spawn points: one ${q.airframe.name} costs ${cost} SP`);
    st.put({ op: 'buy_aircraft', feature_id: buy?.feature_id ?? crypto.randomUUID(), payload: { squadron: q.id, count: n } });
  };
  const pick = (type: 'strike' | 'patrol' | 'recon') => {
    usePlay.setState({ airPick: picking && airPick?.type === type ? null : { squadron: q.id, type }, airSel: q.id, sel: null, tool: 'select' });
  };
  const target = m ? missionTarget(m, draft, sqName) : '';
  return (
    <div className={`sqcard${airSel === q.id ? ' on' : ''}`} onMouseEnter={() => usePlay.setState({ airSel: q.id })}>
      <div className="sqline">
        <span><strong>{q.name}</strong> <small>· {q.airframe.name}</small></span>
        <small>{up} / {q.max} aircraft</small>
      </div>
      <div className={`cbar${ratio < 0.3 ? ' low' : ratio < 0.6 ? ' mid' : ''}`} title={q.damage > 0 ? `Damage carried: ${Math.round(q.damage)} (each ${q.airframe.hp} downs one aircraft)` : undefined}><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
      <small>Radius {km(q.radius_m)} · {missiles || 'no missiles loaded (guns only)'}</small>
      <div className="inline">
        <button type="button" className="btn sm" onClick={onLoadout}>Loadout</button>
        {editable && up > 0 && q.base && (
          <span className="msn" role="group" aria-label={`Mission for ${q.name}`}>
            {(['strike', 'patrol', 'recon'] as const).map((t) => (
              <button key={t} type="button" className={`btn sm${m?.payload.type === t || (picking && airPick?.type === t) ? ' on' : ''}`} onClick={() => pick(t)}>{MISSION_NAME[t]}</button>
            ))}
            {strikes.length > 0 && (
              <select aria-label="Escort a strike" value={m?.payload.type === 'escort' ? m.payload.escort_of : ''}
                onChange={(e) => (e.target.value ? st.put({ op: 'mission', feature_id: q.id, payload: { type: 'escort', escort_of: e.target.value } }) : m && st.drop(q.id))}>
                <option value="">Escort…</option>
                {strikes.map((c) => <option key={c.feature_id} value={c.feature_id}>{sqName(c.feature_id)}</option>)}
              </select>
            )}
          </span>
        )}
      </div>
      {picking && <p className="tip">{airPick!.type === 'strike' ? 'Click an enemy ground unit' : airPick!.type === 'patrol' ? 'Click the centre of the patrol circle' : 'Click the point to scout'} within {km(q.radius_m)} of {q.base_name} (dashed ring). Esc cancels.</p>}
      {m && (
        <div className="sqline">
          <span><span className="tag">{MISSION_NAME[m.payload.type]}</span> {target}</span>
          {editable && <button type="button" className="btn sm" onClick={() => st.drop(q.id)}>Cancel</button>}
        </div>
      )}
      {m?.payload.type === 'patrol' && editable && (
        <label className="field">
          <span>Patrol circle {km(m.payload.radius_m ?? air.patrol_radius_km * 1000)}: catches enemy missions whose route crosses it</span>
          <input type="range" min={5} max={air.patrol_radius_max_km} step={5} value={Math.round((m.payload.radius_m ?? air.patrol_radius_km * 1000) / 1000)}
            onChange={(e) => st.put({ ...m, payload: { ...m.payload, radius_m: +e.target.value * 1000 } })} />
        </label>
      )}
      {!q.base && <p className="tip">No base: it cannot fly or take replacements until the owner rebases it.</p>}
      {up === 0 && q.base && <p className="tip">No aircraft left that can fly. Buy replacements.</p>}
      {editable && q.base && (room > 0 || buy) && (
        <div className="sqline">
          <small>Replacements ({cost} SP each, {room} free slot{room === 1 ? '' : 's'})</small>
          <span className="stepper">
            <button type="button" className="btn sm" aria-label={`One fewer replacement for ${q.name}`} disabled={!buy} onClick={() => setBuy((buy?.payload.count ?? 0) - 1)}>−</button>
            <b>{buy?.payload.count ?? 0}</b>
            <button type="button" className="btn sm" aria-label={`One more replacement for ${q.name}`} disabled={(buy?.payload.count ?? 0) >= room} onClick={() => setBuy((buy?.payload.count ?? 0) + 1)}>+</button>
          </span>
        </div>
      )}
    </div>
  );
}

function missionTarget(m: MissionChange, draft: Change[], sqName: (id: string) => string): string {
  const st = usePlay.getState().state;
  const p = m.payload;
  if (p.type === 'escort') return `escorting ${sqName(p.escort_of ?? '')}`;
  if (p.type === 'strike') return `on ${st?.features.find((f) => f.id === p.target_unit)?.props.name || 'enemy unit'}`;
  const at = missionPoint(p, draft);
  const base = st?.air.squadrons.find((q) => q.id === m.feature_id)?.base_pos;
  return at && base ? `${km(distanceM(base, at))} from base` : '';
}

function NewSquadron({ base, air, pending }: { base: PlayerAir['bases'][number]; air: PlayerAir; pending: number }) {
  const [item, setItem] = useState('');
  const [name, setName] = useState('');
  const items = air.squadron_items.filter((x) => x.unlocked);
  if (base.used + pending >= base.capacity) return <p className="tip">Base full.</p>;
  if (!air.squadron_items.length) return null;
  if (!items.length) return <p className="tip">Research a squadron in the tech tree to raise one here.</p>;
  const it = items.find((x) => x.id === item);
  const buy = () => {
    const st = usePlay.getState();
    if (!it) return;
    if (pointsLeft().spawn < it.spawn_cost) return st.say(`Not enough spawn points: ${it.name} costs ${it.spawn_cost} SP`);
    if (st.put({ op: 'buy_squadron', feature_id: crypto.randomUUID(), payload: { purchase_id: it.id, base: base.id, ...(name.trim() ? { name: name.trim() } : {}) } })) {
      setItem('');
      setName('');
    }
  };
  return (
    <div className="inline wrap">
      <select aria-label={`New squadron at ${base.name}`} value={item} onChange={(e) => setItem(e.target.value)}>
        <option value="">Raise a squadron here…</option>
        {items.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.size}× {x.airframe} · {x.spawn_cost} SP</option>)}
      </select>
      {it && <input aria-label="Squadron name" placeholder="Name (optional)" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
      {it && <button type="button" className="btn sm primary" onClick={buy}>Buy</button>}
    </div>
  );
}

function LoadoutModal({ q, air, editable, refresh, onClose }: { q: Sq; air: PlayerAir; editable: boolean; refresh(): Promise<void>; onClose(): void }) {
  const [value, setValue] = useState<LoadoutEntry[]>(q.loadout);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { playerId, draft } = usePlay.getState();
  const weapons = air.weapons.map((w) => ({ ...w, family_color: w.family_color }));
  const radius = combatRadius(q.airframe, loadoutTotals(value, weapons).weight, air.radius_penalty);
  const m = missionOf(draft, q.id);
  const at = m ? missionPoint(m.payload, draft) : null;
  const short = at && q.base_pos && distanceM(q.base_pos, at) > radius;
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await setLoadout(playerId, q.id, value);
      await refresh();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Loadout for ${q.name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <header><h2>{q.name} · loadout</h2><button type="button" className="ib" aria-label="Close" onClick={onClose}>✕</button></header>
        <LoadoutEditor frame={q.airframe} weapons={weapons} value={value} onChange={setValue} penalty={air.radius_penalty} readOnly={!editable} />
        {short && <p className="note bad">This loadout cannot reach this turn's {MISSION_NAME[m!.payload.type].toLowerCase()} target ({km(distanceM(q.base_pos!, at!))} away).</p>}
        {err && <p className="note bad" role="alert">{err}</p>}
        <div className="inline">
          {editable && <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save loadout'}</button>}
          {editable && <button type="button" className="btn" disabled={busy || !value.length} onClick={() => setValue([])}>Empty</button>}
          <button type="button" className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}

/** Air part of the last combat report. */
export function AirReportPart() {
  const r = usePlay((s) => s.state!.combat?.report?.air);
  if (!r || (!r.squadrons.length && !r.strikes.length && !r.recon.length && !r.downed)) return null;
  return (
    <>
      <h4>Air</h4>
      <ul className="changes">
        {r.squadrons.map((q, i) => (
          <li key={i}><div className="row"><span><strong>{q.name}</strong> {q.mission ? <span className="tag">{MISSION_NAME[q.mission as keyof typeof MISSION_NAME] ?? q.mission}</span> : null}{' '}
            <small>{q.lost > 0 ? `lost ${q.lost} aircraft (${q.before} → ${q.after})` : 'no losses'}</small></span></div></li>
        ))}
        {r.strikes.map((s, i) => (
          <li key={`s${i}`}><div className="row"><span>{s.squadron} → {s.target}: {s.aborted ? <span className="tag bad">{s.aborted}</span> : <>{s.hits} of {s.shots} hits{s.destroyed ? <> · <span className="tag bad">destroyed</span></> : ''}</>}</span></div></li>
        ))}
      </ul>
      {r.downed > 0 && <p className="tip">Enemy aircraft downed: {r.downed}.</p>}
      {r.recon.map((x, i) => (
        <div key={`r${i}`} className="tip">
          <strong>Recon by {x.squadron}</strong> ({km(x.radius_m)} circle, exact this turn):
          {x.units.length + x.squadrons.length === 0 ? ' nothing found.' : (
            <ul>
              {x.units.map((u, k) => <li key={k}>{u.name} ({u.type}) {u.strength} / {u.max}</li>)}
              {x.squadrons.map((u, k) => <li key={`q${k}`}>{u.name}: {u.aircraft} / {u.max} {u.airframe}</li>)}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}
