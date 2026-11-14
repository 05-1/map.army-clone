// The owner's air admin: squadrons (create, assign, rebase, loadout), airframes, missile families and
// tiers (each tier is a research node in the tech tree, kept in step automatically), every countermeasure
// in one table, air settings, and a shot-by-shot air sandbox. Every save calls an owner-only RPC.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { airFight, alive, squadronState, type AirframeIn, type AirPhase, type AirShot, type AirWeaponIn, type Roller, type SquadronIn } from '../lib/air';
import { DEFAULT_SETTINGS, newSalt, rand01, resolveCombat, type CombatSettings } from '../lib/combat';
import { symbolDataUrl } from '../lib/images';
import { GUIDANCE_TEXT, LoadoutEditor, TARGET_TEXT, type LoadoutWeapon } from '../lib/Loadout';
import type { Airframe, AirFamily, AirGuidance, AirWeapon, LoadoutEntry, MapMeta, Squadron } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, IconButton } from './ui';

export type AirTab = 'squadrons' | 'airframes' | 'weapons' | 'cm' | 'settings' | 'sandbox';
const TABS: [AirTab, string][] = [['squadrons', 'Squadrons'], ['airframes', 'Airframes'], ['weapons', 'Missiles'], ['cm', 'Countermeasures'], ['settings', 'Settings'], ['sandbox', 'Sandbox']];

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;
const num = (v: string, lo = 0, hi = 1e9) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));
const km = (m: number) => +(m / 1000).toFixed(1);

export function AirDialog({ backend, map, tab: first = 'squadrons', refresh, onClose }: { backend: Backend; map: MapMeta; tab?: AirTab; refresh(): Promise<void>; onClose(): void }) {
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
            {tab === 'squadrons' && <Squadrons backend={backend} map={map} busy={busy} run={run} goTo={setTab} />}
            {tab === 'airframes' && <Airframes backend={backend} map={map} busy={busy} run={run} />}
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
    return { id: w.id, name: w.name, family: f?.name ?? '?', family_color: f?.color ?? null, tier: w.tier, guidance: w.guidance, range_m: w.range_m,
      weight: w.weight, slots: w.slots, targets: w.targets, unlocked: true };
  }).sort((a, b) => a.family.localeCompare(b.family) || a.tier - b.tier), [air]);
}

const usePenalty = () => useEd((s) => s.combat?.settings.radius_penalty ?? DEFAULT_SETTINGS.radius_penalty);

// ---------------------------------------------------------------------------
// Squadrons
// ---------------------------------------------------------------------------

