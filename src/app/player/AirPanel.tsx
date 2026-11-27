// The player's air force. Squadrons are units on the map: drag one to fly it (the reachable area is drawn and
// moves are pulled into it), drop it on one of your airbases or carriers to land. In its details: loadout (only
// while landed), missiles left, attack targets with a salvo per weapon, return fire, a tanker's refuelling order,
// replacements. All of it goes into the draft; the server checks the same rules.
import { useState } from 'react';
import { combatRadius, coverageAt, distM, type Coverage } from '../lib/air';
import { forFrame, LoadoutEditor, loadoutTotals } from '../lib/Loadout';
import { anchorOf } from '../lib/submissions';
import type { AirAttack, Change, LoadoutEntry, PlayerAir, PlayerSquadron, Pos } from '../lib/types';
import { setLoadout } from './client';
import { pointsLeft, usePlay } from './store';

const km = (m: number) => `${Math.round(m / 1000).toLocaleString()} km`;
const NO_SQ: PlayerSquadron[] = [];
type Upd = Extract<Change, { op: 'update' }>;

/** Aircraft that can still fly: strength minus the airframes its accumulated damage has written off. */
export const flyable = (q: Pick<PlayerSquadron, 'aircraft' | 'damage'> & { airframe: { hp: number } }) => Math.max(0, q.aircraft - Math.floor(q.damage / Math.max(1, q.airframe.hp)));

const updOf = (draft: Change[], id: string) => draft.find((c): c is Upd => c.op === 'update' && c.feature_id === id) ?? null;

/** Where an object ends this turn: drafted position, else where it stands. */
export function endPos(id: string): Pos | null {
  const { state, draft } = usePlay.getState();
  const u = updOf(draft, id);
  if (u?.payload.geometry) return anchorOf(u.payload.geometry);
  const f = state?.features.find((x) => x.id === id);
  return f ? anchorOf(f.geometry) : null;
}

/** Does this squadron end the turn on the ground (stays on its base, or is dropped onto one of the player's bases)? */
export function landsAt(q: PlayerSquadron): string | null {
  const air = usePlay.getState().state?.air;
  if (!air) return null;
  const moved = !!updOf(usePlay.getState().draft, q.id)?.payload.geometry;
  if (!moved) return q.state === 'landed' ? q.base : null;
  const at = endPos(q.id)!;
  const b = air.bases.find((x) => distM(endPos(x.id) ?? x.pos, at) <= air.settings.land_snap_km * 1000 + 1);
  return b?.id ?? null;
}

/** Where this squadron may end its move: its combat radius around the player's bases, or a tanker's refuel circle. */
export function coverageFor(q: PlayerSquadron): Coverage {
  const air = usePlay.getState().state!.air;
  const bases = air.bases.map((b) => ({ pos: endPos(b.id) ?? b.pos, radius_m: q.radius_m }));
  const tankers: Coverage['tankers'] = [];
  if (q.airframe.refuelable && (!q.airframe.tanker || air.settings.tankers_refuel_tankers)) {
    for (const t of air.squadrons) {
      if (t.id === q.id || !t.airframe.tanker || t.grounded || landsAt(t)) continue;
      const at = endPos(t.id)!;
      // No daisy-chains: the tanker itself must be within reach of a real base.
      if (!air.bases.some((b) => distM(endPos(b.id) ?? b.pos, at) <= t.radius_m)) continue;
      tankers.push({ id: t.id, pos: at, radius_m: air.settings.refuel_radius_km * 1000 });
    }
  }
  return { bases, tankers };
}

/** Squadrons ending their move in this tanker's circle and needing it (not covered by a base). */
export function tankerClients(t: PlayerSquadron): PlayerSquadron[] {
  const air = usePlay.getState().state!.air;
  const at = endPos(t.id)!;
  return air.squadrons.filter((q) => {
    if (q.id === t.id || landsAt(q) || !q.airframe.refuelable) return false;
    const p = endPos(q.id)!;
    if (distM(p, at) > air.settings.refuel_radius_km * 1000) return false;
    return !air.bases.some((b) => distM(endPos(b.id) ?? b.pos, p) <= q.radius_m);
  });
}

/** Missiles a squadron has for this turn: a full load if it takes off from a base now, else what is left. */
export function ammoOf(q: PlayerSquadron): Record<string, number> {
  if (q.state === 'landed') return Object.fromEntries(q.loadout.map((e) => [e.weapon, e.count * q.aircraft]));
  return q.ammo;
}

