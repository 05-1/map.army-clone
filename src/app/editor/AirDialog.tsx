// The owner's air admin: squadrons on the map (create, assign, rebase, every override), airframes (from real-world
// presets) with their role and the missile families they carry, roles, missile families and tiers (each tier is a
// node in the missile tree, kept in step automatically), every countermeasure in one table, air settings, and a
// shot-by-shot air sandbox. Every save calls an owner-only RPC that validates it.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AirframeIn, AirPhase, AirShot, AirUnitIn, AirWeaponIn } from '../lib/air';
import { AIRFRAME_PRESETS, MISSILE_PRESETS } from '../lib/airPresets';
import { DEFAULT_SETTINGS, newSalt, resolveCombat, type CombatSettings, type UnitIn } from '../lib/combat';
import { symbolDataUrl } from '../lib/images';
import { forFrame, GUIDANCE_TEXT, LoadoutEditor, TARGET_TEXT, type LoadoutWeapon } from '../lib/Loadout';
import type { Airframe, AirFamily, AirGuidance, AirRole, AirWeapon, LoadoutEntry, MapMeta, Pos, Squadron } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, IconButton } from './ui';

export type AirTab = 'squadrons' | 'airframes' | 'roles' | 'weapons' | 'cm' | 'settings' | 'sandbox';
const TABS: [AirTab, string][] = [['squadrons', 'Squadrons'], ['airframes', 'Airframes'], ['roles', 'Roles'], ['weapons', 'Missiles'], ['cm', 'Countermeasures'],
  ['settings', 'Settings'], ['sandbox', 'Sandbox']];

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;
const num = (v: string, lo = 0, hi = 1e9) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));
const km = (m: number) => +(m / 1000).toFixed(1);

export function AirDialog({ backend, map, tab: first = 'squadrons', focus, refresh, onClose }: {
  backend: Backend; map: MapMeta; tab?: AirTab; focus?: string | null; refresh(): Promise<void>; onClose(): void;
}) {
  const [tab, setTab] = useState<AirTab>(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const air = useEd((s) => s.air);
  useEffect(() => {
    void refresh().catch(() => {});
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest?.('input, textarea, select') && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run: Run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      backend.ping(map);
      setBusy(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return false;
    }
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Air" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog xwide">
        <header>
          <h2>Air on "{map.name}"</h2>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </header>
        <div className="seg tabs" role="tablist">
          {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => (setTab(t), setError(''))}>{label}</button>)}
        </div>
        {error && <p className="note bad" role="alert">{error}</p>}
        {!air ? <p className="empty">Loading…</p> : (
          <>
            {tab === 'squadrons' && <Squadrons backend={backend} map={map} busy={busy} run={run} goTo={setTab} focus={focus ?? null} />}
            {tab === 'airframes' && <Airframes backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'roles' && <Roles backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'weapons' && <Missiles backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'cm' && <Countermeasures backend={backend} map={map} run={run} />}
            {tab === 'settings' && <AirSettingsTab backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'sandbox' && <AirSandbox />}
          </>
        )}
      </div>
    </div>
  );
}

function Split({ list, form }: { list: ReactNode; form: ReactNode }) {
  return <div className="techedit"><div>{list}</div><div className="form">{form}</div></div>;
}

/** Missiles in the shape the loadout editor wants; the owner may load anything, researched or not. */
function useLoadoutWeapons(): LoadoutWeapon[] {
  const air = useEd((s) => s.air!);
  return useMemo(() => air.weapons.filter((w) => !w.deleted_at).map((w) => {
    const f = air.families.find((x) => x.id === w.family_id);
    return { id: w.id, name: w.name, family: f?.name ?? '?', family_id: w.family_id, family_color: f?.color ?? null, tier: w.tier, guidance: w.guidance, range_m: w.range_m,
      weight: w.weight, slots: w.slots, targets: w.targets, unlocked: true };
  }).sort((a, b) => a.family.localeCompare(b.family) || a.tier - b.tier), [air]);
}

// ---------------------------------------------------------------------------
// Squadrons
// ---------------------------------------------------------------------------

const roleName = (roles: AirRole[], id: string | null) => roles.find((r) => r.id === id)?.name ?? 'no role';