function Squadrons({ backend, map, busy, run, goTo }: { backend: Backend; map: MapMeta; busy: boolean; run: Run; goTo(t: AirTab): void }) {
  const { squadrons, airframes, bases } = useEd((s) => s.air!);
  const players = useEd((s) => s.players);
  const weapons = useLoadoutWeapons();
  const penalty = usePenalty();
  const [edit, setEdit] = useState<Squadron | null>(null);
  const set = (p: Partial<Squadron>) => edit && setEdit({ ...edit, ...p });
  const frame = airframes.find((a) => a.id === edit?.airframe_id);
  const who = (id: string | null) => players.find((p) => p.id === id)?.name ?? 'unassigned';
  const startNew = () => {
    const a = airframes.find((x) => !x.deleted_at);
    if (a) setEdit({ id: '', name: '', owner_player_id: null, airframe_id: a.id, base_feature_id: bases[0]?.id ?? null, aircraft: a.squadron_size, max_aircraft: a.squadron_size, damage: 0, loadout: [], radius_m: a.radius_m, weight: 0 });
  };
  const save = async () => {
    if (!edit) return;
    const { id, radius_m: _r, weight: _w, ...rest } = edit;
    let nid = '';
    if (await run(async () => (nid = await backend.saveSquadron(map.id, { ...rest, ...(id ? { id } : {}), name: edit.name.trim() })))) setEdit({ ...edit, id: nid });
  };
  const groups: { title: string; list: Squadron[] }[] = [
    ...bases.map((b) => ({ title: `${b.name} · ${who(b.owner)} · ${b.used}/${b.capacity} squadrons`, list: squadrons.filter((q) => q.base_feature_id === b.id) })),
    { title: 'Stranded (no base)', list: squadrons.filter((q) => !q.base_feature_id) },
  ].filter((g) => g.list.length || !g.title.startsWith('Stranded'));
  return (
    <Split
      list={(
        <>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={!airframes.some((a) => !a.deleted_at)} onClick={startNew}>New squadron</button>
            {!airframes.length && <button type="button" className="btn" onClick={() => goTo('airframes')}>Make an airframe first</button>}
          </div>
          {bases.length === 0 && (
            <p className="note">No airbases yet. In Combat &gt; Unit templates, give a template an <strong>air capacity</strong> (how many squadrons it can base) and place a unit with it.</p>
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
                        <span><strong>{q.name}</strong> <small>{a?.name} · {q.aircraft}/{q.max_aircraft} aircraft · {who(q.owner_player_id)} · radius {km(q.radius_m)} km</small></span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="tip">Players raise new squadrons by buying a tech-tree item of kind "Squadron" at their airbase, and buy replacement aircraft for their squadrons. Changing the base here rebases a squadron (also a stranded one).</p>
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
              <select value={edit.airframe_id} onChange={(e) => set({ airframe_id: e.target.value, loadout: [] })}>
                {airframes.filter((a) => !a.deleted_at || a.id === edit.airframe_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Base" wide>
            <select value={edit.base_feature_id ?? ''} onChange={(e) => set({ base_feature_id: e.target.value || null })}>
              <option value="">None (stranded: cannot fly)</option>
              {bases.map((b) => <option key={b.id} value={b.id}>{b.name} ({who(b.owner)}, {b.used}/{b.capacity})</option>)}
            </select>
          </Field>
          <div className="row2">
            <Field label="Aircraft"><input type="number" min={0} value={edit.aircraft} onChange={(e) => set({ aircraft: Math.round(num(e.target.value, 0, 100)) })} /></Field>
            <Field label="Full strength"><input type="number" min={1} value={edit.max_aircraft} onChange={(e) => set({ max_aircraft: Math.round(num(e.target.value, 1, 100)) })} /></Field>
          </div>
          <Field label={`Damage carried (below one aircraft's ${frame.hp} HP)`} wide><input type="number" min={0} value={edit.damage} onChange={(e) => set({ damage: num(e.target.value) })} /></Field>
          <h4>Loadout</h4>
          <LoadoutEditor frame={frame} weapons={weapons} value={edit.loadout} onChange={(loadout: LoadoutEntry[]) => set({ loadout })} penalty={penalty} />
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void save()}>Save</button>
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

const BLANK_AF: Airframe = { id: '', name: '', hp: 100, hardpoints: 6, max_payload: 6000, radius_m: 600000, radar_m: 100000, signature: 1, ecm: 20, flares: 20, maneuver: 20,
  gun_accuracy: 40, gun_damage: 40, gun_range_m: 1500, squadron_size: 12, cost_per_aircraft: 10, asset_id: null, sidc: 'SFAPMF---------', deleted_at: null };

function Airframes({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const { airframes } = useEd((s) => s.air!);
  const penalty = usePenalty();
  const [edit, setEdit] = useState<Airframe | null>(null);
  const set = (p: Partial<Airframe>) => edit && setEdit({ ...edit, ...p });
  const body = (a: Airframe, extra: Record<string, unknown> = {}) => {
    const { id, deleted_at: _d, ...rest } = a;
    return { ...rest, ...(id ? { id } : {}), name: a.name.trim(), ...extra };
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
          <button type="button" className="btn primary" onClick={() => setEdit({ ...BLANK_AF })}>New airframe</button>
          {airframes.length === 0 && <p className="empty">No airframes yet: an airframe is an aircraft type (F-16, Su-27, …).</p>}
          <ul className="changes">
            {airframes.map((a) => (
              <li key={a.id} className={`${edit?.id === a.id ? 'on' : ''}${a.deleted_at ? ' off' : ''}`}>
                <div className="row" role="button" tabIndex={0} onClick={() => setEdit({ ...a })} onKeyDown={(e) => e.key === 'Enter' && setEdit({ ...a })}>
                  {a.sidc && <img className="mini" src={symbolDataUrl(a.sidc, 20)} alt="" />}
                  <span><strong>{a.name}</strong> <small>{a.hardpoints} hardpoints · {Math.round(a.max_payload)} kg · {km(a.radius_m)} km radius · radar {km(a.radar_m)} km · RCS ×{a.signature}</small></span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      form={edit ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name || 'airframe'}` : 'New airframe'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} placeholder="e.g. F-16C" onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="setgrp"><h4>Airframe</h4><div className="row2">{f('HP per aircraft', 'hp')}{f('Squadron size', 'squadron_size', { step: 1 })}</div>
            {f('SP per replacement aircraft', 'cost_per_aircraft', { step: 1 })}</div>
          <div className="setgrp"><h4>Payload and range</h4><div className="row2">{f('Hardpoints', 'hardpoints', { step: 1 })}{f('Max payload (kg)', 'max_payload')}</div>
            {f('Combat radius, empty (km)', 'radius_m', { scale: 1000 })}
            <small className="note">Fully loaded: {km(edit.radius_m * (1 - penalty))} km (radius × (1 − {penalty} × payload ÷ max payload)).</small></div>
          <div className="setgrp"><h4>Sensors</h4><div className="row2">{f('Radar range (km)', 'radar_m', { scale: 1000 })}{f('Signature (RCS ×; stealth is low)', 'signature', { hint: 'Enemies detect it at their radar range × this' })}</div></div>
          <div className="setgrp"><h4>Countermeasures (percentage points off the enemy's hit chance)</h4>
            <div className="row2">{f('ECM / chaff vs radar', 'ecm')}{f('Flares vs IR', 'flares')}</div>{f('Manoeuvrability vs guns', 'maneuver')}</div>
          <div className="setgrp"><h4>Gun</h4><div className="row2">{f('Accuracy', 'gun_accuracy')}{f('Damage per hit', 'gun_damage')}</div>{f('Range (km)', 'gun_range_m', { scale: 1000 })}</div>
          <Field label="NATO symbol (SIDC)" wide><input value={edit.sidc ?? ''} spellCheck={false} onChange={(e) => set({ sidc: e.target.value.toUpperCase().trim() || null })} /></Field>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void run(async () => { const id = await backend.saveAirframe(map.id, body(edit)); setEdit({ ...edit, id }); })}>Save</button>
            {edit.id && <button type="button" className="btn" onClick={() => setEdit({ ...edit, id: '', name: `${edit.name} (copy)`, deleted_at: null })}>Clone</button>}
            {edit.id && (edit.deleted_at
              ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => backend.saveAirframe(map.id, body(edit, { deleted: false })))}>Restore</button>
              : <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => backend.saveAirframe(map.id, body(edit, { deleted: true }))).then((ok) => ok && setEdit(null))}>Delete</button>)}
          </div>
        </>
      ) : <p className="tip">Pick an airframe to edit, or make a new one. Squadrons and tech-tree squadron items use them.</p>}
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
            Each tier is a node in the tech tree (Tech &gt; Tech tree), created and kept in step from here: same name, research cost and release turn, and it needs
            the tier below. Researched tiers stay usable. Loadouts are free; missiles refill every mission.
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
  const f = (label: string, k: keyof CombatSettings) => (
    <Field label={label} wide><input type="number" min={0} step="any" value={s[k] as number} onChange={(e) => setS({ ...s, [k]: num(e.target.value, 0, 1e6) })} /></Field>
  );
  const keys = ['hit_min', 'hit_max', 'radius_penalty', 'dark_penalty', 'patrol_radius_km', 'patrol_radius_max_km', 'recon_radius_km'] as const;
  const dirty = keys.some((k) => s[k] !== base[k]);
  return (
    <>
      <p className="tip">Air numbers, versioned with the other combat settings: they apply from turn {combat?.turn ?? 1} on; earlier turns keep theirs.</p>
      <div className="kv">
        <div className="setgrp"><h4>Hit chance</h4>{f('Never below (%)', 'hit_min')}{f('Never above (%)', 'hit_max')}</div>
        <div className="setgrp"><h4>Range and radar</h4>{f('Radius penalty at full payload (0.4 = −40%)', 'radius_penalty')}{f('Dark radar AA accuracy ×', 'dark_penalty')}</div>
        <div className="setgrp"><h4>Missions</h4>{f('Patrol circle, default (km)', 'patrol_radius_km')}{f('Patrol circle, largest (km)', 'patrol_radius_max_km')}{f('Recon reveals within (km)', 'recon_radius_km')}</div>
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

function SideForm({ label, side, set }: { label: string; side: { af: string; n: number; loadout: LoadoutEntry[] }; set(v: { af: string; n: number; loadout: LoadoutEntry[] }): void }) {
  const { airframes } = useEd((s) => s.air!);
  const weapons = useLoadoutWeapons();
  const penalty = usePenalty();
  const frame = airframes.find((a) => a.id === side.af);
  return (
    <div className="setgrp">
      <h4>{label}</h4>
      <div className="row2">
        <select value={side.af} onChange={(e) => set({ ...side, af: e.target.value, loadout: [] })} aria-label={`${label} airframe`}>{airframes.filter((a) => !a.deleted_at).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <Field label="Aircraft"><input type="number" min={1} value={side.n} onChange={(e) => set({ ...side, n: Math.round(num(e.target.value, 1, 100)) })} /></Field>
      </div>
      {frame && <LoadoutEditor frame={frame} weapons={weapons} value={side.loadout} onChange={(loadout) => set({ ...side, loadout })} penalty={penalty} />}
    </div>
  );
}

function AirSandbox() {
  const air = useEd((s) => s.air!);
  const combat = useEd((s) => s.combat);
  const s: CombatSettings = { ...DEFAULT_SETTINGS, ...combat?.settings };
  const first = air.airframes.find((a) => !a.deleted_at)?.id ?? '';
  const [mode, setMode] = useState<'a2a' | 'strike'>('a2a');
  const [A, setA] = useState({ af: first, n: 4, loadout: [] as LoadoutEntry[] });
  const [B, setB] = useState({ af: first, n: 4, loadout: [] as LoadoutEntry[] });
  const [tpl, setTpl] = useState(combat?.templates.find((t) => t.category === 'ground')?.id ?? '');
  const [terrain, setTerrain] = useState<'open' | 'urban' | 'forest'>('open');
  const [emit, setEmit] = useState(true);
  const [salt, setSalt] = useState(newSalt());
  if (!first) return <p className="empty">Make an airframe first.</p>;
  const toIn = (side: typeof A, id: string, sideName: string, mission: SquadronIn['mission'] = null): SquadronIn => {
    const af = air.airframes.find((a) => a.id === side.af)!;
    const loadout: AirWeaponIn[] = side.loadout.map((e) => {
      const w = air.weapons.find((x) => x.id === e.weapon)!;
      return { id: w.id, name: w.name, tier: w.tier, guidance: w.guidance, accuracy: w.accuracy, range_m: w.range_m, damage: w.damage, ap: w.ap, weight: w.weight, slots: w.slots, targets: w.targets, count: e.count };
    });
    return { id, name: `${af.name} (${sideName})`, owner: sideName, side: sideName, airframe: af as unknown as AirframeIn, base: 'b', base_pos: [0, 0], aircraft: side.n, max: side.n, damage: 0,
      loadout, radius_m: 1e9, mission };
  };
  const roller: Roller = { s, edits: {}, rand: (...p) => rand01('sandbox', salt, ...p) };
  let phases: AirPhase[] = [];
  let summary = '';
  if (mode === 'a2a') {
    const a = squadronState(toIn(A, 'a', 'A')), b = squadronState(toIn(B, 'b', 'B'));
    phases = airFight(roller, 'sb', [a], [b], 'A', 'B');
    summary = `A: ${alive(a)} of ${A.n} left · B: ${alive(b)} of ${B.n} left`;
  } else {
    const t = combat?.templates.find((x) => x.id === tpl);
    if (t) {
      const ws = (combat?.weapons ?? []);
      const unit = {
        id: 'target', name: t.name, owner: 'B', side: 'B', template: { id: t.id, name: t.name, max_strength: t.max_strength, armor: t.armor, category: 'ground' as const, aps: t.aps ?? 0 },
        weapons: t.weapon_ids.map((wid, slot) => { const w = ws.find((x) => x.id === wid)!; return { slot, id: w.id, name: w.name, attacks: w.attacks, ap: w.ap, range_m: w.range_m, indirect: w.indirect,
          anti_air: w.anti_air, guidance: w.guidance, accuracy: w.accuracy, air_damage: w.air_damage, air_shots: w.air_shots }; }).filter((w) => w.name),
        start: [1, 0] as [number, number], pos: [1, 0] as [number, number], moved: false, heading: null, strength: t.max_strength, experience: 0, stationary_turns: 0,
        terrain, new: false, retreat: false, attacks: [], emit,
      };
      const r = resolveCombat({ map_id: 'sandbox', turn: 1, settings: s, units: [unit], engagements: [], squadrons: [toIn(A, 'a', 'A', { type: 'strike', target_unit: 'target' })] }, { salt, salts: {}, edits: {} });
      phases = r.air?.log.packages[0]?.phases ?? [];
      const st = r.air?.strikes[0];
      const q = r.air?.squadrons[0];
      summary = `${t.name}: ${Math.round(r.units[0].after)} of ${t.max_strength} strength left${st?.aborted ? ` (strike: ${st.aborted})` : ''} · strike aircraft: ${q?.after} of ${A.n} left`;
    }
  }
  return (
    <>
      <div className="row2 wrap">
        <div className="seg" role="group" aria-label="Sandbox mode">
          <button type="button" className={mode === 'a2a' ? 'on' : ''} onClick={() => setMode('a2a')}>Air-to-air</button>
          <button type="button" className={mode === 'strike' ? 'on' : ''} onClick={() => setMode('strike')}>Strike vs ground / AA</button>
        </div>
        <button type="button" className="btn" onClick={() => setSalt(newSalt())}>Roll again</button>
      </div>
      <div className="sandbox">
        <SideForm label={mode === 'a2a' ? 'Side A' : 'Strike'} side={A} set={setA} />
        {mode === 'a2a' ? <SideForm label="Side B" side={B} set={setB} /> : (
          <div className="setgrp">
            <h4>Target</h4>
            <select value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Target template">{(combat?.templates ?? []).filter((t) => t.category === 'ground' && !t.deleted_at).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            <Field label="Terrain" wide><select value={terrain} onChange={(e) => setTerrain(e.target.value as typeof terrain)}><option value="open">open</option><option value="urban">urban</option><option value="forest">forest</option></select></Field>
            <label className="check"><input type="checkbox" checked={emit} onChange={(e) => setEmit(e.target.checked)} /> Its radar AA is emitting (HARMs can lock; full accuracy)</label>
            <p className="tip">The target's own anti-air weapons fire at the strike. Its active protection counts against AGMs.</p>
          </div>
        )}
      </div>
      <p className="points"><span>{summary}</span></p>
      {phases.length === 0 && <p className="empty">No shots: give the aircraft weapons that fit this fight.</p>}
      {phases.map((p, i) => <AirShotTable key={i} phase={p} />)}
      <p className="tip">Same engine and settings as the real turn. Nothing here is saved.</p>
    </>
  );
}
