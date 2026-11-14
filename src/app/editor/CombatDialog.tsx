// The owner's ground-combat admin: unit templates, weapon profiles, versioned settings, terrain
// generation, a damage sandbox for balancing, and running engagements. Every save calls an owner-only RPC.
import type { Map as MlMap } from 'maplibre-gl';
import type { MultiPolygon, Polygon } from 'geojson';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { computeShot, DEFAULT_SETTINGS, flankOf, type CombatSettings, type Terrain } from '../lib/combat';
import { loadCountries, type Country } from '../lib/countries';
import { circlePoly } from '../lib/geo';
import { symbolDataUrl } from '../lib/images';
import { zoneFromFeature } from '../lib/submissions';
import { buildSidc } from '../lib/symbols';
import {
  boxPolygon, bboxOf, buildTerrain, DEFAULT_TERRAIN_OPTIONS, downloadTerrain, rawFromGeoJson, tilesFor, MAX_TILES, type RawTerrain, type TerrainResult,
} from '../lib/terrain';
import type { MapMeta, TerrainStats, UnitTemplate, WeaponProfile } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, IconButton } from './ui';

export type CombatTab = 'units' | 'weapons' | 'settings' | 'terrain' | 'sandbox' | 'fights';
const TABS: [CombatTab, string][] = [['units', 'Unit templates'], ['weapons', 'Weapons'], ['settings', 'Settings'], ['terrain', 'Terrain'], ['sandbox', 'Sandbox'], ['fights', 'Engagements']];

interface Props {
  backend: Backend;
  map: MapMeta;
  getMap(): MlMap | null;
  tab?: CombatTab;
  /** Re-read templates, weapons, settings and unit state. */
  refresh(): Promise<void>;
  /** Terrain changed on the server: reload the overlay. */
  onTerrain(): void;
  onClose(): void;
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

export function CombatDialog({ backend, map, getMap, tab: first = 'units', refresh, onTerrain, onClose }: Props) {
  const [tab, setTab] = useState<CombatTab>(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const combat = useEd((s) => s.combat);

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
    <div className="modal" role="dialog" aria-modal="true" aria-label="Combat" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog xwide">
        <header>
          <h2>Ground combat on "{map.name}"</h2>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </header>
        <div className="seg tabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => (setTab(t), setError(''))}>{label}</button>
          ))}
        </div>
        {error && <p className="note bad" role="alert">{error}</p>}
        {!combat ? <p className="empty">Loading…</p> : (
          <>
            {tab === 'units' && <TemplatesTab backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'weapons' && <WeaponsTab backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'settings' && <SettingsTab backend={backend} map={map} busy={busy} run={run} />}
            {tab === 'terrain' && <TerrainTab backend={backend} map={map} getMap={getMap} busy={busy} run={run} onTerrain={onTerrain} />}
            {tab === 'sandbox' && <Sandbox />}
            {tab === 'fights' && <Fights backend={backend} busy={busy} run={run} />}
          </>
        )}
      </div>
    </div>
  );
}

const num = (v: string, lo = 0, hi = 1e9) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));

/** A list on the left, the edit form on the right. */
function Split({ list, form }: { list: ReactNode; form: ReactNode }) {
  return <div className="techedit"><div>{list}</div><div className="form">{form}</div></div>;
}

// ---------------------------------------------------------------------------
// Unit templates
// ---------------------------------------------------------------------------

const BLANK_T: UnitTemplate = { id: '', name: '', max_strength: 1000, armor: 10, category: 'ground', asset_id: null, sidc: null, weapon_ids: [], deleted_at: null, air_capacity: 0, aps: 0 };

