import type { Map as MlMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASEMAP_IDS, BASEMAPS, setBasemap } from '../lib/basemaps';
import { fmtLatLon } from '../lib/geo';
import { createMap } from '../lib/mapview';
import { SceneRenderer } from '../lib/scene';
import { effectiveChanges } from '../lib/submissions';
import { TurnSlider, turnLabel } from '../lib/TurnSlider';
import type { BasemapId, MapMeta } from '../lib/types';
import { startAutosave } from './autosave';
import { AdminDialog, type AdminTab } from './AdminDialog';
import type { Backend, MapPatch, Who } from './backend';
import { Interaction } from './interaction';
import { LayersPanel } from './LayersPanel';
import { AssetLibrary, SymbolPalette } from './Palette';
import { PlayersDialog } from './PlayersDialog';
import { PropertiesPanel, StylePanel } from './PropertiesPanel';
import { ReviewOverlay } from './reviewOverlay';
import { ShareDialog } from './ShareDialog';
import { TurnPanel } from './TurnPanel';
import { useEd, type Tool } from './store';
import { Icon, IconButton, Section } from './ui';

const TOOLS: [Tool, string, string][] = [
  ['select', 'Select and move', 'V'], ['symbol', 'NATO symbol', 'S'], ['asset', 'Custom graphic', 'G'], ['text', 'Text', 'T'],
  ['line', 'Line', 'L'], ['arrow', 'Arrow / axis of advance', 'A'], ['polygon', 'Polygon', 'P'], ['circle', 'Circle / range ring', 'C'], ['freehand', 'Freehand', 'F'],
];

export function Editor({ backend, who, onSignOut }: { backend: Backend; who: Who; onSignOut: () => void }) {
  const [maps, setMaps] = useState<MapMeta[] | null>(null);
  const [mapId, setMapId] = useState<string | null>(() => localStorage.getItem('tacmap.lastMap'));
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      let list = await backend.listMaps();
      if (!list.some((m) => !m.archived)) list = [await backend.createMap('Untitled map'), ...list];
      setMaps(list);
    })().catch((e) => setError((e as Error).message));
  }, [backend]);

  const open = maps?.filter((m) => !m.archived) ?? [];
  const current = open.find((m) => m.id === mapId) ?? open[0] ?? null;
  useEffect(() => {
    if (current) localStorage.setItem('tacmap.lastMap', current.id);
  }, [current]);

  if (error) return <div className="splash">Could not load your maps: {error}</div>;
  if (!maps || !current) return <div className="splash">Loading…</div>;

  return (
    <Workspace
      key={`${current.id}:${reloadKey}`}
      backend={backend}
      who={who}
      meta={current}
      maps={maps}
      setMaps={setMaps}
      onSignOut={onSignOut}
      onSwitch={setMapId}
      reload={() => setReloadKey((k) => k + 1)}
      onPatch={(p) => {
        setMaps((ms) => ms!.map((m) => (m.id === current.id ? { ...m, ...p } : m)));
        // Ping after the write lands, so viewers and players re-read the new name, basemap or palette.
        backend.updateMap(current.id, p).then(() => backend.ping(current), (e) => useEd.getState().say((e as Error).message));
      }}
    />
  );
}

interface WorkspaceProps {
  backend: Backend;
  who: Who;
  meta: MapMeta;
  maps: MapMeta[];
  setMaps(maps: MapMeta[]): void;
  onSignOut(): void;
  onSwitch(id: string): void;
  onPatch(p: MapPatch): void;
  /** Throw the editor state away and load the map again (after the server changed it wholesale). */
  reload(): void;
}