function Squadrons({ backend, map, busy, run, goTo, focus }: { backend: Backend; map: MapMeta; busy: boolean; run: Run; goTo(t: AirTab): void; focus: string | null }) {
  const { squadrons, airframes, bases, roles } = useEd((s) => s.air!);
  const players = useEd((s) => s.players);
  const weapons = useLoadoutWeapons();
  const [edit, setEdit] = useState<Squadron | null>(() => squadrons.find((q) => q.id === focus) ?? null);
  const set = (p: Partial<Squadron>) => edit && setEdit({ ...edit, ...p });
  const frame = airframes.find((a) => a.id === edit?.airframe_id);
  const who = (id: string | null) => players.find((p) => p.id === id)?.name ?? 'unassigned';
  const startNew = () => {
    const a = airframes.find((x) => !x.deleted_at);
    if (a) setEdit({ id: '', name: '', owner_player_id: null, airframe_id: a.id, state: 'landed', base_feature_id: bases[0]?.id ?? null, pos: bases[0]?.pos ?? [0, 0],
      aircraft: a.squadron_size, max_aircraft: a.squadron_size, damage: 0, loadout: [], ammo: {}, grounded: false, grounded_until: null, stranded: false, return_salvo: null,
      radius_m: a.radius_m, weight: 0 });
  };
  const save = async () => {
    if (!edit) return;
    const { id, radius_m: _r, weight: _w, grounded_until: _g, ...rest } = edit;
    let nid = '';
    if (await run(async () => (nid = await backend.saveSquadron(map.id, { ...rest, ...(id ? { id } : {}), name: edit.name.trim() })))) setEdit({ ...edit, id: nid });
  };
  const fullAmmo = (l: LoadoutEntry[], n: number) => Object.fromEntries(l.map((e) => [e.weapon, e.count * n]));
  const groups: { title: string; list: Squadron[] }[] = [
    ...bases.map((b) => ({ title: `${b.carrier ? 'Carrier' : 'Airbase'} ${b.name} · ${who(b.owner)} · ${b.used}/${b.capacity} landed`, list: squadrons.filter((q) => q.state === 'landed' && q.base_feature_id === b.id) })),
    { title: 'Airborne', list: squadrons.filter((q) => q.state === 'airborne') },
    { title: 'Stranded (no base)', list: squadrons.filter((q) => q.state === 'landed' && !q.base_feature_id) },
  ].filter((g) => g.list.length || !/^(Airborne|Stranded)/.test(g.title));
  return (
    <Split
      list={(
        <>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={!airframes.some((a) => !a.deleted_at)} onClick={startNew}>New squadron</button>
            {!airframes.length && <button type="button" className="btn" onClick={() => goTo('airframes')}>Make an airframe first</button>}
          </div>
          {bases.length === 0 && (
            <p className="note">No airbases yet. In Combat &gt; Unit templates, give a template an <strong>air capacity</strong> (how many squadrons it can base; a naval template makes it a carrier) and place a unit with it.</p>
          )}
          {groups.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              {g.list.length === 0 && <p className="empty">No squadrons here.</p>}
              <ul className="changes">
                {g.list.map((q) => {
                  const a = airframes.find((x) => x.id === q.airframe_id);
                  return (
                    <li key={q.id} className={edit?.id === q.id ? 'on' : ''}>
                      <div className="row" role="button" tabIndex={0} onClick={() => setEdit({ ...q })} onKeyDown={(e) => e.key === 'Enter' && setEdit({ ...q })}>
                        <span><strong>{q.name}</strong> <small>{a?.name} · {q.aircraft}/{q.max_aircraft} aircraft · {who(q.owner_player_id)} · radius {km(q.radius_m)} km{q.grounded ? ' · grounded' : ''}</small></span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="tip">Squadrons are units on the map: drag one to move it, or set it here. Players raise new ones by buying a tech-tree item of kind "Squadron" onto their airbase, and buy replacements while landed.</p>
        </>
      )}
      form={edit && frame ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name || 'squadron'}` : 'New squadron'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} placeholder="e.g. 31st Fighter Squadron" onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="row2">
            <Field label="Player">
              <select value={edit.owner_player_id ?? ''} onChange={(e) => set({ owner_player_id: e.target.value || null })}>
                <option value="">Unassigned (yours)</option>
                {players.filter((p) => !p.revoked).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Airframe">
              <select value={edit.airframe_id} onChange={(e) => set({ airframe_id: e.target.value, loadout: [], ammo: {} })}>
                {airframes.filter((a) => !a.deleted_at || a.id === edit.airframe_id).map((a) => <option key={a.id} value={a.id}>{a.name} ({roleName(roles, a.role_id)})</option>)}
              </select>
            </Field>
          </div>
          <div className="seg" role="group" aria-label="Where it is">
            <button type="button" className={edit.state === 'landed' ? 'on' : ''} onClick={() => set({ state: 'landed' })}>Landed at a base</button>
            <button type="button" className={edit.state === 'airborne' ? 'on' : ''} onClick={() => set({ state: 'airborne' })}>Airborne at a position</button>
          </div>
          {edit.state === 'landed' ? (
            <Field label="Base" wide>
              <select value={edit.base_feature_id ?? ''} onChange={(e) => set({ base_feature_id: e.target.value || null })}>
                <option value="">None (stranded: cannot fly)</option>
                {bases.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.carrier ? 'carrier, ' : ''}{who(b.owner)}, {b.used}/{b.capacity})</option>)}
              </select>
            </Field>
          ) : (
            <div className="row2">
              <Field label="Longitude"><input type="number" step="any" value={edit.pos[0]} onChange={(e) => set({ pos: [num(e.target.value, -180, 180), edit.pos[1]] as Pos })} /></Field>
              <Field label="Latitude"><input type="number" step="any" value={edit.pos[1]} onChange={(e) => set({ pos: [edit.pos[0], num(e.target.value, -85, 85)] as Pos })} /></Field>
            </div>
          )}
          <div className="row2">
            <Field label="Aircraft"><input type="number" min={0} value={edit.aircraft} onChange={(e) => set({ aircraft: Math.round(num(e.target.value, 0, 100)) })} /></Field>
            <Field label="Full strength"><input type="number" min={1} value={edit.max_aircraft} onChange={(e) => set({ max_aircraft: Math.round(num(e.target.value, 1, 100)) })} /></Field>
          </div>
          <div className="row2">
            <Field label={`Damage carried (below one aircraft's ${frame.hp} HP)`}><input type="number" min={0} value={edit.damage} onChange={(e) => set({ damage: num(e.target.value) })} /></Field>
            <Field label="Return fire (missiles per aircraft per phase; blank = default)">
              <input type="number" min={0} max={50} value={edit.return_salvo ?? ''} onChange={(e) => set({ return_salvo: e.target.value === '' ? null : Math.round(num(e.target.value, 0, 50)) })} />
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={edit.grounded} onChange={(e) => set({ grounded: e.target.checked })} /> Grounded this turn (cannot take off)</label>
          <label className="check"><input type="checkbox" checked={edit.stranded} onChange={(e) => set({ stranded: e.target.checked })} /> Stranded until you rebase it</label>
          <h4>Loadout <small>(per aircraft; {frame.name} carries {frame.families.length ? frame.families.map((f) => useEd.getState().air?.families.find((x) => x.id === f)?.name).join(', ') : 'no missiles'})</small></h4>
          <LoadoutEditor frame={frame} weapons={forFrame(weapons, frame.families)} value={edit.loadout} onChange={(loadout: LoadoutEntry[]) => set({ loadout, ammo: fullAmmo(loadout, edit.aircraft) })} penalty={frame.payload_penalty} />
          {edit.loadout.length > 0 && (
            <div className="setgrp">
              <h4>Missiles left (whole squadron)</h4>
              <div className="row2 wrap">
                {edit.loadout.map((e) => (
                  <Field key={e.weapon} label={weapons.find((w) => w.id === e.weapon)?.name ?? '?'}>
                    <input type="number" min={0} value={edit.ammo[e.weapon] ?? e.count * edit.aircraft} onChange={(ev) => set({ ammo: { ...edit.ammo, [e.weapon]: Math.round(num(ev.target.value, 0, 5000)) } })} />
                  </Field>
                ))}
              </div>
              <button type="button" className="btn sm" onClick={() => set({ ammo: fullAmmo(edit.loadout, edit.aircraft) })}>Rearm fully</button>
            </div>
          )}
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void save()}>Save</button>
            {edit.id && <button type="button" className="btn" onClick={() => useEd.getState().select([edit.id])}>Select on map</button>}
            {edit.id && <button type="button" className="btn danger" disabled={busy} onClick={() => confirm(`Delete ${edit.name}? Its aircraft are gone for good.`) && void run(() => backend.deleteSquadron(edit.id)).then((ok) => ok && setEdit(null))}>Delete</button>}
          </div>
        </>
      ) : <p className="tip">Pick a squadron to edit, or make a new one.</p>}
    />
  );
}

// ---------------------------------------------------------------------------
// Airframes
// ---------------------------------------------------------------------------

const BLANK_AF: Airframe = { id: '', name: '', role_id: null, refuelable: true, hp: 100, speed_m: 3000000, hardpoints: 8, max_payload: 7000, payload_penalty: 0.4, families: [],
  radius_m: 900000, radar_m: 100000, signature: 1, ecm: 20, flares: 20, maneuver: 25, gun_accuracy: 40, gun_damage: 40, gun_range_m: 1200, landed_armor: 0,
  squadron_size: 12, cost_per_aircraft: 10, asset_id: null, sidc: 'SFAPMF---------', deleted_at: null };

function Airframes({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const { airframes, roles, families } = useEd((s) => s.air!);
  const [edit, setEdit] = useState<Airframe | null>(null);
  const set = (p: Partial<Airframe>) => edit && setEdit({ ...edit, ...p });
  const liveFams = families.filter((f) => !f.deleted_at);
  const body = (a: Airframe, extra: Record<string, unknown> = {}) => {
    const { id, deleted_at: _d, tanker: _t, ...rest } = a;
    return { ...rest, ...(id ? { id } : {}), name: a.name.trim(), ...extra };
  };
  const preset = (name: string) => {
    const p = AIRFRAME_PRESETS.find((x) => x.name === name);
    if (!p) return;
    const { role, ...rest } = p;
    const r = roles.find((x) => x.name === role && !x.deleted_at);
    setEdit({ ...BLANK_AF, ...rest, role_id: r?.id ?? null, families: role === 'Tanker' ? [] : liveFams.map((f) => f.id) });
  };
  const f = (label: string, k: keyof Airframe, o: { scale?: number; step?: number; hint?: string } = {}) => (
    <Field label={label}>
      <input type="number" min={0} step={o.step ?? 'any'} value={+((edit![k] as number) / (o.scale ?? 1)).toFixed(3)} title={o.hint}
        onChange={(e) => set({ [k]: num(e.target.value) * (o.scale ?? 1) } as Partial<Airframe>)} />
    </Field>
  );
  return (
    <Split
      list={(
        <>
          <div className="row2 wrap">
            <button type="button" className="btn primary" onClick={() => setEdit({ ...BLANK_AF, families: liveFams.map((x) => x.id) })}>New airframe</button>
            <select aria-label="Start from a real aircraft" value="" onChange={(e) => preset(e.target.value)}>
              <option value="">Start from a real aircraft…</option>
              {AIRFRAME_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.role})</option>)}
            </select>
          </div>
          {airframes.length === 0 && <p className="empty">No airframes yet: an airframe is an aircraft type (F-16, B-52, KC-135, …). Start from a real one and adjust.</p>}
          <ul className="changes">
            {airframes.map((a) => (
              <li key={a.id} className={`${edit?.id === a.id ? 'on' : ''}${a.deleted_at ? ' off' : ''}`}>
                <div className="row" role="button" tabIndex={0} onClick={() => setEdit({ ...a })} onKeyDown={(e) => e.key === 'Enter' && setEdit({ ...a })}>
                  {a.sidc && <img className="mini" src={symbolDataUrl(a.sidc, 20)} alt="" />}
                  <span><strong>{a.name}</strong> <small>{roleName(roles, a.role_id)} · {km(a.speed_m)} km/turn · {km(a.radius_m)} km radius · {a.hardpoints} hardpoints, {Math.round(a.max_payload)} kg · radar {km(a.radar_m)} km · RCS ×{a.signature}</small></span>
                </div>
              </li>
            ))}
          </ul>
          <p className="tip">Research: add a tech-tree item of kind "Squadron" for each airframe (Tech window). Researching it unlocks the airframe; buying it raises a squadron at an airbase.</p>
        </>
      )}
      form={edit ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name || 'airframe'}` : 'New airframe'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} placeholder="e.g. F-16C Block 50" onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="row2">
            <Field label="Role">
              <select value={edit.role_id ?? ''} onChange={(e) => { const r = roles.find((x) => x.id === e.target.value); set({ role_id: r?.id ?? null, ...(r ? { payload_penalty: r.payload_penalty } : {}) }); }}>
                <option value="">No role</option>
                {roles.filter((r) => !r.deleted_at || r.id === edit.role_id).map((r) => <option key={r.id} value={r.id}>{r.name}{r.is_tanker ? ' (refuels others)' : ''}</option>)}
              </select>
            </Field>
            <label className="check"><input type="checkbox" checked={edit.refuelable} onChange={(e) => set({ refuelable: e.target.checked })} /> Can refuel from a tanker</label>
          </div>
          <div className="setgrp"><h4>Airframe</h4><div className="row2">{f('HP per aircraft', 'hp')}{f('Squadron size', 'squadron_size', { step: 1 })}</div>
            <div className="row2">{f('SP per replacement aircraft', 'cost_per_aircraft', { step: 1 })}{f('Armor on the ground', 'landed_armor', { hint: 'Strikes on it while landed: damage × min(AP ÷ this, 1.5)' })}</div></div>
          <div className="setgrp"><h4>Reach</h4><div className="row2">{f('Speed: max move per turn (km)', 'speed_m', { scale: 1000 })}{f('Combat radius, empty (km)', 'radius_m', { scale: 1000 })}</div>
            <div className="row2">{f('Hardpoints', 'hardpoints', { step: 1 })}{f('Max payload (kg)', 'max_payload')}</div>
            {f('Payload penalty (0.4 = −40% radius when fully loaded)', 'payload_penalty')}
            <small className="note">Fully loaded: {km(edit.radius_m * (1 - edit.payload_penalty))} km. It must end every turn within its radius of an airbase, a carrier or a tanker's refuel circle.</small></div>
          <div className="setgrp"><h4>Missile families it can carry</h4>
            {liveFams.length === 0 ? <p className="empty">No missile families yet (Missiles tab).</p> : (
              <span className="inline wrap">
                {liveFams.map((fm) => (
                  <label key={fm.id} className="check"><input type="checkbox" checked={edit.families.includes(fm.id)}
                    onChange={(e) => set({ families: e.target.checked ? [...edit.families, fm.id] : edit.families.filter((x) => x !== fm.id) })} /> {fm.name}</label>
                ))}
              </span>
            )}</div>
          <div className="setgrp"><h4>Sensors</h4><div className="row2">{f('Radar range (km)', 'radar_m', { scale: 1000 })}{f('Signature (RCS ×; stealth is low)', 'signature', { hint: 'Enemies detect it at their sensor range × this' })}</div></div>
          <div className="setgrp"><h4>Countermeasures (percentage points off the enemy's hit chance)</h4>
            <div className="row2">{f('ECM / chaff vs radar', 'ecm')}{f('Flares vs IR', 'flares')}</div>{f('Manoeuvrability vs guns', 'maneuver')}</div>
          <div className="setgrp"><h4>Gun</h4><div className="row2">{f('Accuracy', 'gun_accuracy')}{f('Damage per hit (0 = no gun)', 'gun_damage')}</div>{f('Range (km)', 'gun_range_m', { scale: 1000 })}</div>
          <Field label="NATO symbol (SIDC)" wide><input value={edit.sidc ?? ''} spellCheck={false} onChange={(e) => set({ sidc: e.target.value.toUpperCase().trim() || null })} /></Field>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void run(async () => { const id = await backend.saveAirframe(map.id, body(edit)); setEdit({ ...edit, id }); })}>Save</button>
            {edit.id && <button type="button" className="btn" onClick={() => setEdit({ ...edit, id: '', name: `${edit.name} (copy)`, deleted_at: null })}>Clone</button>}
            {edit.id && (edit.deleted_at
              ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => backend.saveAirframe(map.id, body(edit, { deleted: false })))}>Restore</button>
              : <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => backend.saveAirframe(map.id, body(edit, { deleted: true }))).then((ok) => ok && setEdit(null))}>Delete</button>)}
          </div>
        </>
      ) : <p className="tip">Pick an airframe to edit, start from a real aircraft, or make a new one.</p>}
    />
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function Roles({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const { roles, airframes } = useEd((s) => s.air!);
  const [edit, setEdit] = useState<AirRole | null>(null);
  const save = (extra: Record<string, unknown> = {}) => edit && void run(async () => {
    const { id, deleted_at: _d, ...rest } = edit;
    const nid = await backend.saveAirRole(map.id, { ...rest, ...(id ? { id } : {}), name: edit.name.trim(), ...extra });
    setEdit(extra.deleted ? null : { ...edit, id: nid });
  });
  return (
    <Split
      list={(
        <>
          <button type="button" className="btn primary" onClick={() => setEdit({ id: '', name: '', is_tanker: false, payload_penalty: 0.4, sort: roles.length, deleted_at: null })}>New role</button>
          <ul className="changes">
            {roles.map((r) => (
              <li key={r.id} className={`${edit?.id === r.id ? 'on' : ''}${r.deleted_at ? ' off' : ''}`}>
                <div className="row" role="button" tabIndex={0} onClick={() => setEdit({ ...r })} onKeyDown={(e) => e.key === 'Enter' && setEdit({ ...r })}>
                  <span><strong>{r.name}</strong> <small>{r.is_tanker ? 'refuels others · ' : ''}payload penalty {r.payload_penalty} · {airframes.filter((a) => a.role_id === r.id && !a.deleted_at).length} airframes</small></span>
                </div>
              </li>
            ))}
          </ul>
          <p className="tip">A role labels an airframe and gives new airframes of it a payload penalty. A tanker role makes its squadrons project a refuel circle.</p>
        </>
      )}
      form={edit ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name}` : 'New role'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={40} placeholder="e.g. Electronic warfare" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Payload penalty for new airframes (0.4 = −40% radius fully loaded)" wide>
            <input type="number" min={0} max={1} step={0.05} value={edit.payload_penalty} onChange={(e) => setEdit({ ...edit, payload_penalty: num(e.target.value, 0, 1) })} />
          </Field>
          <label className="check"><input type="checkbox" checked={edit.is_tanker} onChange={(e) => setEdit({ ...edit, is_tanker: e.target.checked })} /> Tanker: its squadrons refuel others in their circle</label>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => save()}>Save</button>
            {edit.id && <button type="button" className="btn danger" disabled={busy} onClick={() => save({ deleted: true })}>Delete</button>}
          </div>
        </>
      ) : <p className="tip">Pick a role to edit.</p>}
    />
  );
}