/** Missiles already given to targets in the draft, per weapon. */
const committed = (attacks: AirAttack[], except?: string) => {
  const out: Record<string, number> = {};
  for (const a of attacks) if (a.target !== except) for (const w of a.weapons) out[w.weapon] = (out[w.weapon] ?? 0) + w.count;
  return out;
};

/** What kind of target this is for missile families: an airborne enemy squadron is 'air'; anything else counts as ground. */
export const targetKind = (id: string): 'air' | 'ground' => (usePlay.getState().state?.air.enemy[id]?.state === 'airborne' ? 'air' : 'ground');

/**
 * Declare an attack from a squadron on a target: every loaded weapon that can hit it and reach it from where the
 * squadron ends its move, with all the missiles it has left of each. The player trims the salvo afterwards.
 */
export function addAttack(q: PlayerSquadron, target: string): string | null {
  const st = usePlay.getState();
  const air = st.state!.air;
  const from = endPos(q.id), to = endPos(target);
  if (!from || !to) return 'No unit there.';
  const d = distM(from, to);
  const kind = targetKind(target);
  const u = updOf(st.draft, q.id);
  const attacks = (u?.payload.air_attacks ?? []).filter((a) => a.target !== target);
  const used = committed(attacks);
  const ammo = ammoOf(q);
  const fits = q.loadout.map((e) => air.weapons.find((w) => w.id === e.weapon)).filter((w): w is PlayerAir['weapons'][number] => !!w)
    .filter((w) => w.targets.includes(kind) || (kind === 'ground' && (w.targets.includes('ship') || w.targets.includes('radar'))));
  if (!fits.length) return `${q.name} carries nothing that hits ${kind === 'air' ? 'aircraft' : 'ground targets'}.`;
  const inRange = fits.filter((w) => w.range_m >= d);
  if (!inRange.length) return `Out of range: ${km(d)} from where ${q.name} ends its move; its ${fits.sort((a, b) => b.range_m - a.range_m)[0].name} reaches ${km(fits[0].range_m)}. Move it closer first.`;
  const weapons = inRange.map((w) => ({ weapon: w.id, count: Math.max(0, (ammo[w.id] ?? 0) - (used[w.id] ?? 0)) })).filter((w) => w.count > 0);
  if (!weapons.length) return `${q.name} has no missiles left for that. Land to rearm.`;
  st.put({ op: 'update', feature_id: q.id, payload: { air_attacks: [...attacks, { target, weapons }] } });
  return null;
}

// ---------------------------------------------------------------------------
// Left panel: the air force at a glance
// ---------------------------------------------------------------------------

