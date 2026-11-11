// The owner's tech tree editor (a flowchart), player points and spawn zones. Every control calls an
// owner-only RPC (save_tech_item, move_tech_items, set_player_points, save_spawn_zone, ...); nothing here
// needs the Supabase dashboard.
import { useEffect, useMemo, useState } from 'react';
import { fmtDist } from '../lib/geo';
import { symbolDataUrl } from '../lib/images';
import { zoneFromFeature } from '../lib/submissions';
import { buildSidc } from '../lib/symbols';
import { fmtPts, PLACEMENTS } from '../lib/tech';
import { layout, TechTree, type FlowEdit } from '../lib/TechTree';
import type { MapMeta, Placement, SpawnZone, TechItem, Zone } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, IconButton } from './ui';

export type TechTab = 'tree' | 'points' | 'zones';
const TABS: [TechTab, string][] = [['tree', 'Tech tree'], ['points', 'Player points'], ['zones', 'Spawn zones']];

interface Props {
  backend: Backend;
  map: MapMeta;
  tab?: TechTab;
  /** Re-read the turn bundle, which carries the economy. */
  refresh(): Promise<void>;
  onClose(): void;
}

export function TechDialog({ backend, map, tab: first = 'tree', refresh, onClose }: Props) {
  const [tab, setTab] = useState<TechTab>(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void refresh().catch(() => {});
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest?.('input, textarea, select') && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run one owner action, re-read, and tell players to refresh. Resolves to false on failure. */
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
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
    <div className="modal" role="dialog" aria-modal="true" aria-label="Tech" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog xwide">
        <header>
          <h2>Tech and points on "{map.name}"</h2>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </header>
        <div className="seg tabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => (setTab(t), setError(''))}>{label}</button>
          ))}
        </div>
        {error && <p className="note bad" role="alert">{error}</p>}
        {tab === 'tree' && <TreeTab backend={backend} map={map} busy={busy} run={run} />}
        {tab === 'points' && <PointsTab backend={backend} busy={busy} run={run} />}
        {tab === 'zones' && <ZonesTab backend={backend} map={map} busy={busy} run={run} onClose={onClose} />}
      </div>
    </div>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

const BLANK: TechItem = {
  id: '', name: '', description: null, tier: 0, sort: 0, research_cost: 10, spawn_cost: 10, prereqs: [], buyable: true,
  asset_id: null, sidc: null, props: {}, income_spawn: 0, income_research: 0, spawn_radius_m: null, placement: 'either', pos_x: null, pos_y: null,
  category: 'unit', can_move: true, spawn_from: [], move_range_m: null,
};
/** A production building: players build it with spawn points, it stays put, and units are placed around it. */
const BUILDING: Partial<TechItem> = { category: 'building', can_move: false, buyable: true, spawn_radius_m: 5000, placement: 'zone', spawn_cost: 50, research_cost: 0 };
const int = (v: string) => Math.max(0, Math.min(1_000_000, Math.round(+v) || 0));
/** The fields save_tech_item takes; a new item has no id yet. */
const body = (it: TechItem) => {
  const { id, ...rest } = it;
  return { ...rest, ...(id ? { id } : {}), name: it.name.trim(), description: it.description?.trim() || null };
};

