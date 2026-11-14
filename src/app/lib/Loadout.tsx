// Loadout editor for a squadron: hardpoints and payload as meters, the combat radius as it changes,
// missiles grouped by family with their tier. Used by players (only researched missiles) and the owner (all).
import { combatRadius } from './air';
import type { AirGuidance, LoadoutEntry } from './types';

export interface LoadoutWeapon {
  id: string;
  name: string;
  family: string;
  family_color: string | null;
  tier: number;
  guidance: AirGuidance;
  range_m: number;
  weight: number;
  slots: number;
  targets: string[];
  unlocked: boolean;
}

export interface LoadoutFrame { name: string; hardpoints: number; max_payload: number; radius_m: number }

export const GUIDANCE_TEXT: Record<AirGuidance, string> = {
  radar: 'radar-guided (beats ECM)', ir: 'heat-seeking (beats flares)', harm: 'anti-radiation (emitting radar AA only)', agm: 'air-to-ground (vs active protection)', none: 'unguided',
};
export const TARGET_TEXT: Record<string, string> = { air: 'aircraft', ground: 'ground units', ship: 'ships', radar: 'radar AA' };

export function loadoutTotals(l: LoadoutEntry[], weapons: LoadoutWeapon[]) {
  let slots = 0, weight = 0;
  for (const e of l) {
    const w = weapons.find((x) => x.id === e.weapon);
    if (!w) continue;
    slots += w.slots * e.count;
    weight += w.weight * e.count;
  }
  return { slots, weight };
}

const km = (m: number) => `${Math.round(m / 1000)} km`;

export function LoadoutEditor({ frame, weapons, value, onChange, penalty, readOnly }: {
  frame: LoadoutFrame; weapons: LoadoutWeapon[]; value: LoadoutEntry[]; onChange(v: LoadoutEntry[]): void; penalty: number; readOnly?: boolean;
}) {
  const { slots, weight } = loadoutTotals(value, weapons);
  const radius = combatRadius(frame, weight, penalty);
  const count = (id: string) => value.find((e) => e.weapon === id)?.count ?? 0;
  const set = (id: string, n: number) => onChange(n <= 0 ? value.filter((e) => e.weapon !== id) : value.some((e) => e.weapon === id) ? value.map((e) => (e.weapon === id ? { ...e, count: n } : e)) : [...value, { weapon: id, count: n }]);
  const fits = (w: LoadoutWeapon) => slots + w.slots <= frame.hardpoints && weight + w.weight <= frame.max_payload;
  const families = [...new Set(weapons.map((w) => w.family))];
  const meter = (used: number, max: number) => <div className={`cbar${used > max ? ' low' : used > max * 0.8 ? ' mid' : ''}`}><i style={{ width: `${Math.min(100, max ? (100 * used) / max : 0)}%` }} /></div>;
  return (
    <div className="loadout">
      <div className="kv">
        <div><small>Hardpoints {slots} / {frame.hardpoints}</small>{meter(slots, frame.hardpoints)}</div>
        <div><small>Payload {Math.round(weight)} / {Math.round(frame.max_payload)} kg</small>{meter(weight, frame.max_payload)}</div>
        <div><small>Combat radius</small><strong>{km(radius)}</strong> <small>(empty {km(frame.radius_m)})</small></div>
      </div>
      {families.length === 0 && <p className="empty">No missiles yet.</p>}
      {families.map((fam) => (
        <div key={fam} className="lfam">
          <h4><i className="chip" style={{ background: weapons.find((w) => w.family === fam)?.family_color ?? '#8794a4' }} aria-hidden /> {fam}</h4>
          <ul className="wlist">
            {weapons.filter((w) => w.family === fam).map((w) => (
              <li key={w.id} className={w.unlocked ? '' : 'off'}>
                <span className="lname">
                  <strong>{w.name}</strong> <span className="tag">tier {w.tier}</span><br />
                  <small>{GUIDANCE_TEXT[w.guidance]} · vs {w.targets.map((t) => TARGET_TEXT[t] ?? t).join(', ')} · {km(w.range_m)} · {w.weight} kg · {w.slots} slot{w.slots === 1 ? '' : 's'}</small>
                  {!w.unlocked && <small><br />Research it in the tech tree to load it.</small>}
                </span>
                {!readOnly && (
                  <span className="stepper">
                    <button type="button" className="btn sm" aria-label={`One fewer ${w.name}`} disabled={!count(w.id)} onClick={() => set(w.id, count(w.id) - 1)}>−</button>
                    <b>{count(w.id)}</b>
                    <button type="button" className="btn sm" aria-label={`One more ${w.name}`} disabled={!w.unlocked || !fits(w)} title={!fits(w) ? 'No hardpoints or payload left' : undefined} onClick={() => set(w.id, count(w.id) + 1)}>+</button>
                  </span>
                )}
                {readOnly && count(w.id) > 0 && <b>×{count(w.id)}</b>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="tip">Per aircraft. Changing a loadout is free and instant, and missiles refill every mission. Heavier loads shorten the radius.</p>
    </div>
  );
}