// ---------------------------------------------------------------------------
// Missiles: families and tiers
// ---------------------------------------------------------------------------

const GUIDANCES: AirGuidance[] = ['radar', 'ir', 'harm', 'agm', 'none'];
const DEFAULT_TARGETS: Record<AirGuidance, AirWeapon['targets']> = { radar: ['air'], ir: ['air'], harm: ['radar'], agm: ['ground'], none: ['ground'] };

function Missiles({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const { families, weapons } = useEd((s) => s.air!);
  const [fam, setFam] = useState<AirFamily | null>(null);
  const [edit, setEdit] = useState<AirWeapon | null>(null);
  const live = families.filter((f) => !f.deleted_at);
  const tiersOf = (f: AirFamily) => weapons.filter((w) => w.family_id === f.id && !w.deleted_at).sort((a, b) => a.tier - b.tier);
  const set = (p: Partial<AirWeapon>) => edit && setEdit({ ...edit, ...p });
  const newTier = (f: AirFamily) => {
    const top = Math.max(0, ...tiersOf(f).map((w) => w.tier));
    const prev = tiersOf(f).at(-1);
    setEdit({ id: '', family_id: f.id, tier: top + 1, name: `${f.name}-${top + 1}`, guidance: f.guidance, accuracy: prev?.accuracy ?? 70, range_m: prev?.range_m ?? 50000,
      damage: prev?.damage ?? 100, ap: prev?.ap ?? 10, weight: prev?.weight ?? 150, slots: prev?.slots ?? 1, targets: prev?.targets ?? DEFAULT_TARGETS[f.guidance],
      tech_item_id: null, research_cost: top === 0 ? 0 : 10, release_turn: null, deleted_at: null });
    setFam(null);
  };
  const saveW = async (extra: Record<string, unknown> = {}) => {
    if (!edit) return;
    const { id, tech_item_id: _t, deleted_at: _d, ...rest } = edit;
    let nid = '';
    if (await run(async () => (nid = await backend.saveAirWeapon(map.id, { ...rest, ...(id ? { id } : {}), name: edit.name.trim(), ...extra })))) setEdit(extra.deleted ? null : { ...edit, id: nid });
  };
  return (
    <Split
      list={(
        <>
          <div className="row2 wrap">
            {live.length === 0 && <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => backend.seedAirFamilies(map.id))}>Add IR, ARH, HARM and AGM families</button>}
            {live.length > 0 && weapons.filter((w) => !w.deleted_at).length === 0 && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void run(async () => {
                for (const p of MISSILE_PRESETS) {
                  const fam = live.find((f) => f.name === p.family);
                  if (!fam) continue;
                  const { family: _f, ...rest } = p;
                  await backend.saveAirWeapon(map.id, { ...rest, family_id: fam.id });
                }
              })}>Add real-world missiles (AIM-9, AIM-120, HARM, Maverick, JASSM)</button>
            )}
            <button type="button" className="btn" onClick={() => (setFam({ id: '', name: '', guidance: 'radar', color: '#0a84ff', sort: live.length, deleted_at: null }), setEdit(null))}>New family</button>
          </div>
          {live.map((f) => (
            <div key={f.id} className="setgrp">
              <header className="row2 wrap">
                <h4><i className="chip" style={{ background: f.color ?? '#8794a4' }} aria-hidden /> {f.name}</h4>
                <small>{GUIDANCE_TEXT[f.guidance]}</small>
                <button type="button" className="btn sm" onClick={() => (setFam({ ...f }), setEdit(null))}>Edit family</button>
              </header>
              <div className="chain">
                {tiersOf(f).map((w, i) => (
                  <span key={w.id} className="chain">
                    {i > 0 && <span aria-hidden>→</span>}
                    <button type="button" className={`btn sm${edit?.id === w.id ? ' on' : ''}`} onClick={() => (setEdit({ ...w }), setFam(null))}>
                      T{w.tier} {w.name}<small>{w.research_cost ? ` · ${w.research_cost} RP` : ' · free'}</small>
                    </button>
                  </span>
                ))}
                <button type="button" className="btn sm" onClick={() => newTier(f)}>+ tier</button>
              </div>
            </div>
          ))}
          <p className="tip">
            Each tier is a node in the missile tree (Tech &gt; Tech tree &gt; Missiles), created and kept in step from here: same name, research cost and release
            turn, and it needs the tier below. Researched tiers stay usable, also on aircraft already in service, if the airframe carries the family.
          </p>
        </>
      )}
      form={fam ? (
        <>
          <h4>{fam.id ? `Edit ${fam.name}` : 'New family'}</h4>
          <Field label="Name" wide><input value={fam.name} maxLength={40} placeholder="e.g. SRAAM" onChange={(e) => setFam({ ...fam, name: e.target.value })} /></Field>
          <Field label="Guidance (sets the default for its tiers)" wide>
            <select value={fam.guidance} onChange={(e) => setFam({ ...fam, guidance: e.target.value as AirGuidance })}>{GUIDANCES.map((g) => <option key={g} value={g}>{g}: {GUIDANCE_TEXT[g]}</option>)}</select>
          </Field>
          <Field label="Colour" wide><input type="color" value={fam.color ?? '#8794a4'} onChange={(e) => setFam({ ...fam, color: e.target.value })} /></Field>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !fam.name.trim()} onClick={() => void run(async () => { const { id, deleted_at: _d, ...rest } = fam; const nid = await backend.saveAirFamily(map.id, { ...rest, ...(id ? { id } : {}) }); setFam({ ...fam, id: nid }); })}>Save</button>
            {fam.id && <button type="button" className="btn danger" disabled={busy} onClick={() => confirm(`Delete the ${fam.name} family?`) && void run(() => backend.saveAirFamily(map.id, { ...fam, deleted: true })).then((ok) => ok && setFam(null))}>Delete</button>}
          </div>
        </>
      ) : edit ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name}` : 'New tier'} <small>· {families.find((f) => f.id === edit.family_id)?.name} tier {edit.tier}</small></h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="row2">
            <Field label="Research cost (RP; 0 = free)"><input type="number" min={0} value={edit.research_cost ?? 0} onChange={(e) => set({ research_cost: Math.round(num(e.target.value)) })} /></Field>
            <Field label="Released on turn (blank = start)"><input type="number" min={1} value={edit.release_turn ?? ''} onChange={(e) => set({ release_turn: e.target.value ? Math.round(num(e.target.value, 1)) : null })} /></Field>
          </div>
          <Field label="Guidance" wide>
            <select value={edit.guidance} onChange={(e) => set({ guidance: e.target.value as AirGuidance, targets: DEFAULT_TARGETS[e.target.value as AirGuidance] })}>{GUIDANCES.map((g) => <option key={g} value={g}>{g}: {GUIDANCE_TEXT[g]}</option>)}</select>
          </Field>
          <Field label="Targets" wide>
            <span className="inline">
              {(['air', 'ground', 'ship', 'radar'] as const).map((t) => (
                <label key={t} className="check"><input type="checkbox" checked={edit.targets.includes(t)} onChange={(e) => set({ targets: e.target.checked ? [...edit.targets, t] : edit.targets.filter((x) => x !== t) })} /> {TARGET_TEXT[t]}</label>
              ))}
            </span>
          </Field>
          <div className="row2">
            <Field label="Accuracy (%)"><input type="number" min={0} max={100} value={edit.accuracy} onChange={(e) => set({ accuracy: num(e.target.value, 0, 100) })} /></Field>
            <Field label="Range (km)"><input type="number" min={0} step="any" value={km(edit.range_m)} onChange={(e) => set({ range_m: num(e.target.value) * 1000 })} /></Field>
          </div>
          <div className="row2">
            <Field label="Damage per hit"><input type="number" min={0} value={edit.damage} onChange={(e) => set({ damage: num(e.target.value) })} /></Field>
            <Field label="AP (vs ground armor)"><input type="number" min={0} value={edit.ap} onChange={(e) => set({ ap: num(e.target.value) })} /></Field>
          </div>
          <div className="row2">
            <Field label="Weight (kg)"><input type="number" min={0} value={edit.weight} onChange={(e) => set({ weight: num(e.target.value) })} /></Field>
            <Field label="Hardpoints it takes"><input type="number" min={1} value={edit.slots} onChange={(e) => set({ slots: Math.round(num(e.target.value, 1, 20)) })} /></Field>
          </div>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim() || !edit.targets.length} onClick={() => void saveW()}>Save</button>
            {edit.id && <button type="button" className="btn danger" disabled={busy} onClick={() => confirm(`Delete ${edit.name}? It leaves the tech tree and every loadout.`) && void saveW({ deleted: true })}>Delete</button>}
          </div>
        </>
      ) : <p className="tip">Pick a family or a tier to edit. Start with the standard families, then add tiers to each.</p>}
    />
  );
}

// ---------------------------------------------------------------------------
// Countermeasures: every number that fights a hit chance, in one table
// ---------------------------------------------------------------------------

function Countermeasures({ backend, map, run }: { backend: Backend; map: MapMeta; run: Run }) {
  const { airframes } = useEd((s) => s.air!);
  const combat = useEd((s) => s.combat);
  const cell = (v: number, save: (n: number) => Promise<unknown>) => (
    <input type="number" min={0} max={100} key={v} defaultValue={v} onBlur={(e) => num(e.target.value, 0, 100) !== v && void run(() => save(num(e.target.value, 0, 100)))} />
  );
  const saveAf = (a: Airframe, p: Partial<Airframe>) => { const { deleted_at: _d, ...rest } = a; return backend.saveAirframe(map.id, { ...rest, ...p }); };
  const aaWeapons = (combat?.weapons ?? []).filter((w) => w.anti_air && !w.deleted_at);
  const saveW = (w: (typeof aaWeapons)[number], p: Record<string, unknown>) => { const { deleted_at: _d, ...rest } = w; return backend.saveWeapon(map.id, { ...rest, ...p }); };
  return (
    <>
      <p className="tip">
        Hit chance = weapon accuracy − the target's countermeasure for that guidance, kept between the hit clamp limits (Settings). Radar-guided vs ECM/chaff,
        IR vs flares, guns vs manoeuvrability, AGMs vs a ground unit's active protection. HARMs only lock on emitting radar AA.
      </p>
      <h4>Aircraft</h4>
      <table className="matrix">
        <thead><tr><th>Airframe</th><th>ECM / chaff (vs radar)</th><th>Flares (vs IR)</th><th>Manoeuvre (vs guns)</th><th>Gun accuracy</th></tr></thead>
        <tbody>
          {airframes.filter((a) => !a.deleted_at).map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{cell(a.ecm, (n) => saveAf(a, { ecm: n }))}</td>
              <td>{cell(a.flares, (n) => saveAf(a, { flares: n }))}</td>
              <td>{cell(a.maneuver, (n) => saveAf(a, { maneuver: n }))}</td>
              <td>{cell(a.gun_accuracy, (n) => saveAf(a, { gun_accuracy: n }))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Anti-air weapons (ground)</h4>
      {aaWeapons.length === 0 ? <p className="empty">None yet. In Combat &gt; Weapons, tick "Anti-air" on a weapon.</p> : (
        <table className="matrix">
          <thead><tr><th>Weapon</th><th>Guidance</th><th>Accuracy</th><th>Damage per hit</th><th>Shots per strike</th></tr></thead>
          <tbody>
            {aaWeapons.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>{w.guidance}{w.guidance === 'radar' ? ' (halved when dark)' : ''}</td>
                <td>{cell(w.accuracy ?? 0, (n) => saveW(w, { accuracy: n }))}</td>
                <td>{cell(w.air_damage ?? 0, (n) => saveW(w, { air_damage: n }))}</td>
                <td>{cell(w.air_shots ?? 0, (n) => saveW(w, { air_shots: Math.round(n) }))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Active protection (ground units, vs AGMs)</h4>
      <table className="matrix">
        <thead><tr><th>Unit template</th><th>Active protection</th></tr></thead>
        <tbody>
          {(combat?.templates ?? []).filter((t) => !t.deleted_at && t.category === 'ground').map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{cell(t.aps ?? 0, (n) => { const { deleted_at: _d, ...rest } = t; return backend.saveUnitTemplate(map.id, { ...rest, aps: n }); })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function AirSettingsTab({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const combat = useEd((s) => s.combat);
  const base = { ...DEFAULT_SETTINGS, ...combat?.settings };
  const [s, setS] = useState<CombatSettings>(base);
  useEffect(() => setS({ ...DEFAULT_SETTINGS, ...combat?.settings }), [combat?.settings]);
  type NumKey = Exclude<keyof CombatSettings, 'terrain' | 'terrain_min_km2' | 'parting_round' | 'remove_destroyed' | 'tankers_refuel_tankers'>;
  const f = (label: string, k: NumKey) => (
    <Field label={label} wide><input type="number" min={0} step="any" value={s[k] as number} onChange={(e) => setS({ ...s, [k]: num(e.target.value, 0, 1e6) })} /></Field>
  );
  const keys = ['hit_min', 'hit_max', 'dark_penalty', 'mutual_support_km', 'refuel_radius_km', 'refuel_per_aircraft', 'tankers_refuel_tankers', 'land_snap_km',
    'grounded_turns', 'return_salvo'] as const;
  const dirty = keys.some((k) => s[k] !== base[k]);
  return (
    <>
      <p className="tip">Air numbers, versioned with the other combat settings: they apply from turn {combat?.turn ?? 1} on; earlier turns keep theirs. The payload penalty is per airframe.</p>
      <div className="kv">
        <div className="setgrp"><h4>Hit chance</h4>{f('Never below (%)', 'hit_min')}{f('Never above (%)', 'hit_max')}{f('Dark radar AA accuracy ×', 'dark_penalty')}</div>
        <div className="setgrp"><h4>Air-to-air</h4>{f('Mutual support: friends within (km) join the defence', 'mutual_support_km')}{f('Return fire: missiles per aircraft per phase (default)', 'return_salvo')}</div>
        <div className="setgrp"><h4>Tankers</h4>{f('Refuel circle (km)', 'refuel_radius_km')}{f('Squadrons refuelled per tanker aircraft', 'refuel_per_aircraft')}
          <label className="check"><input type="checkbox" checked={s.tankers_refuel_tankers} onChange={(e) => setS({ ...s, tankers_refuel_tankers: e.target.checked })} /> Tankers can refuel other tankers</label></div>
        <div className="setgrp"><h4>Bases</h4>{f('Landing: ends within (km) of a base', 'land_snap_km')}{f('Forced return grounds it for (turns)', 'grounded_turns')}</div>
      </div>
      <button type="button" className="btn primary" disabled={busy || !dirty} onClick={() => void run(() => backend.saveCombatSettings(map.id, Object.fromEntries(keys.map((k) => [k, s[k]]))))}>Save from turn {combat?.turn ?? 1}</button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export function AirShotTable({ phase, onEdit, busy }: { phase: AirPhase; onEdit?(key: string, v: number | null, computed: number): void; busy?: boolean }) {
  if (!phase.shots.length) return <p className="tip">{phase.label}: no shots.</p>;
  const hits = phase.shots.filter((x) => x.final > 0).length;
  return (
    <table className="shots">
      <caption><small>{phase.label} · {hits} of {phase.shots.length} hit</small></caption>
      <thead><tr><th>Shot</th><th>Hit chance</th><th>Roll</th><th>Damage</th></tr></thead>
      <tbody>
        {phase.shots.map((s: AirShot) => (
          <tr key={s.key} className={s.edited ? 'edited' : ''}>
            <td>{s.shooter_name} <small className="mults">({s.weapon})</small> → {s.target_name}{s.mults.length > 0 && <><br /><small className="mults">{s.mults.map(([n, v]) => `${n} ×${+v.toFixed(2)}`).join(' · ')}</small></>}</td>
            <td className="num">{s.accuracy.toFixed(0)} − {s.countermeasure.toFixed(0)} = {s.hit_pct.toFixed(0)}%</td>
            <td className="num">{s.roll.toFixed(1)} {s.hit ? '✓' : '✗'}</td>
            <td className="num">
              {onEdit ? (
                <input type="number" min={0} disabled={busy} key={`${s.key}:${s.final}`} defaultValue={s.final} aria-label={`Damage of ${s.shooter_name} ${s.weapon} on ${s.target_name}`}
                  title={s.edited ? `Hand-edited (computed ${s.computed})` : 'Type a number to override (0 = miss)'}
                  onBlur={(e) => { const v = Math.max(0, Math.round(+e.target.value)); if (v !== s.final) onEdit(s.key, v === s.computed ? null : v, s.computed); }} />
              ) : <strong>{s.final}</strong>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Side = { af: string; n: number; loadout: LoadoutEntry[] };

function SideForm({ label, side, set }: { label: string; side: Side; set(v: Side): void }) {
  const { airframes } = useEd((s) => s.air!);
  const weapons = useLoadoutWeapons();
  const frame = airframes.find((a) => a.id === side.af);
  return (
    <div className="setgrp">
      <h4>{label}</h4>
      <div className="row2">
        <select value={side.af} onChange={(e) => set({ ...side, af: e.target.value, loadout: [] })} aria-label={`${label} airframe`}>{airframes.filter((a) => !a.deleted_at).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <Field label="Aircraft"><input type="number" min={1} value={side.n} onChange={(e) => set({ ...side, n: Math.round(num(e.target.value, 1, 100)) })} /></Field>
      </div>
      {frame && <LoadoutEditor frame={frame} weapons={forFrame(weapons, frame.families)} value={side.loadout} onChange={(loadout) => set({ ...side, loadout })} penalty={frame.payload_penalty} />}
    </div>
  );
}

function AirSandbox() {
  const air = useEd((s) => s.air!);
  const combat = useEd((s) => s.combat);
  const s: CombatSettings = { ...DEFAULT_SETTINGS, ...combat?.settings };
  const first = air.airframes.find((a) => !a.deleted_at)?.id ?? '';
  const [mode, setMode] = useState<'a2a' | 'strike'>('a2a');
  const [A, setA] = useState<Side>({ af: first, n: 4, loadout: [] });
  const [B, setB] = useState<Side>({ af: first, n: 4, loadout: [] });
  const [distKm, setDist] = useState(60);
  const [ret, setRet] = useState(s.return_salvo);
  const [tpl, setTpl] = useState(combat?.templates.find((t) => t.category === 'ground')?.id ?? '');
  const [terrain, setTerrain] = useState<'open' | 'urban' | 'forest'>('open');
  const [emit, setEmit] = useState(true);
  const [salt, setSalt] = useState(newSalt());
  if (!first) return <p className="empty">Make an airframe first.</p>;
  // B sits distKm east of A on the equator (111.32 km per degree).
  const at: Pos = [distKm / 111.32, 0];
  const weaponsIn = (side: Side): AirWeaponIn[] => side.loadout.map((e) => {
    const w = air.weapons.find((x) => x.id === e.weapon)!;
    return { id: w.id, name: w.name, tier: w.tier, guidance: w.guidance, accuracy: w.accuracy, range_m: w.range_m, damage: w.damage, ap: w.ap, weight: w.weight, slots: w.slots, targets: w.targets, count: e.count };
  });
  const unitIn = (side: Side, id: string, sideName: string, pos: Pos, target: string | null, kinds: AirGuidance[]): AirUnitIn => {
    const af = air.airframes.find((a) => a.id === side.af)!;
    const loadout = weaponsIn(side);
    // The attacker fires everything it carries that fits the target: no salvo limit.
    const salvo = loadout.filter((w) => kinds.includes(w.guidance)).map((w) => ({ weapon: w.id, count: w.count * side.n }));
    return { id, name: `${af.name} (${sideName})`, owner: sideName, side: sideName, airframe: { ...(af as unknown as AirframeIn), tanker: !!af.tanker }, pos, moved: true, landed_at: null,
      aircraft: side.n, max: side.n, damage: 0, loadout, ammo: {}, radius_m: 1e9, attacks: target && salvo.length ? [{ target, weapons: salvo }] : target ? [{ target, weapons: [] }] : [],
      return_salvo: ret, refuel_priority: [], grounded: false };
  };
  let phases: AirPhase[] = [];
  let summary = '';
  const t = combat?.templates.find((x) => x.id === tpl);
  const units: UnitIn[] = [];
  if (mode === 'strike' && t) {
    const ws = combat?.weapons ?? [];
    units.push({
      id: 'target', name: t.name, owner: 'B', side: 'B', template: { id: t.id, name: t.name, max_strength: t.max_strength, armor: t.armor, category: 'ground', aps: t.aps ?? 0 },
      weapons: t.weapon_ids.map((wid, slot) => { const w = ws.find((x) => x.id === wid); return w ? { slot, id: w.id, name: w.name, attacks: w.attacks, ap: w.ap, range_m: w.range_m, indirect: w.indirect,
        anti_air: w.anti_air, guidance: w.guidance, accuracy: w.accuracy, air_damage: w.air_damage, air_shots: w.air_shots } : null; }).filter((w): w is NonNullable<typeof w> => !!w),
      start: at, pos: at, moved: false, heading: null, strength: t.max_strength, experience: 0, stationary_turns: 0, terrain, new: false, retreat: false, attacks: [], emit,
    });
  }
  const sq = mode === 'a2a'
    ? [unitIn(A, 'a', 'A', [0, 0], 'b', ['radar', 'ir']), unitIn(B, 'b', 'B', at, null, [])]
    : [unitIn(A, 'a', 'A', [0, 0], t ? 'target' : null, ['agm', 'harm', 'none'])];
  const r = resolveCombat({ map_id: 'sandbox', turn: 1, settings: s, units, engagements: [], air_units: sq }, { salt, salts: {}, edits: {} });
  phases = (r.air?.log.packages ?? []).flatMap((p) => p.phases.map((ph) => ({ ...ph, label: `${p.label}: ${ph.label}` })));
  const out = (id: string) => r.air?.squadrons.find((x) => x.id === id);
  if (mode === 'a2a') summary = `A: ${out('a')?.after} of ${A.n} left · B: ${out('b')?.after} of ${B.n} left`;
  else if (t) {
    const st = r.air?.strikes[0];
    summary = `${t.name}: ${Math.round(r.units[0].after)} of ${t.max_strength} strength left${st?.aborted ? ` (${st.aborted})` : ''} · strike aircraft: ${out('a')?.after} of ${A.n} left`;
  }
  return (
    <>
      <div className="row2 wrap">
        <div className="seg" role="group" aria-label="Sandbox mode">
          <button type="button" className={mode === 'a2a' ? 'on' : ''} onClick={() => setMode('a2a')}>Air-to-air</button>
          <button type="button" className={mode === 'strike' ? 'on' : ''} onClick={() => setMode('strike')}>Strike vs ground / AA</button>
        </div>
        <Field label="Distance between them (km)"><input type="number" min={0} value={distKm} onChange={(e) => setDist(num(e.target.value, 0, 5000))} /></Field>
        <button type="button" className="btn" onClick={() => setSalt(newSalt())}>Roll again</button>
      </div>
      <div className="sandbox">
        <SideForm label={mode === 'a2a' ? 'Attacker (fires everything it carries)' : 'Strike (fires everything that hits the ground)'} side={A} set={setA} />
        {mode === 'a2a' ? (
          <div>
            <SideForm label="Defender" side={B} set={setB} />
            <Field label="Defender's return fire (missiles per aircraft per phase)"><input type="number" min={0} max={50} value={ret} onChange={(e) => setRet(Math.round(num(e.target.value, 0, 50)))} /></Field>
          </div>
        ) : (
          <div className="setgrp">
            <h4>Target</h4>
            <select value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Target template">{(combat?.templates ?? []).filter((x) => x.category === 'ground' && !x.deleted_at).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <Field label="Terrain" wide><select value={terrain} onChange={(e) => setTerrain(e.target.value as typeof terrain)}><option value="open">open</option><option value="urban">urban</option><option value="forest">forest</option></select></Field>
            <label className="check"><input type="checkbox" checked={emit} onChange={(e) => setEmit(e.target.checked)} /> Its radar AA is emitting (HARMs can lock; full accuracy)</label>
            <p className="tip">Its AA weapons fire if the strike ends within their range. Its active protection counts against AGMs. Weapons out of range at this distance do not fire.</p>
          </div>
        )}
      </div>
      <p className="points"><span>{summary}</span></p>
      {phases.length === 0 && <p className="empty">No shots: give the aircraft weapons that fit this fight and reach at this distance.</p>}
      {phases.map((p, i) => <AirShotTable key={i} phase={p} />)}
      {(r.air?.log.notes ?? []).map((n, i) => <p key={i} className="tip">{n.name}: {n.text}</p>)}
      <p className="tip">Same engine and settings as the real turn. Detection: radar range × the other side's signature. Nothing here is saved.</p>
    </>
  );
}