export function AirBox() {
  const air = usePlay((s) => s.state!.air);
  const squadrons = usePlay((s) => s.state!.air?.squadrons ?? NO_SQ);
  const sel = usePlay((s) => s.sel);
  usePlay((s) => s.draft);
  if (!air || (!squadrons.length && !air.bases.length)) return null;
  const items = air.squadron_items.filter((x) => x.unlocked);
  const pick = (id: string) => usePlay.setState({ sel: id, tool: 'select' });
  return (
    <section className="section">
      <header><h3>Air{squadrons.length ? ` (${squadrons.length})` : ''}</h3></header>
      <p className="tip">Squadrons are on the map. Drag one to fly it inside its reach (dashed); drop it on your airbase or carrier to land, rearm and change its loadout.</p>
      <ul className="changes">
        {squadrons.map((q) => {
          const lands = landsAt(q);
          const tanker = !lands && coverageAt(endPos(q.id)!, coverageFor(q)).tanker;
          return (
            <li key={q.id} className={sel === q.id ? 'on' : ''}>
              <div className="row" role="button" tabIndex={0} onClick={() => pick(q.id)} onKeyDown={(e) => e.key === 'Enter' && pick(q.id)}>
                <span>
                  <strong>{q.name}</strong> <small>{q.airframe.name} · {flyable(q)}/{q.max}</small><br />
                  <small>{q.stranded ? 'stranded: no base' : q.grounded ? 'grounded this turn' : lands ? `on the ground${updOf(usePlay.getState().draft, q.id)?.payload.geometry ? ' (landing)' : ''}` : 'airborne'}
                    {tanker ? ' · needs tanker' : ''}{updOf(usePlay.getState().draft, q.id)?.payload.air_attacks?.length ? ' · attacking' : ''}</small>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {air.bases.length > 0 && (
        <p className="tip">
          Bases: {air.bases.map((b) => `${b.name} ${b.used}/${b.capacity}${b.carrier ? ' (carrier)' : ''}`).join(', ')}.
          {items.length > 0 ? ' Raise a new squadron from the tech tree: "Buy and place", then click one of your bases.' : ''}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Details of one of the player's squadrons
// ---------------------------------------------------------------------------

export function SquadronDetails({ id, editable, refresh }: { id: string; editable: boolean; refresh(): Promise<void> }) {
  const air = usePlay((s) => s.state!.air);
  const draft = usePlay((s) => s.draft);
  const features = usePlay((s) => s.state!.features);
  const airTarget = usePlay((s) => s.airTarget);
  const [loadoutOpen, setLoadoutOpen] = useState(false);
  const q = air.squadrons.find((x) => x.id === id);
  if (!q) return null;
  const st = usePlay.getState();
  const u = updOf(draft, q.id);
  const moved = !!u?.payload.geometry;
  const lands = landsAt(q);
  const cov = coverageAt(endPos(q.id)!, coverageFor(q));
  const up = flyable(q);
  const ratio = q.max ? up / q.max : 0;
  const ammo = ammoOf(q);
  const attacks = u?.payload.air_attacks ?? [];
  const used = committed(attacks);
  const wName = (wid: string) => air.weapons.find((w) => w.id === wid)?.name ?? '?';
  const nameOf = (fid: string) => features.find((f) => f.id === fid)?.props.name || air.enemy[fid]?.airframe || 'enemy unit';
  const setAttacks = (next: AirAttack[]) => st.put({ op: 'update', feature_id: q.id, payload: { air_attacks: next } });
  const setCount = (target: string, weapon: string, n: number) =>
    setAttacks(attacks.map((a) => (a.target !== target ? a : { ...a, weapons: a.weapons.map((w) => (w.weapon === weapon ? { ...w, count: n } : w)).filter((w) => w.count > 0) })).filter((a) => a.weapons.length));
  const buy = draft.find((c): c is Extract<Change, { op: 'buy_aircraft' }> => c.op === 'buy_aircraft' && c.payload.squadron === q.id);
  const room = q.max - q.aircraft;
  const cost = q.airframe.cost_per_aircraft;
  const setBuy = (n: number) => {
    if (n <= 0) return buy && st.drop(buy.feature_id);
    if (n > (buy?.payload.count ?? 0) && pointsLeft().spawn < cost) return st.say(`Not enough spawn points: one ${q.airframe.name} costs ${cost} SP`);
    st.put({ op: 'buy_aircraft', feature_id: buy?.feature_id ?? crypto.randomUUID(), payload: { squadron: q.id, count: n } });
  };
  const clients = q.airframe.tanker ? tankerClients(q) : [];
  const cap = Math.floor(air.settings.refuel_per_aircraft * up);
  const pri = u?.payload.refuel_priority ?? [];
  const ordered = [...clients].sort((a, b) => (pri.indexOf(a.id) + 1 || 999) - (pri.indexOf(b.id) + 1 || 999));
  const move = (i: number, by: number) => {
    const ids = ordered.map((x) => x.id);
    const [x] = ids.splice(i, 1);
    ids.splice(i + by, 0, x);
    st.put({ op: 'update', feature_id: q.id, payload: { refuel_priority: ids } });
  };
  const picking = airTarget === q.id;
  return (
    <div className="combat">
      <dl><div><dt>Aircraft</dt><dd>{up} / {q.max} {q.airframe.name}{q.damage > 0 ? ` (${Math.round(q.damage)} damage carried)` : ''}</dd></div></dl>
      <div className={`cbar${ratio < 0.3 ? ' low' : ratio < 0.6 ? ' mid' : ''}`}><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
      <dl>
        <div><dt>Status</dt><dd>{q.stranded ? 'Stranded: no base to return to (the owner can rebase it)' : q.grounded ? 'Grounded this turn' : lands ? (moved ? 'Landing at a base' : `Landed at ${q.base_name ?? 'base'}`) : moved && q.state === 'landed' ? 'Taking off' : 'Airborne'}</dd></div>
        <div><dt>Reach</dt><dd>{km(q.airframe.speed_m)} a turn; combat radius {km(q.radius_m)} with this loadout</dd></div>
        {q.airframe.role && <div><dt>Role</dt><dd>{q.airframe.role}</dd></div>}
      </dl>
      {!lands && cov.tanker && <p className="note warn">Needs tanker: this position is only allowed inside {nameOf(cov.tanker)}'s refuel circle. If the tanker is lost or full, this squadron is forced home and grounded.</p>}
      <h4>Missiles {q.state === 'landed' ? '(full load on take-off)' : 'left'}</h4>
      {q.loadout.length === 0 ? <p className="tip">No missiles loaded{q.airframe.families.length ? '' : ' (this airframe carries none)'}.</p> : (
        <ul className="allocs">
          {q.loadout.map((e) => <li key={e.weapon}><div className="row2"><span>{wName(e.weapon)}</span><small>{ammo[e.weapon] ?? 0} of {e.count * q.aircraft}{used[e.weapon] ? ` · ${used[e.weapon]} in salvos` : ''}</small></div></li>)}
        </ul>
      )}
      <div className="inline">
        <button type="button" className="btn sm" onClick={() => setLoadoutOpen(true)}>{q.state === 'landed' && !moved && editable ? 'Change loadout' : 'Loadout'}</button>
      </div>
      {editable && !q.grounded && !q.stranded && (
        <>
          <h4>Attacks this turn</h4>
          {attacks.length === 0 && <p className="tip">None. Pick targets: any enemy unit on the map, or enemy squadron on your radar, within range of its missiles from where it ends its move.</p>}
          {attacks.map((a) => {
            const d = distM(endPos(q.id)!, endPos(a.target) ?? endPos(q.id)!);
            return (
              <div key={a.target} className="sqcard">
                <div className="sqline"><strong>{nameOf(a.target)}</strong><small>{km(d)}</small>
                  <button type="button" className="ib" aria-label={`Drop the attack on ${nameOf(a.target)}`} onClick={() => setAttacks(attacks.filter((x) => x.target !== a.target))}>✕</button></div>
                {a.weapons.map((w) => {
                  const wp = air.weapons.find((x) => x.id === w.weapon);
                  const free = (ammo[w.weapon] ?? 0) - (used[w.weapon] ?? 0);
                  return (
                    <div key={w.weapon} className="sqline">
                      <small>{wp?.name}{wp && wp.range_m < d ? <b className="bad"> out of range ({km(wp.range_m)})</b> : ''}</small>
                      <span className="stepper">
                        <button type="button" className="btn sm" aria-label={`One fewer ${wp?.name} at ${nameOf(a.target)}`} onClick={() => setCount(a.target, w.weapon, w.count - 1)}>−</button>
                        <b>{w.count}</b>
                        <button type="button" className="btn sm" aria-label={`One more ${wp?.name} at ${nameOf(a.target)}`} disabled={free <= 0} onClick={() => setCount(a.target, w.weapon, w.count + 1)}>+</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <button type="button" className={`btn sm${picking ? ' on' : ''}`} onClick={() => usePlay.setState({ airTarget: picking ? null : q.id })}>{picking ? 'Click a target on the map…' : 'Add a target'}</button>
          {picking && <p className="tip">Click an enemy unit, or an enemy squadron on your radar. Every loaded missile that can hit it and reach it is assigned; trim the salvos afterwards. Esc cancels.</p>}
          <label className="field">
            <span>Return fire when attacked: {u?.payload.return_salvo ?? q.return_salvo} missile(s) per aircraft per phase</span>
            <input type="range" min={0} max={8} value={u?.payload.return_salvo ?? q.return_salvo} onChange={(e) => st.put({ op: 'update', feature_id: q.id, payload: { return_salvo: +e.target.value } })} />
          </label>
        </>
      )}
      {q.airframe.tanker && (
        <>
          <h4>Refuelling</h4>
          <p className="tip">{lands ? 'On the ground: it refuels no one this turn.' : `Refuel circle ${air.settings.refuel_radius_km} km. Can refuel ${cap} squadron${cap === 1 ? '' : 's'} this turn (fewer if it loses aircraft).`}</p>
          {!lands && ordered.length > 0 && (
            <ol className="changes">
              {ordered.map((c, i) => (
                <li key={c.id} className={i >= cap ? 'off' : ''}>
                  <div className="sqline">
                    <span>{i + 1}. {c.name}{i >= cap ? <small className="bad"> no capacity: forced home</small> : null}</span>
                    {editable && (
                      <span className="stepper">
                        <button type="button" className="btn sm" aria-label={`Refuel ${c.name} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                        <button type="button" className="btn sm" aria-label={`Refuel ${c.name} later`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)}>↓</button>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {editable && q.state === 'landed' && q.base && !moved && (room > 0 || buy) && (
        <div className="sqline">
          <small>Replacements ({cost} SP each, {room} free slot{room === 1 ? '' : 's'}); it stays on the ground this turn</small>
          <span className="stepper">
            <button type="button" className="btn sm" aria-label={`One fewer replacement for ${q.name}`} disabled={!buy} onClick={() => setBuy((buy?.payload.count ?? 0) - 1)}>−</button>
            <b>{buy?.payload.count ?? 0}</b>
            <button type="button" className="btn sm" aria-label={`One more replacement for ${q.name}`} disabled={(buy?.payload.count ?? 0) >= room} onClick={() => setBuy((buy?.payload.count ?? 0) + 1)}>+</button>
          </span>
        </div>
      )}
      {loadoutOpen && <LoadoutModal q={q} air={air} editable={editable && q.state === 'landed' && !!q.base && !moved} refresh={refresh} onClose={() => setLoadoutOpen(false)} />}
    </div>
  );
}

function LoadoutModal({ q, air, editable, refresh, onClose }: { q: PlayerSquadron; air: PlayerAir; editable: boolean; refresh(): Promise<void>; onClose(): void }) {
  const [value, setValue] = useState<LoadoutEntry[]>(q.loadout);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { playerId } = usePlay.getState();
  const weapons = forFrame(air.weapons, q.airframe.families);
  const radius = combatRadius(q.airframe, loadoutTotals(value, weapons).weight, q.airframe.payload_penalty);
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
        {!editable && <p className="note warn">Loadouts change only while the squadron is landed at a base and stays there this turn.</p>}
        <LoadoutEditor frame={q.airframe} weapons={weapons} value={value} onChange={setValue} penalty={q.airframe.payload_penalty} readOnly={!editable} />
        {editable && radius < q.radius_m && <p className="tip">Radius with this load: {km(radius)} (now {km(q.radius_m)}).</p>}
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

/** Another side's squadron on this player's radar: type and an estimate band only. */
export function EnemySquadron({ id }: { id: string }) {
  const e = usePlay((s) => s.state!.air?.enemy[id]);
  if (!e) return null;
  return (
    <p>
      Enemy squadron on your radar: <strong>{e.airframe}</strong>{e.role ? ` (${e.role})` : ''}, {e.state === 'landed' ? 'on the ground' : 'airborne'} ·{' '}
      <span className={`band ${e.band.replace(' ', '-')}`}>{e.band}</span>
    </p>
  );
}

/** Air part of the last combat report. */
export function AirReportPart() {
  const r = usePlay((s) => s.state!.combat?.report?.air);
  if (!r || (!r.squadrons.length && !r.strikes.length && !r.downed)) return null;
  return (
    <>
      <h4>Air</h4>
      <ul className="changes">
        {r.squadrons.map((q, i) => (
          <li key={i}><div className="row"><span><strong>{q.name}</strong>{' '}
            <small>{q.lost > 0 ? `lost ${q.lost} aircraft (${q.before} → ${q.after})` : 'no losses'}{q.refueled_by ? ` · refuelled by ${q.refueled_by}` : ''}</small>
            {q.forced && <><br /><small className="bad">Forced home: {q.forced}{q.stranded ? ' (no base: stranded)' : ', grounded next turn'}</small></>}</span></div></li>
        ))}
        {r.strikes.map((s, i) => (
          <li key={`s${i}`}><div className="row"><span>{s.squadron} → {s.target}: {s.shots ? <>{s.hits} of {s.shots} hit{s.destroyed ? <> · <span className="tag bad">destroyed</span></> : ''}</> : <span className="tag bad">{s.aborted ?? 'no shots'}</span>}</span></div></li>
        ))}
      </ul>
      {r.downed > 0 && <p className="tip">Enemy aircraft downed: {r.downed}.</p>}
    </>
  );
}