function TreeTab({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const items = useEd((s) => s.bundle?.economy.items ?? []);
  const assets = useEd((s) => s.assets);
  const symbolDraft = useEd((s) => s.symbolDraft);
  const [edit, setEdit] = useState<TechItem | null>(null);
  const icon = (it: Pick<TechItem, 'asset_id' | 'sidc'>) => {
    const a = assets.find((x) => x.id === it.asset_id);
    return a ? backend.assetUrl(a) : it.sidc ? symbolDataUrl(it.sidc, 20) : null;
  };
  const palette = new Set(map.palette_assets ?? []);
  const offered = assets.filter((a) => !a.deleted_at && (palette.size === 0 || palette.has(a.id) || a.id === edit?.asset_id));
  const byId = (id: string) => items.find((x) => x.id === id);

  // Items from before the flowchart have no position yet: store the column layout once, so they stay put.
  useEffect(() => {
    const loose = items.filter((x) => x.pos_x == null || x.pos_y == null);
    if (!loose.length) return;
    const at = layout(items);
    void run(() => backend.moveTechItems(map.id, loose.map((x) => ({ id: x.id, ...at.get(x.id)! }))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  /** Keep the open form in step when the same item changes on the server (a link or a move). */
  useEffect(() => {
    if (!edit?.id) return;
    const it = byId(edit.id);
    if (!it) setEdit(null);
    else if (it.prereqs.join() !== edit.prereqs.join() || it.pos_x !== edit.pos_x || it.pos_y !== edit.pos_y) setEdit({ ...edit, prereqs: it.prereqs, pos_x: it.pos_x, pos_y: it.pos_y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const unitOf = (from?: TechItem) => (from?.asset_id ? { asset_id: from.asset_id, sidc: null, props: { ...from.props, name: undefined } } : { asset_id: null, sidc: from?.sidc ?? buildSidc(symbolDraft), props: { sizePx: 34 } });
  const create = async (it: TechItem) => {
    let id = '';
    if (await run(async () => (id = await backend.saveTechItem(map.id, body(it))))) setEdit({ ...it, id });
  };
  const flow: FlowEdit = {
    onMove: (moves) => void run(() => backend.moveTechItems(map.id, moves)),
    onLink: (pre, id) => {
      const it = byId(id);
      if (it && !it.prereqs.includes(pre)) void run(() => backend.saveTechItem(map.id, body({ ...it, prereqs: [...it.prereqs, pre] })));
    },
    onUnlink: (pre, id) => {
      const it = byId(id);
      if (it) void run(() => backend.saveTechItem(map.id, body({ ...it, prereqs: it.prereqs.filter((x) => x !== pre) })));
    },
    onGrow: (from, _dir, at) => {
      const parent = byId(from);
      // Grown from a building: a unit produced there. Grown from a unit: the next unit, placed the same way.
      const made = parent?.category === 'building'
        ? { ...unitOf(), spawn_from: [from], placement: 'spawn' as const }
        : { ...unitOf(parent), placement: parent?.placement ?? 'either', spawn_from: parent?.spawn_from ?? [] };
      void create({ ...BLANK, ...made, name: 'New item', prereqs: [from], tier: (parent?.tier ?? 0) + 1, pos_x: at.x, pos_y: at.y });
    },
  };
  const startNew = (building = false) => {
    const at = layout(items);
    const right = Math.max(-280, ...[...at.values()].map((p) => p.x)) + 280;
    void create({ ...BLANK, ...unitOf(), name: building ? 'New building' : 'New item', research_cost: 0, ...(building ? BUILDING : {}), pos_x: right, pos_y: 0 });
  };
  const buildings = items.filter((x) => x.id !== edit?.id && (x.category === 'building' || x.spawn_radius_m));
  const set = (p: Partial<TechItem>) => edit && setEdit({ ...edit, ...p });
  const save = () => edit && void run(() => backend.saveTechItem(map.id, body(edit)));
  const remove = async () => {
    if (!edit?.id || !confirm(`Delete "${edit.name}" from the tech tree? Units already on the map stay but stop paying income. Players lose it as researched.`)) return;
    if (await run(() => backend.deleteTechItem(edit.id))) setEdit(null);
  };
  const unitKind = !edit?.buyable ? '' : edit.asset_id ? edit.asset_id : 'symbol';

  return (
    <div className="techedit">
      <div>
        <div className="row2 wrap">
          <button type="button" className="btn primary" disabled={busy} onClick={() => startNew()}>New item</button>
          <button type="button" className="btn" disabled={busy} onClick={() => startNew(true)}>New building</button>
          <small>
            Drag boxes anywhere. Click a box, then an arrow button (→+) to grow a new item in that direction that requires it. Drag a blue dot
            onto another box to make that box require this one; ✕ on a selected box's arrow removes the link.
          </small>
        </div>
        <TechTree items={items} icon={icon} selected={edit?.id} onPick={(it) => setEdit(it ? { ...it } : null)} edit={flow} />
        <p className="tip">
          Research cost 0 = available to every player from the start. Units on the map pay income to the player they are
          assigned to, at every push; tag units you placed yourself with "Tech type" in the properties panel.
        </p>
      </div>
      {edit ? (
        <div className="form">
          <h4>{edit.id ? `Edit ${edit.name || 'item'}` : 'New item'}</h4>
          <Field label="Name" wide><input autoFocus value={edit.name} maxLength={80} placeholder="e.g. Main battle tank" onChange={(e) => set({ name: e.target.value })} onFocus={(e) => /^New (item|building)$/.test(edit.name) && e.target.select()} /></Field>
          <div className="seg" role="group" aria-label="Kind">
            <button type="button" className={edit.category === 'unit' ? 'on' : ''} onClick={() => set({ category: 'unit', can_move: true })}>Unit</button>
            <button type="button" className={edit.category === 'building' ? 'on' : ''} onClick={() => set({ ...BUILDING, spawn_cost: edit.spawn_cost, research_cost: edit.research_cost, spawn_radius_m: edit.spawn_radius_m ?? 5000, spawn_from: [] })}>Production building</button>
          </div>
          <Field label="Description (players see it)" wide>
            <textarea rows={2} maxLength={1000} value={edit.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="row2">
            <Field label="Research cost (0 = free)"><input type="number" min={0} value={edit.research_cost} onChange={(e) => set({ research_cost: int(e.target.value) })} /></Field>
            <Field label="Spawn cost per unit"><input type="number" min={0} value={edit.spawn_cost} disabled={!edit.buyable} onChange={(e) => set({ spawn_cost: int(e.target.value) })} /></Field>
          </div>
          <Field label="Requires (researched first)" wide>
            <div className="picks">
              {items.filter((x) => x.id !== edit.id).length === 0 && <small>No other items yet.</small>}
              {items.filter((x) => x.id !== edit.id).map((x) => (
                <label key={x.id} className="check">
                  <input
                    type="checkbox" checked={edit.prereqs.includes(x.id)}
                    onChange={(e) => set({ prereqs: e.target.checked ? [...edit.prereqs, x.id] : edit.prereqs.filter((y) => y !== x.id) })}
                  />
                  {x.name}
                </label>
              ))}
            </div>
          </Field>
          <label className="check">
            <input type="checkbox" checked={edit.buyable} onChange={(e) => set({ buyable: e.target.checked, ...(e.target.checked && !edit.sidc && !edit.asset_id ? { sidc: buildSidc(symbolDraft) } : {}) })} />
            Players can buy it as a unit (untick for a research-only node)
          </label>
          {edit.buyable && (
            <>
              <Field label="Unit" wide>
                <select
                  value={unitKind}
                  onChange={(e) => set(e.target.value === 'symbol' ? { asset_id: null, sidc: edit.sidc ?? buildSidc(symbolDraft), props: { ...edit.props, sizeMode: undefined, sizeM: undefined, sizePx: 34 } } : { asset_id: e.target.value, sidc: null, props: { ...edit.props, sizeMode: 'px', sizePx: 64 } })}
                >
                  <option value="symbol">NATO symbol</option>
                  {offered.map((a) => <option key={a.id} value={a.id}>Graphic: {a.name}</option>)}
                </select>
              </Field>
              {unitKind === 'symbol' ? (
                <div className="row2 wrap">
                  {edit.sidc && <img className="mini" src={symbolDataUrl(edit.sidc, 20)} alt="" />}
                  <input value={edit.sidc ?? ''} spellCheck={false} aria-label="SIDC" onChange={(e) => set({ sidc: e.target.value.toUpperCase().trim() })} />
                  <button type="button" className="btn sm" title="Pick a symbol with the symbol tool (S) first" onClick={() => set({ sidc: buildSidc(symbolDraft) })}>Use symbol tool's</button>
                </div>
              ) : (
                <Field label="True length in metres (blank = fixed 64 px)" wide>
                  <input
                    type="number" min={1} max={100000} value={edit.props.sizeMode === 'm' ? edit.props.sizeM ?? '' : ''}
                    onChange={(e) => set({ props: e.target.value ? { ...edit.props, sizeMode: 'm', sizeM: Math.max(1, +e.target.value) } : { ...edit.props, sizeMode: 'px', sizePx: 64, sizeM: undefined } })}
                  />
                </Field>
              )}
              <Field label="Default unit name (players can rename)" wide>
                <input value={edit.props.name ?? ''} maxLength={80} onChange={(e) => set({ props: { ...edit.props, name: e.target.value || undefined } })} />
              </Field>
              <Field label={edit.category === 'building' ? 'Where players may build it' : 'Where players may place it'} wide>
                <select value={edit.placement} onChange={(e) => set({ placement: e.target.value as Placement })}>
                  {PLACEMENTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </Field>
              {edit.category === 'unit' && edit.placement !== 'zone' && edit.placement !== 'anywhere' && (
                <Field label="Produced at (tick none = any spawn point)" wide>
                  <div className="picks">
                    {buildings.length === 0 && <small>No buildings or spawn points in the tree yet. Add one with "New building".</small>}
                    {buildings.map((x) => (
                      <label key={x.id} className="check">
                        <input type="checkbox" checked={edit.spawn_from.includes(x.id)}
                          onChange={(e) => set({ spawn_from: e.target.checked ? [...edit.spawn_from, x.id] : edit.spawn_from.filter((y) => y !== x.id) })} />
                        {x.name}
                      </label>
                    ))}
                  </div>
                </Field>
              )}
            </>
          )}
          <h4>{edit.category === 'building' ? 'Each building of this type on the map' : 'Each unit of this type on the map'}</h4>
          <div className="row2">
            <Field label="Spawn points per turn"><input type="number" min={0} value={edit.income_spawn} onChange={(e) => set({ income_spawn: int(e.target.value) })} /></Field>
            <Field label="Research points per turn"><input type="number" min={0} value={edit.income_research} onChange={(e) => set({ income_research: int(e.target.value) })} /></Field>
          </div>
          <Field label={edit.category === 'building' ? 'Produces units within (km)' : 'Is a spawn point: units may be placed within (km, blank = no)'} wide>
            <input
              type="number" min={0} step="any" value={edit.spawn_radius_m ? +(edit.spawn_radius_m / 1000).toFixed(3) : ''}
              onChange={(e) => set({ spawn_radius_m: +e.target.value > 0 ? +e.target.value * 1000 : null })}
            />
          </Field>
          <label className="check">
            <input type="checkbox" checked={edit.can_move} onChange={(e) => set({ can_move: e.target.checked })} />
            Players can move it once placed
          </label>
          {edit.can_move && (
            <Field label="Move range per turn (km, blank = the turn's move radius)" wide>
              <input
                type="number" min={0} step="any" value={edit.move_range_m != null ? +(edit.move_range_m / 1000).toFixed(3) : ''}
                onChange={(e) => set({ move_range_m: e.target.value === '' ? null : Math.max(0, +e.target.value) * 1000 })}
              />
            </Field>
          )}
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim() || (edit.buyable && !edit.sidc && !edit.asset_id)} onClick={save}>Save</button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Close</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>Delete</button>
          </div>
        </div>
      ) : (
        <div className="form">
          <p className="tip">
            Players spend <strong>research points</strong> to unlock items (after their prerequisites), then <strong>spawn points</strong> to
            buy unlocked units and place them during their turn, including units researched that same turn. Research and purchases are part
            of the draft: they cost nothing until you push, and anything you reject is free.
          </p>
          <p className="tip">Click "New item" to start, or click a box to edit it.</p>
        </div>
      )}
    </div>
  );
}

function PointsTab({ backend, busy, run }: { backend: Backend; busy: boolean; run: Run }) {
  const economy = useEd((s) => s.bundle?.economy);
  const players = useEd((s) => s.players);
  const [open, setOpen] = useState<string | null>(null);
  const [bulk, setBulk] = useState({ who: '', spawn: '', research: '' });
  if (!economy) return <p className="empty">Loading…</p>;
  const eco = new Map(economy.players.map((e) => [e.id, e]));
  const seats = players.filter((p) => !p.revoked);
  const teams = [...new Set(seats.map((p) => p.team).filter(Boolean))];
  const researchable = economy.items.filter((x) => x.research_cost > 0);
  const num = (v: string) => (v.trim() === '' ? 0 : Math.round(+v) || 0);

  const give = () =>
    run(async () => {
      const targets = seats.filter((p) => bulk.who === '' || (bulk.who.startsWith('team:') ? p.team === bulk.who.slice(5) : p.id === bulk.who));
      for (const p of targets) {
        const e = eco.get(p.id);
        if (e) await backend.setPlayerPoints(p.id, e.spawn_points + num(bulk.spawn), e.research_points + num(bulk.research));
      }
      setBulk({ ...bulk, spawn: '', research: '' });
    });

  return (
    <>
      {seats.length === 0 ? (
        <p className="empty">No players yet.</p>
      ) : (
        <table className="ptable">
          <thead>
            <tr><th>Player</th><th>Spawn points</th><th>Research points</th><th>Income per turn</th><th>Researched</th></tr>
          </thead>
          <tbody>
            {seats.map((p) => {
              const e = eco.get(p.id);
              if (!e) return null;
              const done = researchable.filter((x) => e.tech_unlocked.includes(x.id));
              return [
                <tr key={p.id}>
                  <td><i className="chip" style={{ background: p.color ?? '#8794a4' }} aria-hidden /> {p.name}{p.team ? <small> · {p.team}</small> : null}</td>
                  <td>
                    <input type="number" key={`s${e.spawn_points}`} defaultValue={e.spawn_points} aria-label={`${p.name} spawn points`}
                      onBlur={(ev) => num(ev.target.value) !== e.spawn_points && void run(() => backend.setPlayerPoints(p.id, num(ev.target.value), null))} />
                  </td>
                  <td>
                    <input type="number" key={`r${e.research_points}`} defaultValue={e.research_points} aria-label={`${p.name} research points`}
                      onBlur={(ev) => num(ev.target.value) !== e.research_points && void run(() => backend.setPlayerPoints(p.id, null, num(ev.target.value)))} />
                  </td>
                  <td>+{fmtPts(e.income.spawn)} spawn, +{fmtPts(e.income.research)} research</td>
                  <td>
                    <button type="button" className={`btn sm${open === p.id ? ' on' : ''}`} disabled={!researchable.length} onClick={() => setOpen(open === p.id ? null : p.id)}>
                      {done.length} of {researchable.length}
                    </button>
                  </td>
                </tr>,
                open === p.id && (
                  <tr key={`${p.id}-tech`}>
                    <td colSpan={5}>
                      <div className="picks">
                        {researchable.map((x) => (
                          <label key={x.id} className="check">
                            <input type="checkbox" disabled={busy} checked={e.tech_unlocked.includes(x.id)} onChange={(ev) => void run(() => backend.setPlayerTech(p.id, x.id, ev.target.checked))} />
                            {x.name} <small>(tier {x.tier}, {x.research_cost} research)</small>
                          </label>
                        ))}
                      </div>
                      <p className="tip">Granting or removing research here costs and refunds nothing.</p>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
      <h4>Hand out points</h4>
      <div className="bulk">
        <select value={bulk.who} onChange={(e) => setBulk({ ...bulk, who: e.target.value })} aria-label="To">
          <option value="">Every player</option>
          {teams.map((t) => <option key={t} value={`team:${t}`}>Team {t}</option>)}
          {seats.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Field label="Spawn (+/-)"><input type="number" value={bulk.spawn} onChange={(e) => setBulk({ ...bulk, spawn: e.target.value })} /></Field>
        <Field label="Research (+/-)"><input type="number" value={bulk.research} onChange={(e) => setBulk({ ...bulk, research: e.target.value })} /></Field>
        <button type="button" className="btn primary" disabled={busy || (!num(bulk.spawn) && !num(bulk.research))} onClick={() => void give()}>Add</button>
      </div>
      <p className="tip">
        Edit a number and click away to set it. Income is what the player's units on the map earn at the next push.
        Balances are saved with every turn, so a rollback puts them back too.
      </p>
    </>
  );
}

interface Country { name: string; geometry: Extract<Zone, { type: 'MultiPolygon' }> }
let countries: Promise<Country[]> | null = null;
/** Natural Earth 1:50m borders, shipped with the site and fetched only when needed (about 1.7 MB). */
const loadCountries = () => (countries ??= fetch(new URL('countries.json', document.baseURI)).then((r) => {
  if (!r.ok) throw new Error(`Could not load the country list (HTTP ${r.status})`);
  return r.json() as Promise<Country[]>;
}).catch((e) => { countries = null; throw e; }));

function WhoSelect({ value, onChange, label = 'For' }: { value: string; onChange(v: string): void; label?: string }) {
  const players = useEd((s) => s.players);
  const teams = [...new Set(players.map((p) => p.team).filter(Boolean))];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">Everyone</option>
      {teams.map((t) => <option key={t} value={`team:${t}`}>Team {t}</option>)}
      {players.filter((p) => !p.revoked).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}
const whoValue = (z: Pick<SpawnZone, 'player_id' | 'team'>) => (z.player_id ? z.player_id : z.team ? `team:${z.team}` : '');
const whoTarget = (who: string) => (who === '' ? { player_id: null, team: null } : who.startsWith('team:') ? { player_id: null, team: who.slice(5) } : { player_id: who, team: null });

function ZonesTab({ backend, map, busy, run, onClose }: { backend: Backend; map: MapMeta; busy: boolean; run: Run; onClose(): void }) {
  const zones = useEd((s) => s.bundle?.economy.zones ?? []);
  const features = useEd((s) => s.features);
  const selection = useEd((s) => s.selection);
  const [who, setWho] = useState('');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [list, setList] = useState<Country[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const picked = selection.length === 1 ? features.find((f) => f.id === selection[0]) : undefined;
  const drawn: Zone = useMemo(() => (picked ? zoneFromFeature(picked) : null), [picked]);
  const shape = (z: Exclude<Zone, null>) => ('center' in z ? `circle, ${fmtDist(z.radius_m)} radius` : z.type === 'MultiPolygon' ? 'country' : 'drawn area');

  useEffect(() => {
    loadCountries().then(setList, (e) => setLoadErr((e as Error).message));
  }, []);

  const addDrawn = () => drawn && run(async () => {
    await backend.saveSpawnZone(map.id, { name: name.trim() || null, ...whoTarget(who), zone: drawn });
    setName('');
  });
  const addCountry = () => {
    const c = list?.find((x) => x.name.toLowerCase() === country.trim().toLowerCase());
    if (!c) return;
    void run(async () => {
      await backend.saveSpawnZone(map.id, { name: name.trim() || c.name, ...whoTarget(who), zone: c.geometry });
      setCountry('');
      setName('');
    });
  };
  const draw = () => {
    useEd.setState({ zoneDraw: true, selection: [] });
    useEd.getState().setTool('polygon');
    onClose();
  };
  const known = !!list?.some((x) => x.name.toLowerCase() === country.trim().toLowerCase());

  return (
    <>
      {zones.length === 0 ? (
        <p className="empty">No spawn zones yet. Items placed "in a spawn zone" cannot be bought until a player has one.</p>
      ) : (
        <ul className="changes">
          {zones.map((z) => (
            <li key={z.id}>
              <div className="zonerow">
                <span>
                  <input className="inline-name" key={z.name ?? ''} defaultValue={z.name ?? ''} placeholder="Spawn zone" maxLength={80} aria-label="Zone name"
                    onBlur={(e) => e.target.value.trim() !== (z.name ?? '') && void run(() => backend.saveSpawnZone(map.id, { ...z, name: e.target.value.trim() || null }))} />
                  <small> {shape(z.zone)}</small>
                </span>
                <WhoSelect value={whoValue(z)} label="Zone is for" onChange={(v) => void run(() => backend.saveSpawnZone(map.id, { ...z, ...whoTarget(v) }))} />
                <IconButton icon="x" title="Delete zone" onClick={() => void run(() => backend.deleteSpawnZone(z.id))} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="tip">Spawn zones show on your map as dotted outlines in the colour of the player or team they belong to (white = everyone).</p>

      <h4>Add a zone</h4>
      <div className="row2 wrap">
        <Field label="For"><WhoSelect value={who} onChange={setWho} /></Field>
        <Field label="Name (optional)"><input value={name} maxLength={80} placeholder="e.g. Northern beachhead" onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <div className="newlink">
        <strong>A whole country</strong>
        <div className="row2 wrap">
          <input list="tacmap-countries" value={country} placeholder={list ? 'Type a country, e.g. France' : 'Loading countries…'} disabled={!list} aria-label="Country" onChange={(e) => setCountry(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCountry()} />
          <datalist id="tacmap-countries">{list?.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          <button type="button" className="btn primary" disabled={busy || !known} onClick={addCountry}>Add country</button>
        </div>
        {loadErr && <p className="note bad">{loadErr}</p>}
        <small className="note">Borders: Natural Earth 1:50 000 000 (public domain), accurate to a few kilometres. Small islands and disputed areas may differ from other maps.</small>
      </div>
      <div className="newlink">
        <strong>Your own shape</strong>
        <div className="row2 wrap">
          <button type="button" className="btn primary" onClick={draw}>Draw a zone on the map</button>
          <small>Draw a polygon (click points, double-click to finish) or switch to the circle tool (C). This window comes back by itself.</small>
        </div>
        <div className="row2 wrap">
          <small>Selected on the map: <strong>{drawn ? shape(drawn) : picked ? 'not a polygon or circle' : 'nothing'}</strong></small>
          <button type="button" className="btn" disabled={busy || !drawn} onClick={() => void addDrawn()}>Use selected shape</button>
        </div>
      </div>
    </>
  );
}