function Workspace({ backend, who, meta, maps, setMaps, onSignOut, onSwitch, onPatch, reload }: WorkspaceProps) {
  const mapEl = useRef<HTMLDivElement>(null);
  const marqueeEl = useRef<HTMLDivElement>(null);
  const coordEl = useRef<HTMLSpanElement>(null);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const adoptRef = useRef<(upserts: import('../lib/types').Feature[], deletes: string[]) => void>(() => {});
  const [map, setMap] = useState<MlMap | null>(null);
  const [failed, setFailed] = useState('');
  const [sharing, setSharing] = useState(false);
  const [managingPlayers, setManagingPlayers] = useState(false);
  const [admin, setAdmin] = useState<AdminTab | null>(null);

  const tool = useEd((s) => s.tool);
  const snap = useEd((s) => s.snap);
  const saveStatus = useEd((s) => s.saveStatus);
  const hint = useEd((s) => s.hint);
  const toast = useEd((s) => s.toast);
  const hasSel = useEd((s) => s.selection.length > 0);
  const canUndo = useEd((s) => s.undoStack.length > 0);
  const canRedo = useEd((s) => s.redoStack.length > 0);
  const bundle = useEd((s) => s.bundle);
  const turnOpen = useEd((s) => s.showDrafts);
  const review = useEd((s) => s.review);
  const viewing = useEd((s) => s.viewing);
  const players = useEd((s) => s.players);
  const readyCount = bundle?.drafts.filter((d) => d.ready).length ?? 0;

  /** Re-read the turn and every draft. Announces players who became ready since last time. */
  const seenReady = useRef<Set<string> | null>(null);
  const refreshTurn = useCallback(async () => {
    const next = await backend.getTurn(meta.id);
    const s = useEd.getState();
    // A draft being dragged right now keeps the owner's local, not yet saved, version.
    const editing = s.review?.playerId;
    const local = s.bundle?.drafts.find((d) => d.player_id === editing);
    useEd.setState({ bundle: local ? { ...next, drafts: next.drafts.map((d) => (d.player_id === editing ? { ...d, owner_changes: local.owner_changes } : d)) } : next });
    const ready = new Set(next.drafts.filter((d) => d.ready).map((d) => d.player_id));
    if (seenReady.current) {
      const fresh = [...ready].filter((id) => !seenReady.current!.has(id));
      if (fresh.length) s.say(`${fresh.map((id) => s.players.find((p) => p.id === id)?.name ?? 'A player').join(', ')} marked ready`);
    }
    seenReady.current = ready;
  }, [backend, meta.id]);

  /** Resolve once local edits are in the database; turn functions work on the server's copy. */
  const settle = useCallback(async () => {
    for (let i = 0; i < 60; i++) {
      await flushRef.current();
      const status = useEd.getState().saveStatus;
      if (status === 'saved') return;
      if (status === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Your own edits have not saved yet. Check the connection and try again.');
  }, []);

  /** Assign units through the server, then fold the result into the editor without a second save. */
  const assign = useCallback(async (ids: string[], playerId: string | null) => {
    try {
      await settle();
      await backend.assignUnits(meta.id, ids, playerId);
      const rows = await backend.fetchFeatures(meta.id, ids);
      adoptRef.current(rows, []);
      useEd.getState().applyServer(rows, []);
      backend.ping(meta);
    } catch (e) {
      useEd.getState().say((e as Error).message);
    }
  }, [backend, meta, settle]);

  const pickTurn = useCallback(async (n: number | null) => {
    if (n === null) return useEd.setState({ viewing: null });
    try {
      const snap = await backend.getSnapshot(meta.id, n);
      if (snap) useEd.setState({ viewing: snap, review: null, selection: [], tool: 'select' });
    } catch (e) {
      useEd.getState().say((e as Error).message);
    }
  }, [backend, meta.id]);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    (async () => {
      const [doc, assets] = await Promise.all([backend.loadMap(meta.id), backend.listAssets()]);
      if (cancelled || !mapEl.current) return;
      useEd.getState().load(meta, doc.layers, doc.features, assets);

      const m = createMap(mapEl.current, meta);
      const disposers: (() => void)[] = [() => m.remove()];
      cleanup = () => disposers.reverse().forEach((d) => d());

      m.on('mousemove', (e) => {
        if (coordEl.current) coordEl.current.textContent = `${fmtLatLon([e.lngLat.lng, e.lngLat.lat])}   z${m.getZoom().toFixed(1)}`;
      });
      m.once('load', () => {
        if (cancelled) return;
        const renderer = new SceneRenderer(m, backend.assetUrl);
        const draw = () => {
          const s = useEd.getState();
          const assetMap = new Map(s.assets.map((a) => [a.id, a]));
          if (s.viewing) {
            for (const a of s.viewing.assets) assetMap.set(a.id, a);
            renderer.update(s.viewing.layers, s.viewing.features, assetMap); // a past turn, complete and read-only
          } else {
            renderer.update(s.layers.filter((l) => l.visible), s.features, assetMap);
          }
        };
        draw();
        const unsub = useEd.subscribe((s, p) => {
          if (s.layers !== p.layers || s.features !== p.features || s.assets !== p.assets || s.viewing !== p.viewing) draw();
        });
        // Drafts, zones and conflicts: above the live scene, below the edit handles.
        const ghosts = new ReviewOverlay(m, backend.assetUrl, (playerId) => {
          const b = useEd.getState().bundle;
          const d = b?.drafts.find((x) => x.player_id === playerId);
          if (b?.turn && d) backend.reviewDraft(b.turn.id, playerId, { owner_changes: d.owner_changes }).then(refreshTurn).catch((e) => useEd.getState().say((e as Error).message));
        });
        const ix = new Interaction(m, marqueeEl.current!);
        const saver = startAutosave(backend, meta, doc);
        flushRef.current = saver.flush;
        adoptRef.current = saver.adopt;
        const onSave = () => void saver.flush();
        window.addEventListener('tacmap:save', onSave);
        disposers.push(unsub, () => renderer.destroy(), () => ghosts.destroy(), () => ix.destroy(), () => saver.stop(), () => window.removeEventListener('tacmap:save', onSave));

        backend.listPlayers(meta.id).then((list) => !cancelled && useEd.setState({ players: list }), () => {});
        const poke = () => void refreshTurn().catch(() => {});
        poke();
        disposers.push(backend.watchDrafts(meta, poke));
        setMap(m);
      });
    })().catch((e) => !cancelled && setFailed((e as Error).message));
    return () => {
      cancelled = true;
      cleanup();
    };
    // The workspace is keyed by map id, so this runs once per map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLabel = { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', error: 'Save failed, retrying' }[saveStatus];
  const st = useEd.getState;
  const changeBasemap = (id: BasemapId) => {
    if (map) setBasemap(map, id);
    onPatch({ basemap: id });
  };
  const reviewing = review ? players.find((p) => p.id === review.playerId) : null;
  const pendingEdits = review && bundle ? effectiveChanges(bundle.drafts.find((d) => d.player_id === review.playerId) ?? { changes: [], owner_changes: null, rejected: [] }).length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">TACMAP</div>
        <select className="mapsel" value={meta.id} onChange={(e) => onSwitch(e.target.value)} title="Switch map" aria-label="Switch map">
          {maps.filter((m) => !m.archived).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <input
          className="mapname"
          key={meta.name}
          defaultValue={meta.name}
          maxLength={120}
          aria-label="Map name"
          title="Rename map"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== meta.name) onPatch({ name });
            else e.target.value = meta.name;
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="sep" />
        <div className="tools" role="toolbar" aria-label="Tools">
          {TOOLS.map(([t, label, key]) => (
            <IconButton key={t} icon={t} title={`${label}  (${key})`} active={tool === t} onClick={() => st().setTool(t)} />
          ))}
        </div>
        <span className="sep" />
        <IconButton icon="undo" title="Undo  (Ctrl+Z)" disabled={!canUndo} onClick={() => st().undo()} />
        <IconButton icon="redo" title="Redo  (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => st().redo()} />
        <IconButton icon="magnet" title="Snap to existing points  (hold Alt to bypass)" active={snap} onClick={() => useEd.setState({ snap: !snap })} />
        <span className="grow" />
        <div className="seg compact" role="group" aria-label="Basemap">
          {BASEMAP_IDS.map((id) => (
            <button key={id} type="button" className={meta.basemap === id ? 'on' : ''} onClick={() => changeBasemap(id)}>{BASEMAPS[id].label}</button>
          ))}
        </div>
        <button
          type="button"
          className="btn"
          title="Viewers and players open the map at the view you see now"
          onClick={() => {
            if (!map) return;
            const c = map.getCenter();
            onPatch({ center: [c.lng, c.lat], zoom: map.getZoom() });
            st().say('Start view saved');
          }}
        >
          Set start view
        </button>
        <button type="button" className="btn" onClick={() => setManagingPlayers(true)}>Players</button>
        <button
          type="button"
          className={`btn${turnOpen ? ' on' : ''}`}
          aria-pressed={turnOpen}
          title="Turn settings, reinforcements, draft review and push"
          onClick={() => useEd.setState({ showDrafts: !turnOpen, review: null })}
        >
          {bundle?.turn ? `Turn ${bundle.turn.number}` : 'Turn'}
          {readyCount > 0 && <span className="badge" aria-label={`${readyCount} drafts ready`}>{readyCount}</span>}
        </button>
        <button type="button" className="btn primary" onClick={() => setSharing(true)}>
          <Icon name="share" /> Share
        </button>
        <button type="button" className="btn" onClick={() => setAdmin('maps')}>Manage</button>
        <button type="button" className="btn" onClick={onSignOut}>Sign out</button>
      </header>

      <aside className="left">
        <LayersPanel />
      </aside>

      <main className="stage">
        <div ref={mapEl} className="map" />
        <div ref={marqueeEl} className="marquee" />
        {failed && <div className="splash over">Could not load this map: {failed}</div>}
        {viewing ? (
          <div className="banner" role="status">Viewing {turnLabel({ number: viewing.viewing, label: null, at: '' }).toLowerCase()}, complete and read-only. Use the slider below to return to the live map.</div>
        ) : reviewing ? (
          <div className="banner" role="status">Editing {reviewing.name}'s draft ({pendingEdits} changes). Drag their ghosts; the live map is locked until you click "Done editing".</div>
        ) : null}
        {toast && <div className="toast" role="status">{toast}</div>}
      </main>

      <aside className="right">
        {turnOpen ? (
          <TurnPanel backend={backend} map={meta} settle={settle} refresh={refreshTurn} reload={reload} />
        ) : (
          <>
            {tool === 'symbol' && <SymbolPalette />}
            {tool === 'asset' && <AssetLibrary backend={backend} />}
            {tool !== 'select' && tool !== 'symbol' && tool !== 'asset' && <StylePanel />}
            {hasSel && <PropertiesPanel onAssign={assign} />}
            {tool === 'select' && !hasSel && <Help />}
          </>
        )}
      </aside>

      <footer className="status">
        <span ref={coordEl} className="mono">–</span>
        <span className="mono hint">{hint}</span>
        <span className="grow" />
        <TurnSlider history={bundle?.history ?? []} viewing={viewing?.viewing ?? null} current={bundle?.turn?.number} rollbackOf={bundle?.turn?.rollback_of} onPick={(n) => void pickTurn(n)} />
        <span className={`pill ${saveStatus}`}>{saveLabel}</span>
      </footer>

      {sharing && <ShareDialog backend={backend} map={meta} flush={() => flushRef.current()} onClose={() => setSharing(false)} />}
      {managingPlayers && <PlayersDialog backend={backend} map={meta} settle={settle} onClose={() => setManagingPlayers(false)} />}
      {admin && (
        <AdminDialog
          backend={backend} who={who} map={meta} maps={maps} tab={admin} setTab={setAdmin} setMaps={setMaps}
          onSwitch={onSwitch} onPatchMap={onPatch} settle={settle} reload={reload} onClose={() => setAdmin(null)}
        />
      )}
    </div>
  );
}

function Help() {
  const rows: [string, string][] = [
    ['S / G / T', 'Place NATO symbol, custom graphic, text'],
    ['L / A / P / C / F', 'Line, arrow, polygon, circle, freehand'],
    ['V or Esc', 'Back to select'],
    ['Shift+click', 'Add to or remove from selection'],
    ['Shift+drag', 'Box select'],
    ['Drag orange handle', 'Rotate (Shift snaps to 15°)'],
    ['Drag white / blue dots', 'Move or insert a vertex'],
    ['Arrow keys', 'Nudge (Shift = 10 px)'],
    ['Ctrl+C / V / D', 'Copy, paste at cursor, duplicate'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo, redo'],
    ['[ and ]', 'Send to back, bring to front'],
    ['Del', 'Delete selection'],
  ];
  return (
    <Section title="Shortcuts">
      <dl className="keys">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="tip">Select an object to edit its properties here. Right-drag rotates the map.</p>
    </Section>
  );
}