function TemplatesTab({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const { templates, weapons } = useEd((s) => s.combat!);
  const assets = useEd((s) => s.assets);
  const symbolDraft = useEd((s) => s.symbolDraft);
  const [edit, setEdit] = useState<UnitTemplate | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const wById = new Map(weapons.map((w) => [w.id, w]));
  const set = (p: Partial<UnitTemplate>) => edit && setEdit({ ...edit, ...p });
  const icon = (t: UnitTemplate) => {
    const a = assets.find((x) => x.id === t.asset_id);
    return a ? backend.assetUrl(a) : t.sidc ? symbolDataUrl(t.sidc, 20) : null;
  };
  const body = (t: UnitTemplate, extra: Record<string, unknown> = {}) => {
    const { id, deleted_at: _d, ...rest } = t;
    return { ...rest, ...(id ? { id } : {}), name: t.name.trim(), ...extra };
  };
  const save = async () => {
    if (!edit) return;
    let id = '';
    if (await run(async () => (id = await backend.saveUnitTemplate(map.id, body(edit))))) setEdit({ ...edit, id });
  };
  const link = !edit ? '' : edit.asset_id ? edit.asset_id : edit.sidc != null ? 'symbol' : '';

  return (
    <Split
      list={(
        <>
          <div className="row2 wrap">
            <button type="button" className="btn primary" onClick={() => setEdit({ ...BLANK_T, sidc: buildSidc(symbolDraft) })}>New template</button>
            <label className="check"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted</label>
          </div>
          {templates.length === 0 && <p className="empty">No templates yet. A template gives units strength, armor and weapons; units without one never fight.</p>}
          <ul className="changes">
            {templates.filter((t) => showDeleted || !t.deleted_at).map((t) => (
              <li key={t.id} className={`${edit?.id === t.id ? 'on' : ''}${t.deleted_at ? ' off' : ''}`}>
                <div className="row" role="button" tabIndex={0} onClick={() => setEdit({ ...t })} onKeyDown={(e) => e.key === 'Enter' && setEdit({ ...t })}>
                  {icon(t) ? <img className="mini" src={icon(t)!} alt="" /> : <span className="mini techdot">◆</span>}
                  <span><strong>{t.name}</strong> <small>{t.category} · strength {t.max_strength} · armor {t.armor} · {t.weapon_ids.map((w) => wById.get(w)?.name ?? '?').join(', ') || 'no weapons'}</small></span>
                </div>
              </li>
            ))}
          </ul>
          <p className="tip">
            A unit gets its template from (first match): the "Unit template" in its properties, its tech item, or the first template with the same
            graphic or NATO symbol. Air and naval units take no part in ground combat yet.
          </p>
        </>
      )}
      form={edit ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name || 'template'}` : 'New template'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} placeholder="e.g. Main battle tank" onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="row2">
            <Field label="Max strength"><input type="number" min={1} value={edit.max_strength} onChange={(e) => set({ max_strength: num(e.target.value, 1) })} /></Field>
            <Field label="Armor"><input type="number" min={0} value={edit.armor} onChange={(e) => set({ armor: num(e.target.value) })} /></Field>
          </div>
          <div className="row2">
            <Field label="Airbase: squadrons it can hold (0 = none)"><input type="number" min={0} max={100} value={edit.air_capacity ?? 0} onChange={(e) => set({ air_capacity: Math.round(num(e.target.value, 0, 100)) })} /></Field>
            <Field label="Active protection vs AGMs (%)"><input type="number" min={0} max={100} value={edit.aps ?? 0} onChange={(e) => set({ aps: num(e.target.value, 0, 100) })} /></Field>
          </div>
          <Field label="Category" wide>
            <select value={edit.category} onChange={(e) => set({ category: e.target.value as UnitTemplate['category'] })}>
              <option value="ground">Ground</option>
              <option value="air">Air (no ground combat yet)</option>
              <option value="naval">Naval (no ground combat yet)</option>
            </select>
          </Field>
          <Field label="Units drawn with" wide>
            <select value={link} onChange={(e) => set(e.target.value === 'symbol' ? { asset_id: null, sidc: edit.sidc ?? buildSidc(symbolDraft) } : e.target.value ? { asset_id: e.target.value, sidc: null } : { asset_id: null, sidc: null })}>
              <option value="">Nothing (set per unit or per tech item)</option>
              <option value="symbol">A NATO symbol</option>
              {assets.filter((a) => !a.deleted_at || a.id === edit.asset_id).map((a) => <option key={a.id} value={a.id}>Graphic: {a.name}</option>)}
            </select>
          </Field>
          {link === 'symbol' && (
            <div className="row2 wrap">
              {edit.sidc && <img className="mini" src={symbolDataUrl(edit.sidc, 20)} alt="" />}
              <input value={edit.sidc ?? ''} spellCheck={false} aria-label="SIDC" onChange={(e) => set({ sidc: e.target.value.toUpperCase().trim() })} />
              <button type="button" className="btn sm" onClick={() => set({ sidc: buildSidc(symbolDraft) })}>Use symbol tool's</button>
            </div>
          )}
          <Field label="Weapons (each fires at one target per round)" wide>
            <ul className="wlist">
              {edit.weapon_ids.map((wid, i) => (
                <li key={`${wid}${i}`}>
                  <span>{wById.get(wid)?.name ?? 'unknown'}{wById.get(wid)?.deleted_at ? ' (deleted)' : ''}</span>
                  <IconButton icon="up" title="Move up" disabled={i === 0} onClick={() => set({ weapon_ids: edit.weapon_ids.map((x, k) => (k === i - 1 ? wid : k === i ? edit.weapon_ids[i - 1] : x)) })} />
                  <IconButton icon="x" title="Remove" onClick={() => set({ weapon_ids: edit.weapon_ids.filter((_, k) => k !== i) })} />
                </li>
              ))}
            </ul>
            <select value="" onChange={(e) => e.target.value && set({ weapon_ids: [...edit.weapon_ids, e.target.value] })} aria-label="Add weapon">
              <option value="">Add a weapon…</option>
              {weapons.filter((w) => !w.deleted_at).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void save()}>Save</button>
            {edit.id && <button type="button" className="btn" disabled={busy} onClick={() => setEdit({ ...edit, id: '', name: `${edit.name} (copy)`, deleted_at: null })}>Clone</button>}
            {edit.id && (edit.deleted_at
              ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => backend.saveUnitTemplate(map.id, body(edit, { deleted: false }))).then((ok) => ok && setEdit({ ...edit, deleted_at: null }))}>Restore</button>
              : <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => backend.saveUnitTemplate(map.id, body(edit, { deleted: true }))).then((ok) => ok && setEdit(null))}>Delete</button>)}
          </div>
          <p className="tip">Delete is soft: units already using the template stop fighting, and it can be restored. Old turns keep their logs.</p>
        </>
      ) : <p className="tip">Pick a template to edit it, or make a new one.</p>}
    />
  );
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

const BLANK_W: WeaponProfile = { id: '', name: '', attacks: 100, ap: 10, range_m: 3000, indirect: false, deleted_at: null, anti_air: false, guidance: 'none', accuracy: 60, air_damage: 50, air_shots: 2 };

function WeaponsTab({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const { weapons, templates } = useEd((s) => s.combat!);
  const [edit, setEdit] = useState<WeaponProfile | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const set = (p: Partial<WeaponProfile>) => edit && setEdit({ ...edit, ...p });
  const body = (w: WeaponProfile, extra: Record<string, unknown> = {}) => {
    const { id, deleted_at: _d, ...rest } = w;
    return { ...rest, ...(id ? { id } : {}), name: w.name.trim(), ...extra };
  };
  const save = async () => {
    if (!edit) return;
    let id = '';
    if (await run(async () => (id = await backend.saveWeapon(map.id, body(edit))))) setEdit({ ...edit, id });
  };
  const usedBy = (id: string) => templates.filter((t) => t.weapon_ids.includes(id)).map((t) => t.name);
  return (
    <Split
      list={(
        <>
          <div className="row2 wrap">
            <button type="button" className="btn primary" onClick={() => setEdit({ ...BLANK_W })}>New weapon</button>
            <label className="check"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted</label>
          </div>
          {weapons.length === 0 && <p className="empty">No weapons yet.</p>}
          <ul className="changes">
            {weapons.filter((w) => showDeleted || !w.deleted_at).map((w) => (
              <li key={w.id} className={`${edit?.id === w.id ? 'on' : ''}${w.deleted_at ? ' off' : ''}`}>
                <div className="row" role="button" tabIndex={0} onClick={() => setEdit({ ...w })} onKeyDown={(e) => e.key === 'Enter' && setEdit({ ...w })}>
                  <span><strong>{w.name}</strong> <small>{w.attacks} attacks · AP {w.ap} · {+(w.range_m / 1000).toFixed(2)} km{w.indirect ? ' · indirect' : ''}{usedBy(w.id).length ? ` · on ${usedBy(w.id).join(', ')}` : ''}</small></span>
                </div>
              </li>
            ))}
          </ul>
          <p className="tip">Players see a weapon's name and range on their own units (to pick targets), never its attacks or AP.</p>
        </>
      )}
      form={edit ? (
        <>
          <h4>{edit.id ? `Edit ${edit.name || 'weapon'}` : 'New weapon'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} placeholder="e.g. 120mm smoothbore" onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="row2">
            <Field label="Attacks"><input type="number" min={0} value={edit.attacks} onChange={(e) => set({ attacks: num(e.target.value) })} /></Field>
            <Field label="AP (armor piercing)"><input type="number" min={0} value={edit.ap} onChange={(e) => set({ ap: num(e.target.value) })} /></Field>
          </div>
          <Field label="Range (km)" wide><input type="number" min={0} step="any" value={+(edit.range_m / 1000).toFixed(3)} onChange={(e) => set({ range_m: num(e.target.value) * 1000 })} /></Field>
          <label className="check">
            <input type="checkbox" checked={edit.indirect} onChange={(e) => set({ indirect: e.target.checked })} />
            Indirect fire: hits any target in range, once per turn, only if the firing unit stays put; starts no engagement and draws no return fire
          </label>
          <label className="check">
            <input type="checkbox" checked={!!edit.anti_air} onChange={(e) => set({ anti_air: e.target.checked, guidance: e.target.checked && edit.guidance === 'none' ? 'radar' : edit.guidance })} />
            Anti-air: fires at enemy aircraft striking a target within its range
          </label>
          {edit.anti_air && (
            <div className="setgrp">
              <Field label="Guidance (decides which countermeasure works against it)" wide>
                <select value={edit.guidance ?? 'radar'} onChange={(e) => set({ guidance: e.target.value as WeaponProfile['guidance'] })}>
                  <option value="radar">Radar (vs ECM/chaff; halved when the player sets the radar dark; HARMs can hit it while emitting)</option>
                  <option value="ir">IR (vs flares; unaffected by going dark)</option>
                  <option value="gun">Gun (vs manoeuvrability)</option>
                </select>
              </Field>
              <div className="row2">
                <Field label="Accuracy (%)"><input type="number" min={0} max={100} value={edit.accuracy ?? 60} onChange={(e) => set({ accuracy: num(e.target.value, 0, 100) })} /></Field>
                <Field label="Damage per hit (aircraft HP)"><input type="number" min={0} value={edit.air_damage ?? 50} onChange={(e) => set({ air_damage: num(e.target.value) })} /></Field>
              </div>
              <Field label="Shots per strike over its area" wide><input type="number" min={0} max={100} value={edit.air_shots ?? 2} onChange={(e) => set({ air_shots: Math.round(num(e.target.value, 0, 100)) })} /></Field>
            </div>
          )}
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim()} onClick={() => void save()}>Save</button>
            {edit.id && <button type="button" className="btn" disabled={busy} onClick={() => setEdit({ ...edit, id: '', name: `${edit.name} (copy)`, deleted_at: null })}>Clone</button>}
            {edit.id && (edit.deleted_at
              ? <button type="button" className="btn" disabled={busy} onClick={() => void run(() => backend.saveWeapon(map.id, body(edit, { deleted: false }))).then((ok) => ok && setEdit({ ...edit, deleted_at: null }))}>Restore</button>
              : <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => backend.saveWeapon(map.id, body(edit, { deleted: true }))).then((ok) => ok && setEdit(null))}>Delete</button>)}
          </div>
        </>
      ) : <p className="tip">Pick a weapon to edit it, or make a new one.</p>}
    />
  );
}

// ---------------------------------------------------------------------------
// Settings (versioned per turn)
// ---------------------------------------------------------------------------

type NumKey = { [K in keyof CombatSettings]: CombatSettings[K] extends number ? K : never }[keyof CombatSettings];
const GROUPS: { title: string; fields: [NumKey, string, number?][] }[] = [
  { title: 'Movement and position', fields: [['attacker_stationary', 'Attacker stationary ×'], ['target_stationary', 'Target stationary ×'], ['dug_in', 'Target dug in ×'], ['dug_in_turns', 'Dug in after stationary turns', 1]] },
  { title: 'Flanking', fields: [['flank_front_deg', 'Front arc ± degrees', 1], ['flank_rear_deg', 'Rear arc ± degrees', 1], ['flank_side', 'Side hit ×'], ['flank_rear', 'Rear hit ×']] },
  { title: 'Experience and luck', fields: [['veteran_max', 'Veteran bonus at full experience ×'], ['veteran_encounters', 'Encounters to full experience', 1], ['variance', 'Variance for a green unit (±)']] },
  { title: 'Damage and rounds', fields: [['clamp', 'Base damage cap (× attacks)'], ['rounds_max', 'Most rounds per turn', 1], ['recovery_pct', 'Recovery per turn out of combat (% of max)']] },
  { title: 'Intel', fields: [['intel_km', 'Intel range (km)'], ['band_fresh', '"Fresh" from (share of max)'], ['band_damaged', '"Damaged" from'], ['band_heavy', '"Heavily damaged" from (below = critical)']] },
];

function SettingsTab({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const combat = useEd((s) => s.combat!);
  const [s, setS] = useState<CombatSettings>({ ...DEFAULT_SETTINGS, ...combat.settings });
  useEffect(() => setS({ ...DEFAULT_SETTINGS, ...combat.settings }), [combat.settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify({ ...DEFAULT_SETTINGS, ...combat.settings });
  return (
    <>
      <p className="tip">
        These numbers apply from turn <strong>{combat.turn}</strong> on. Earlier turns keep the numbers they were played with, so their logs and
        rollbacks stay exact.{combat.versions.length > 0 && ` Saved versions start at turn ${combat.versions.map((v) => v.from_turn).join(', ')}.`}
      </p>
      <div className="kv">
        {GROUPS.map((g) => (
          <div key={g.title} className="setgrp">
            <h4>{g.title}</h4>
            {g.fields.map(([k, label, step]) => (
              <Field key={k} label={label} wide>
                <input type="number" min={0} step={step ?? 'any'} value={s[k] as number} onChange={(e) => setS({ ...s, [k]: num(e.target.value, 0, 1e6) })} />
              </Field>
            ))}
          </div>
        ))}
        <div className="setgrp">
          <h4>Terrain (defender) ×</h4>
          {(['open', 'urban', 'forest'] as Terrain[]).map((t) => (
            <Field key={t} label={t} wide>
              <input type="number" min={0} step="any" value={s.terrain[t]} onChange={(e) => setS({ ...s, terrain: { ...s.terrain, [t]: num(e.target.value, 0, 100) } })} />
            </Field>
          ))}
        </div>
        <div className="setgrp">
          <h4>Rules</h4>
          <label className="check"><input type="checkbox" checked={s.parting_round} onChange={(e) => setS({ ...s, parting_round: e.target.checked })} /> A retreating unit takes one parting round</label>
          <label className="check"><input type="checkbox" checked={s.remove_destroyed} onChange={(e) => setS({ ...s, remove_destroyed: e.target.checked })} /> Remove destroyed units from the map</label>
        </div>
      </div>
      <div className="row2 wrap">
        <button type="button" className="btn primary" disabled={busy || !dirty} onClick={() => void run(() => backend.saveCombatSettings(map.id, s as unknown as Record<string, unknown>))}>Save from turn {combat.turn}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setS({ ...DEFAULT_SETTINGS, terrain_min_km2: s.terrain_min_km2 })}>Reset to defaults</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** The last download, kept for the session so a threshold change regenerates without downloading again. */
let cache: { key: string; raw: RawTerrain } | null = null;

function TerrainTab({ backend, map, getMap, busy, run, onTerrain }: { backend: Backend; map: MapMeta; getMap(): MlMap | null; busy: boolean; run: Run; onTerrain(): void }) {
  const combat = useEd((s) => s.combat!);
  const features = useEd((s) => s.features);
  const selection = useEd((s) => s.selection);
  const showTerrain = useEd((s) => s.showTerrain);
  const [areaKind, setAreaKind] = useState<'view' | 'shape' | 'country'>('view');
  const [country, setCountry] = useState('');
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [zoom, setZoom] = useState(8);
  const [opts, setOpts] = useState({ ...DEFAULT_TERRAIN_OPTIONS, minKm2: { ...combat.settings.terrain_min_km2 } });
  const [progress, setProgress] = useState('');
  const [local, setLocal] = useState<TerrainResult['stats'] | null>(null);
  const [stats, setStats] = useState<TerrainStats>(combat.terrain);
  const [error, setError] = useState('');
  useEffect(() => setStats(combat.terrain), [combat.terrain]);
  useEffect(() => {
    if (areaKind === 'country' && !countries) loadCountries().then(setCountries, (e) => setError((e as Error).message));
  }, [areaKind, countries]);

  const picked = selection.length === 1 ? features.find((f) => f.id === selection[0]) : undefined;
  const area = useMemo((): Polygon | MultiPolygon | null => {
    if (areaKind === 'view') {
      const m = getMap();
      if (!m) return null;
      const b = m.getBounds();
      return boxPolygon([Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())]);
    }
    if (areaKind === 'shape') {
      const z = picked ? zoneFromFeature(picked) : null;
      return !z ? null : 'center' in z ? circlePoly(z.center, z.radius_m) : z;
    }
    return countries?.find((c) => c.name.toLowerCase() === country.trim().toLowerCase())?.geometry ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaKind, picked, country, countries]);
  const tiles = area ? tilesFor(bboxOf(area), zoom).length : 0;
  const key = area ? `${JSON.stringify(bboxOf(area))}|${zoom}` : '';

  const finish = async (raw: RawTerrain) => {
    setProgress('Building zones…');
    await new Promise((r) => setTimeout(r, 30));
    const r = buildTerrain(raw, area!, opts);
    setLocal(r.stats);
    setProgress('Saving…');
    const ok = await run(async () => {
      if (JSON.stringify(opts.minKm2) !== JSON.stringify(combat.settings.terrain_min_km2)) await backend.saveCombatSettings(map.id, { terrain_min_km2: opts.minKm2 });
      setStats(await backend.replaceTerrain(map.id, { zones: r.zones, area, source: raw.source, options: { ...opts, zoom } }));
    });
    setProgress('');
    if (ok) {
      useEd.setState({ showTerrain: true });
      onTerrain();
    }
  };
  const generate = async () => {
    if (!area) return;
    setError('');
    try {
      if (cache?.key !== key) {
        setProgress('Downloading…');
        const raw = await downloadTerrain(bboxOf(area), zoom, (d, n) => setProgress(`Downloading tiles ${d} / ${n}…`));
        cache = { key, raw };
      }
      await finish(cache.raw);
    } catch (e) {
      setProgress('');
      setError((e as Error).message);
    }
  };
  const upload = async (file: File) => {
    setError('');
    try {
      const raw = rawFromGeoJson(JSON.parse(await file.text()));
      if (!raw.urban.length && !raw.forest.length) throw new Error('No urban or forest polygons in that file (set properties.type to "urban" or "forest").');
      if (!area) throw new Error('Pick the campaign area first.');
      cache = { key: `upload|${file.name}`, raw };
      await finish(raw);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="techedit">
      <div className="form">
        <h4>Generate terrain</h4>
        <div className="seg" role="group" aria-label="Campaign area">
          <button type="button" className={areaKind === 'view' ? 'on' : ''} onClick={() => setAreaKind('view')}>Current map view</button>
          <button type="button" className={areaKind === 'shape' ? 'on' : ''} onClick={() => setAreaKind('shape')}>Selected shape</button>
          <button type="button" className={areaKind === 'country' ? 'on' : ''} onClick={() => setAreaKind('country')}>A country</button>
        </div>
        {areaKind === 'shape' && !area && <p className="note">Close this window, select a polygon or circle on the map, and open it again.</p>}
        {areaKind === 'country' && (
          <>
            <input list="tacmap-countries-c" value={country} placeholder={countries ? 'e.g. Poland' : 'Loading countries…'} disabled={!countries} aria-label="Country" onChange={(e) => setCountry(e.target.value)} />
            <datalist id="tacmap-countries-c">{countries?.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          </>
        )}
        <div className="row2">
          <Field label="Cities from (km²)"><input type="number" min={0} value={opts.minKm2.urban} onChange={(e) => setOpts({ ...opts, minKm2: { ...opts.minKm2, urban: num(e.target.value) } })} /></Field>
          <Field label="Forests from (km²)"><input type="number" min={0} value={opts.minKm2.forest} onChange={(e) => setOpts({ ...opts, minKm2: { ...opts.minKm2, forest: num(e.target.value) } })} /></Field>
        </div>
        <div className="row2">
          <Field label="Detail (tile zoom)">
            <select value={zoom} onChange={(e) => setZoom(+e.target.value)}>
              {[7, 8, 9, 10].map((z) => <option key={z} value={z}>{z}{z === 8 ? ' (default)' : z < 8 ? ' (coarser, faster)' : ' (finer, slower)'}</option>)}
            </select>
          </Field>
          <Field label="Merge patches closer than (km)">
            <input type="number" min={0} step={0.5} value={(opts.closeCells * opts.cellM) / 1000} onChange={(e) => setOpts({ ...opts, closeCells: Math.round(num(e.target.value, 0, 20) * 1000 / opts.cellM) })} />
          </Field>
        </div>
        <small className="note">{area ? `${tiles} tiles to download${tiles > MAX_TILES ? ` (over the ${MAX_TILES} limit: pick a smaller area or lower detail)` : ''}.` : 'Pick an area.'}</small>
        <div className="row2 wrap">
          <button type="button" className="btn primary" disabled={busy || !!progress || !area || tiles > MAX_TILES} onClick={() => void generate()}>
            {cache?.key === key ? 'Regenerate with these settings' : 'Generate terrain'}
          </button>
          <label className="btn">
            Upload GeoJSON…
            <input type="file" accept=".json,.geojson,application/geo+json,application/json" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </label>
        </div>
        {progress && <p className="note" role="status">{progress}</p>}
        {error && <p className="note bad" role="alert">{error}</p>}
        <p className="tip">
          Source: OpenStreetMap land use via OpenFreeMap's free vector tiles (no key). Only the chosen area is downloaded, once; changing a threshold
          regenerates from that download in one click. A GeoJSON file with polygons whose <code>type</code> is <code>urban</code> or <code>forest</code> works
          as a fallback.
        </p>
      </div>
      <div className="form">
        <h4>Coverage</h4>
        {stats.zones ? (
          <>
            <p className="points">
              <span>Open <b>{stats.open_pct}%</b></span>
              <span>Urban <b>{stats.urban_pct}%</b></span>
              <span>Forest <b>{stats.forest_pct}%</b></span>
            </p>
            <small className="note">{stats.zones} zones over {stats.total_km2?.toLocaleString()} km²{stats.source ? ` · ${stats.source}` : ''}{stats.generated_at ? ` · ${new Date(stats.generated_at).toLocaleString()}` : ''}</small>
            {(stats.open_pct ?? 100) < 60 && <p className="note bad">Less than 60% of the area is open. Raise the thresholds and regenerate if that is not what you want.</p>}
            {local && <small className="note">Grid estimate before saving: open {local.open_pct}%, urban {local.urban_pct}%, forest {local.forest_pct}%.</small>}
          </>
        ) : <p className="empty">No terrain yet: everything counts as open.</p>}
        <label className="check"><input type="checkbox" checked={showTerrain} onChange={(e) => (useEd.setState({ showTerrain: e.target.checked }), onTerrain())} /> Show terrain on the map</label>
        {stats.zones > 0 && <button type="button" className="btn danger" disabled={busy} onClick={() => confirm('Remove all terrain zones? Everything becomes open.') && void run(async () => setStats(await backend.replaceTerrain(map.id, { zones: [], area: null, source: 'cleared', options: {} }))).then(onTerrain)}>Clear terrain</button>}
        <p className="tip">Defender multipliers per terrain type are under Settings. Combat looks up the terrain at the target's position on the server.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function Sandbox() {
  const { templates, weapons, settings } = useEd((s) => s.combat!);
  const live = templates.filter((t) => !t.deleted_at);
  const [atk, setAtk] = useState(live[0]?.id ?? '');
  const [def, setDef] = useState(live[1]?.id ?? live[0]?.id ?? '');
  const [c, setC] = useState({ attackerStationary: false, targetStationary: false, targetTurns: 1, strength: 100, terrain: 'open' as Terrain, angle: 0, experience: 0, variance: false, rand: 0.5 });
  const s: CombatSettings = { ...DEFAULT_SETTINGS, ...settings, ...(c.variance ? {} : { variance: 0 }) };
  const a = live.find((t) => t.id === atk);
  const d = live.find((t) => t.id === def);
  const wById = new Map(weapons.map((w) => [w.id, w]));
  const flank = flankOf(0, c.angle, s);
  const rows = (a?.weapon_ids ?? []).map((wid, slot) => {
    const w = wById.get(wid);
    if (!w || !d) return null;
    return { slot, w, r: computeShot({ attacks: w.attacks, ap: w.ap, armor: d.armor, attackerStationary: c.attackerStationary, targetStationary: c.targetStationary,
      targetStationaryTurns: c.targetStationary ? c.targetTurns : 0, strengthRatio: c.strength / 100, terrain: c.terrain, flank, experience: c.experience, rand: c.rand }, s) };
  }).filter(Boolean) as { slot: number; w: WeaponProfile; r: ReturnType<typeof computeShot> }[];
  const set = (p: Partial<typeof c>) => setC({ ...c, ...p });
  if (live.length === 0) return <p className="empty">Make a unit template (with weapons) first.</p>;
  return (
    <>
      <div className="sandbox">
        <div className="setgrp">
          <h4>Attacker</h4>
          <select value={atk} onChange={(e) => setAtk(e.target.value)} aria-label="Attacker">{live.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="check"><input type="checkbox" checked={c.attackerStationary} onChange={(e) => set({ attackerStationary: e.target.checked })} /> Stationary this turn</label>
          <Field label={`Strength ${c.strength}% of max`} wide><input type="range" min={0} max={100} value={c.strength} onChange={(e) => set({ strength: +e.target.value })} /></Field>
          <Field label={`Experience: ${c.experience} encounters`} wide><input type="range" min={0} max={Math.max(20, s.veteran_encounters * 2)} value={c.experience} onChange={(e) => set({ experience: +e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={c.variance} onChange={(e) => set({ variance: e.target.checked })} /> Variance on</label>
          {c.variance && <Field label={`Roll (0 = worst, 1 = best): ${c.rand.toFixed(2)}`} wide><input type="range" min={0} max={0.999} step={0.01} value={c.rand} onChange={(e) => set({ rand: +e.target.value })} /></Field>}
        </div>
        <div className="setgrp">
          <h4>Defender</h4>
          <select value={def} onChange={(e) => setDef(e.target.value)} aria-label="Defender">{live.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="check"><input type="checkbox" checked={c.targetStationary} onChange={(e) => set({ targetStationary: e.target.checked })} /> Stationary this turn</label>
          {c.targetStationary && <Field label="Consecutive stationary turns (this one included)" wide><input type="number" min={1} value={c.targetTurns} onChange={(e) => set({ targetTurns: num(e.target.value, 1, 99) })} /></Field>}
          <Field label="Terrain at the defender" wide>
            <select value={c.terrain} onChange={(e) => set({ terrain: e.target.value as Terrain })}>{(['open', 'urban', 'forest'] as Terrain[]).map((t) => <option key={t} value={t}>{t}</option>)}</select>
          </Field>
          <Field label={`Attacker's angle off the defender's nose: ${c.angle}° (${flank})`} wide><input type="range" min={0} max={180} value={c.angle} onChange={(e) => set({ angle: +e.target.value })} /></Field>
        </div>
      </div>
      <table className="shots">
        <thead><tr><th>Weapon</th><th>Base</th><th>Multipliers</th><th>Roll</th><th>Damage</th></tr></thead>
        <tbody>
          {rows.map(({ slot, w, r }) => (
            <tr key={slot}>
              <td>{w.name}<br /><small className="mults">{w.attacks} att · AP {w.ap} vs armor {d?.armor}</small></td>
              <td className="num">{r.base.toFixed(2)}</td>
              <td className="mults">{r.mults.filter(([n]) => n !== 'variance roll').map(([n, v]) => `${n} ×${+v.toFixed(3)}`).join(' · ')}</td>
              <td className="num">×{r.roll.toFixed(3)}</td>
              <td className="num"><strong>{r.final}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="points"><span>Per round <b>{rows.reduce((x, r) => x + r.r.final, 0)}</b></span>{d && <span>of {d.max_strength} strength</span>}</p>
      <p className="tip">Uses the settings in force from turn {useEd.getState().combat?.turn}. Nothing here is saved.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

function Fights({ backend, busy, run }: { backend: Backend; busy: boolean; run: Run }) {
  const engagements = useEd((s) => s.combat!.engagements);
  const features = useEd((s) => s.features);
  const players = useEd((s) => s.players);
  const name = (fid: string) => features.find((f) => f.id === fid)?.props.name || 'unit';
  const side = (sd: string) => players.find((p) => p.id === sd)?.name ?? (sd === 'owner' ? 'unassigned' : `team ${sd}`);
  if (!engagements.length) return <p className="empty">No engagements are running.</p>;
  return (
    <ul className="changes">
      {engagements.map((e) => (
        <li key={e.id}>
          <div className="row">
            <span>
              <strong>Since turn {e.start_turn}</strong> <small>· {e.turns_engaged} turn{e.turns_engaged === 1 ? '' : 's'} engaged</small><br />
              {[...new Set(e.units.map((u) => u.side))].map((sd) => (
                <small key={sd}>{side(sd)}: {e.units.filter((u) => u.side === sd).map((u) => name(u.fid)).join(', ')}<br /></small>
              ))}
            </span>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => confirm('End this engagement now? Its units are free to move next turn.') && void run(() => backend.endEngagement(e.id))}>End</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
