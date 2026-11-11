// The owner's tech tree editor, player points and spawn zones. Every control calls an owner-only RPC
// (save_tech_item, set_player_points, save_spawn_zone, ...); nothing here needs the Supabase dashboard.
import { useEffect, useMemo, useState } from 'react';
import { fmtDist } from '../lib/geo';
import { symbolDataUrl } from '../lib/images';
import { zoneFromFeature } from '../lib/submissions';
import { buildSidc } from '../lib/symbols';
import { fmtPts, PLACEMENTS } from '../lib/tech';
import { TechTree } from '../lib/TechTree';
import type { MapMeta, Placement, SpawnZone, TechItem, Zone } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, IconButton } from './ui';

type Tab = 'tree' | 'points' | 'zones';
const TABS: [Tab, string][] = [['tree', 'Tech tree'], ['points', 'Player points'], ['zones', 'Spawn zones']];

interface Props {
  backend: Backend;
  map: MapMeta;
  /** Re-read the turn bundle, which carries the economy. */
  refresh(): Promise<void>;
  onClose(): void;
}

export function TechDialog({ backend, map, refresh, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('tree');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void refresh().catch(() => {});
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
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
        {tab === 'zones' && <ZonesTab backend={backend} map={map} busy={busy} run={run} />}
      </div>
    </div>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<boolean>;

const BLANK: TechItem = {
  id: '', name: '', description: null, tier: 1, sort: 0, research_cost: 10, spawn_cost: 10, prereqs: [], buyable: true,
  asset_id: null, sidc: null, props: {}, income_spawn: 0, income_research: 0, spawn_radius_m: null, placement: 'either',
};
const int = (v: string) => Math.max(0, Math.min(1_000_000, Math.round(+v) || 0));

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

  const startNew = () => setEdit({ ...BLANK, tier: Math.max(0, ...items.map((x) => x.tier)), sidc: buildSidc(symbolDraft), sort: items.length });
  const set = (p: Partial<TechItem>) => edit && setEdit({ ...edit, ...p });
  const save = async () => {
    if (!edit) return;
    const { id, ...rest } = edit;
    const body = { ...rest, ...(id ? { id } : {}), name: edit.name.trim(), description: edit.description?.trim() || null };
    let saved = '';
    if (await run(async () => (saved = await backend.saveTechItem(map.id, body)))) setEdit({ ...edit, id: saved });
  };
  const remove = async () => {
    if (!edit?.id || !confirm(`Delete "${edit.name}" from the tech tree? Units already on the map stay but stop paying income. Players lose it as researched.`)) return;
    if (await run(() => backend.deleteTechItem(edit.id))) setEdit(null);
  };
  const unitKind = !edit?.buyable ? '' : edit.asset_id ? edit.asset_id : 'symbol';

  return (
    <div className="techedit">
      <div>
        <div className="row2 wrap">
          <button type="button" className="btn primary" onClick={startNew}>New item</button>
          <small>Click an item to edit it. Columns are tiers; lines show prerequisites.</small>
        </div>
        <TechTree items={items} icon={icon} selected={edit?.id} onPick={(it) => setEdit({ ...it })} />
        <p className="tip">
          Research cost 0 = available to every player from the start. Units on the map pay income to the player they are
          assigned to, at every push; tag units you placed yourself with "Tech type" in the properties panel.
        </p>
      </div>
      {edit ? (
        <div className="form">
          <h4>{edit.id ? `Edit ${edit.name || 'item'}` : 'New item'}</h4>
          <Field label="Name" wide><input value={edit.name} maxLength={80} placeholder="e.g. Main battle tank" onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Description (players see it)" wide>
            <textarea rows={2} maxLength={1000} value={edit.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="row2">
            <Field label="Tier (column)"><input type="number" min={0} max={50} value={edit.tier} onChange={(e) => set({ tier: Math.max(0, Math.min(50, Math.round(+e.target.value) || 0)) })} /></Field>
            <Field label="Order in column"><input type="number" value={edit.sort} onChange={(e) => set({ sort: Math.round(+e.target.value) || 0 })} /></Field>
          </div>
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
                  {x.name} <small>(tier {x.tier})</small>
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
              <Field label="Where players may place it" wide>
                <select value={edit.placement} onChange={(e) => set({ placement: e.target.value as Placement })}>
                  {PLACEMENTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </Field>
            </>
          )}
          <h4>Each unit of this type on the map</h4>
          <div className="row2">
            <Field label="Spawn points per turn"><input type="number" min={0} value={edit.income_spawn} onChange={(e) => set({ income_spawn: int(e.target.value) })} /></Field>
            <Field label="Research points per turn"><input type="number" min={0} value={edit.income_research} onChange={(e) => set({ income_research: int(e.target.value) })} /></Field>
          </div>
          <Field label="Is a spawn point: units may be placed within (km, blank = no)" wide>
            <input
              type="number" min={0} step="any" value={edit.spawn_radius_m ? +(edit.spawn_radius_m / 1000).toFixed(3) : ''}
              onChange={(e) => set({ spawn_radius_m: +e.target.value > 0 ? +e.target.value * 1000 : null })}
            />
          </Field>
          <div className="row2 wrap">
            <button type="button" className="btn primary" disabled={busy || !edit.name.trim() || (edit.buyable && !edit.sidc && !edit.asset_id)} onClick={() => void save()}>
              {edit.id ? 'Save' : 'Add to tree'}
            </button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Close</button>
            {edit.id && <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>Delete</button>}
          </div>
        </div>
      ) : (
        <div className="form">
          <p className="tip">
            Players spend <strong>research points</strong> to unlock items (after their prerequisites), then <strong>spawn points</strong> to
            buy unlocked units and place them during their turn. Research and purchases are part of the draft: they cost nothing until
            you push, and anything you reject is free.
          </p>
          <p className="tip">Income units and spawn-point units can be bought like any other, or placed by you and tagged.</p>
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

function ZonesTab({ backend, map, busy, run }: { backend: Backend; map: MapMeta; busy: boolean; run: Run }) {
  const zones = useEd((s) => s.bundle?.economy.zones ?? []);
  const players = useEd((s) => s.players);
  const features = useEd((s) => s.features);
  const selection = useEd((s) => s.selection);
  const [name, setName] = useState('');
  const [who, setWho] = useState('');
  const picked = features.find((f) => f.id === selection[0]);
  const zone: Zone = useMemo(() => (picked ? zoneFromFeature(picked) : null), [picked]);
  const teams = [...new Set(players.map((p) => p.team).filter(Boolean))];
  const whoText = (z: SpawnZone) => (z.player_id ? players.find((p) => p.id === z.player_id)?.name ?? '?' : z.team ? `team ${z.team}` : 'everyone');
  const shape = (z: Exclude<Zone, null>) => ('center' in z ? `circle, ${fmtDist(z.radius_m)}` : 'drawn area');

  const add = () =>
    zone &&
    run(async () => {
      const target = who === '' ? {} : who.startsWith('team:') ? { team: who.slice(5) } : { player_id: who };
      await backend.saveSpawnZone(map.id, { name: name.trim() || null, ...target, zone });
      setName('');
    });

  return (
    <>
      {zones.length === 0 ? (
        <p className="empty">No spawn zones. Items placed "in a spawn zone" cannot be bought until there is one.</p>
      ) : (
        <ul className="changes">
          {zones.map((z) => (
            <li key={z.id}>
              <div className="row">
                <span><strong>{z.name || 'Spawn zone'}</strong> <small>for {whoText(z)} · {shape(z.zone)}</small></span>
                <IconButton icon="x" title="Delete zone" onClick={() => void run(() => backend.deleteSpawnZone(z.id))} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <h4>Add from the map</h4>
      <p className="tip">
        Close this window, draw a polygon (P) or circle (C), select it, and open Tech again. The selected shape becomes the zone; you can delete the
        shape afterwards or keep it on a hidden layer. Zones show on the map while the turn panel is open.
      </p>
      <div className="row2 wrap">
        <Field label="Name"><input value={name} maxLength={80} placeholder="e.g. Northern beachhead" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="For">
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {teams.map((t) => <option key={t} value={`team:${t}`}>Team {t}</option>)}
            {players.filter((p) => !p.revoked).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="row2 wrap">
        <small>Selected shape: <strong>{zone ? shape(zone) : 'none (select a polygon or circle on the map)'}</strong></small>
        <button type="button" className="btn primary" disabled={busy || !zone} onClick={() => void add()}>Add spawn zone</button>
      </div>
    </>
  );
}
