// Map interaction for the player page. Two stacked scenes share one map:
//   live   what the owner has published (read-only), or a past turn when the slider is used
//   draft  this player's draft for the open turn (translucent, draggable)
// Every edit only changes the draft. The live map changes when the owner pushes the turn.
// Range and zone checks here are for feel only; save_draft() enforces the same rules.
import type { Feature as GjFeature } from 'geojson';
import type { GeoJSONSource, LayerSpecification, Map as MlMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import { circlePoly, fromMerc, toMerc, translateGeom } from '../lib/geo';
import { hitLayers, SceneRenderer } from '../lib/scene';
import { anchorOf, baseId, clampToRadius, ghostFeatures, GHOST_LAYERS, inZone, zoneGeometry } from '../lib/submissions';
import { publicAssetUrl } from '../lib/supabase';
import type { Asset, CreatePayload, Feature, Pos } from '../lib/types';
import { canPlace, sourcesFor, usable, whereText } from '../lib/tech';
import { effective, pointsLeft, remaining, usePlay, type PTool } from './store';

const S = () => usePlay.getState();
const OVERLAY = 'play-overlay';
const DRAW: PTool[] = ['arrow', 'line', 'polygon'];
const DEFAULT_COLOR = '#f2a93b';
const DRAFT_HIT = hitLayers('dg');
const LIVE_HIT = hitLayers('sc');

const overlayLayers = (color: string) => [
  { id: 'po-mine', type: 'circle', source: OVERLAY, filter: ['==', ['get', 'o'], 'mine'],
    paint: { 'circle-radius': 21, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': color, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.75 } },
  { id: 'po-sel', type: 'circle', source: OVERLAY, filter: ['==', ['get', 'o'], 'selpt'],
    paint: { 'circle-radius': 25, 'circle-color': 'rgba(53,199,240,0.12)', 'circle-stroke-color': '#35c7f0', 'circle-stroke-width': 2 } },
  { id: 'po-line', type: 'line', source: OVERLAY, filter: ['in', ['get', 'o'], ['literal', ['sel', 'draw']]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#35c7f0', 'line-width': 2, 'line-dasharray': [2, 2] } },
  { id: 'po-zone-fill', type: 'fill', source: OVERLAY, filter: ['==', ['get', 'o'], 'zone'], paint: { 'fill-color': color, 'fill-opacity': 0.1 } },
  { id: 'po-zone', type: 'line', source: OVERLAY, filter: ['==', ['get', 'o'], 'zone'], paint: { 'line-color': color, 'line-width': 2, 'line-dasharray': [3, 2] } },
  { id: 'po-range', type: 'line', source: OVERLAY, filter: ['==', ['get', 'o'], 'range'], paint: { 'line-color': color, 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [2, 3] } },
  { id: 'po-range-sel', type: 'line', source: OVERLAY, filter: ['==', ['get', 'o'], 'range-sel'], paint: { 'line-color': '#35c7f0', 'line-width': 2, 'line-dasharray': [3, 2] } },
  { id: 'po-eng', type: 'line', source: OVERLAY, filter: ['==', ['get', 'o'], 'eng'], paint: { 'line-color': '#ff9f0a', 'line-width': 3, 'line-opacity': 0.7 } },
  { id: 'po-atk', type: 'line', source: OVERLAY, filter: ['==', ['get', 'o'], 'atk'], paint: { 'line-color': '#ff453a', 'line-width': 2, 'line-dasharray': [2, 1.5] } },
  { id: 'po-vert', type: 'circle', source: OVERLAY, filter: ['==', ['get', 'o'], 'v'],
    paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#0d1014', 'circle-stroke-width': 1.5 } },
] as unknown as LayerSpecification[];

export class PlayController {
  private live: SceneRenderer;
  private draft: SceneRenderer;
  private unsub: () => void;
  private drag: { fid: string; grab: Pos; from: Pos } | null = null;
  private pts: Pos[] | null = null;
  private cursor: Pos | null = null;

  constructor(private map: MlMap) {
    const url = (a: Asset) => publicAssetUrl(a.path);
    this.live = new SceneRenderer(map, url);
    this.draft = new SceneRenderer(map, url, { source: 'draft', prefix: 'dg', opacity: 0.75 });
    map.addSource(OVERLAY, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, maxzoom: 24 });
    for (const l of overlayLayers(this.color())) map.addLayer(l);

    map.on('mousedown', this.onDown);
    map.on('mousemove', this.onMove);
    map.on('click', this.onClick);
    map.on('dblclick', this.onDblClick);
    // Touch: one finger on your unit drags it (the map does not pan); taps arrive as clicks.
    map.on('touchstart', this.onTouchStart);
    map.on('touchmove', this.onTouchMove);
    map.on('touchend', this.onUp);
    map.on('touchcancel', this.onUp);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('tacmap:draw', this.onDrawCmd);
    this.unsub = usePlay.subscribe((s, p) => {
      if (s.tool !== p.tool) {
        this.pts = null;
        this.cursor = null;
        map.getCanvas().style.cursor = s.tool === 'select' ? '' : 'crosshair';
      }
      if (s.targeting !== p.targeting) map.getCanvas().style.cursor = s.targeting ? 'crosshair' : '';
      if (s.state !== p.state || s.draft !== p.draft || s.sel !== p.sel || s.tool !== p.tool || s.allocId !== p.allocId || s.buyId !== p.buyId || s.viewing !== p.viewing) this.draw();
    });
    this.draw();
  }

  destroy() {
    this.unsub();
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('tacmap:draw', this.onDrawCmd);
    this.live.destroy();
    this.draft.destroy();
  }

  private color = () => S().state?.player.color ?? DEFAULT_COLOR;

  private draw() {
    const { state, draft, sel, viewing, tool, allocId, buyId } = S();
    if (!state) return;
    // Allocation and tech graphics may not be on the live map yet, so they are not in state.assets.
    const assets = new Map([...state.allocation_assets, ...(state.tech_assets ?? []), ...state.assets, ...(viewing?.assets ?? [])].map((a) => [a.id, a]));
    const out: GjFeature[] = [];
    const add = (geometry: GjFeature['geometry'], o: string) => out.push({ type: 'Feature', geometry, properties: { o } });
    const e = effective(sel);

    if (viewing) {
      this.live.update(viewing.layers, viewing.features, assets);
      this.draft.update(GHOST_LAYERS, [], assets);
    } else {
      this.live.update(state.layers, state.features, assets);
      this.draft.update(GHOST_LAYERS, ghostFeatures(draft, state.features, this.color()), assets);
      const mine = new Set(state.mine);
      for (const f of state.features) {
        if (!mine.has(f.id)) continue;
        if (f.geometry.type === 'Point') add(f.geometry, 'mine');
        // How far this unit may go this turn, drawn around where it started.
        const r = state.radii[f.id];
        if (r != null && r > 0 && state.turn) add(circlePoly(anchorOf(f.geometry), r), f.id === sel ? 'range-sel' : 'range');
      }
      const alloc = tool === 'place' ? state.allocations.find((a) => a.id === allocId) : e?.change?.op === 'create' ? state.allocations.find((a) => a.id === (e.change as { payload: CreatePayload }).payload.allocation_id) : undefined;
      if (alloc?.zone) add(zoneGeometry(alloc.zone), 'zone');
      // Where a purchase may go: spawn zones and the circles around this player's spawn-point units.
      const buyItem = state.tech.find((x) => x.id === (tool === 'buy' ? buyId : e?.change?.op === 'create' ? (e.change as { payload: CreatePayload }).payload.purchase_id : null));
      if (buyItem && buyItem.placement !== 'anywhere') {
        if (buyItem.placement !== 'spawn') for (const z of state.spawn_zones) add(zoneGeometry(z.zone), 'zone');
        if (buyItem.placement !== 'zone') for (const sp of sourcesFor(buyItem, state.spawn_points)) add(circlePoly(sp.center, sp.radius_m), 'zone');
      }
    }
    if (!viewing) {
      // My declared attacks this turn, and the fights my units are in.
      const at = (fid: string): Pos | null => {
        const c = draft.find((x) => x.feature_id === fid);
        if (c?.op === 'update' && c.payload.geometry) return anchorOf(c.payload.geometry);
        const f = state.features.find((x) => x.id === fid);
        return f ? anchorOf(f.geometry) : null;
      };
      for (const c of draft) {
        if (c.op !== 'update' || !c.payload.attacks) continue;
        const from = at(c.feature_id);
        for (const a of c.payload.attacks) {
          const to = at(a.target);
          if (from && to) add({ type: 'LineString', coordinates: [from, to] }, 'atk');
        }
      }
      for (const eg of state.combat?.engagements ?? []) {
        const ids = eg.units ?? [];
        for (const m of ids.filter((x) => state.combat.own[x])) for (const o of ids.filter((x) => !state.combat.own[x])) {
          const a = at(m), b = at(o);
          if (a && b) add({ type: 'LineString', coordinates: [a, b] }, 'eng');
        }
      }
    }
    if (e) add(e.f.geometry, e.f.geometry.type === 'Point' ? 'selpt' : 'sel');
    if (this.pts) {
      const line = this.cursor ? [...this.pts, this.cursor] : this.pts;
      if (line.length > 1) add({ type: 'LineString', coordinates: tool === 'polygon' && line.length > 2 ? [...line, line[0]] : line }, 'draw');
      for (const p of this.pts) add({ type: 'Point', coordinates: p }, 'v');
    }
    (this.map.getSource(OVERLAY) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: out });
    const n = this.pts?.length ?? 0;
    if (S().drawing !== n) usePlay.setState({ drawing: n });
  }

  /** Id of the object under the pointer: draft objects first, then the live map. A finger gets a bigger target. */
  private hit(pt: { x: number; y: number }, r = 5): string | null {
    const box: [[number, number], [number, number]] = [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]];
    const d = this.map.queryRenderedFeatures(box, { layers: DRAFT_HIT })[0];
    if (d && !S().viewing) return baseId(String(d.properties.fid));
    const l = this.map.queryRenderedFeatures(box, { layers: LIVE_HIT })[0];
    return l ? String(l.properties.fid) : null;
  }

  private create(payload: CreatePayload) {
    const id = crypto.randomUUID();
    if (S().put({ op: 'create', feature_id: id, payload })) usePlay.setState({ sel: id, tool: 'select', allocId: null, buyId: null });
  }

  private place(tool: PTool, at: Pos) {
    const s = S();
    const geometry: Feature['geometry'] = { type: 'Point', coordinates: at };
    if (tool === 'text') {
      return this.create({ kind: 'text', geometry, props: { name: 'Note', fontSize: 16 }, style: { color: this.color() } });
    }
    if (tool === 'buy') return this.buy(at);
    // Reinforcements come out of an allocation; the allocation decides what the unit is.
    const a = s.state?.allocations.find((x) => x.id === s.allocId);
    if (!a) return s.say('Pick a reinforcement first');
    if (remaining(a, s.draft) <= 0) return s.say('None left in that allocation');
    if (!inZone(a.zone, at)) return s.say('Outside the placement zone (dashed outline)');
    const left = remaining(a, s.draft) - 1;
    // In my colour straight away; the server sets the same when the draft is saved.
    const tint = s.state?.player.color ?? undefined;
    if (a.asset_id) this.create({ kind: 'asset', geometry, asset_id: a.asset_id, allocation_id: a.id, props: { ...a.props, tint } });
    else this.create({ kind: 'symbol', geometry, allocation_id: a.id, props: { ...a.props, sidc: a.sidc ?? undefined, tint } });
    // Keep placing while there are units left in the allocation.
    if (left > 0 && S().sel) usePlay.setState({ tool: 'place', allocId: a.id });
  }

  /** Buy one unit of the picked tech item and put it here. The tech item decides what the unit is. */
  private buy(at: Pos) {
    const s = S();
    const st = s.state;
    const it = st?.tech.find((x) => x.id === s.buyId);
    if (!st || !it) return s.say('Pick something to buy first');
    if (!usable(it, st.economy.tech_unlocked, s.draft)) return s.say(`${it.name} is not researched yet`);
    if (pointsLeft().spawn < it.spawn_cost) return s.say(`Not enough spawn points for ${it.name}`);
    if (!canPlace(it, at, st.spawn_zones, st.spawn_points)) return s.say(`${it.name} must be placed ${whereText(it, st.tech)} (dashed outlines)`);
    const geometry: Feature['geometry'] = { type: 'Point', coordinates: at };
    const props = { ...it.props, name: it.props.name || it.name, tint: st.player.color ?? undefined };
    if (it.asset_id) this.create({ kind: 'asset', geometry, asset_id: it.asset_id, purchase_id: it.id, props });
    else this.create({ kind: 'symbol', geometry, purchase_id: it.id, props: { ...props, sidc: it.sidc ?? undefined } });
    // Keep buying while the player can afford another.
    if (pointsLeft().spawn >= it.spawn_cost && S().sel) usePlay.setState({ tool: 'buy', buyId: it.id });
  }

  private finish() {
    const tool = S().tool;
    const pts = (this.pts ?? []).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    this.pts = null;
    this.cursor = null;
    const color = this.color();
    if (tool === 'polygon' && pts.length >= 3) {
      this.create({ kind: 'polygon', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] }, style: { color, width: 2, dash: 'solid', fillOpacity: 0.15 } });
    } else if ((tool === 'arrow' || tool === 'line') && pts.length >= 2) {
      this.create({ kind: tool, geometry: { type: 'LineString', coordinates: pts }, style: { color, width: 3, dash: 'solid', fillOpacity: 0 } });
    } else {
      this.draw();
    }
  }

  private onDown = (e: MapMouseEvent) => {
    if (e.originalEvent.button !== 0) return;
    this.grab(e, 5);
  };
  private onTouchStart = (e: MapTouchEvent) => {
    if (e.points.length !== 1) {
      this.drag = null; // a second finger means zoom or rotate
      return;
    }
    this.grab(e, 16);
  };
  private onTouchMove = (e: MapTouchEvent) => {
    if (!this.drag) return;
    if (e.points.length !== 1) return void (this.drag = null);
    e.preventDefault();
    this.onMove(e);
  };
  /** Start dragging the player's own unit under the pointer or finger. */
  private grab(e: MapMouseEvent | MapTouchEvent, r: number) {
    if (S().tool !== 'select' || !S().editable()) return;
    const id = this.hit(e.point, r);
    const eff = effective(id);
    if (!id || !eff?.mine || eff.change?.op === 'delete') return;
    e.preventDefault(); // no map panning while an object is dragged
    this.drag = { fid: id, grab: [e.lngLat.lng, e.lngLat.lat], from: anchorOf(eff.f.geometry) };
    usePlay.setState({ sel: id });
  }
  /** Set the target of one weapon from a click on the map. Only another player's ground unit the player can see qualifies. */
  private pickTarget(tg: { fid: string; slot: number }, id: string | null) {
    const s = S();
    const c = s.state?.combat;
    usePlay.setState({ targeting: null });
    if (!id || !c) return s.say('No unit there. Pick the target again.');
    if (c.own[id]) return s.say('That is one of your own units.');
    if (!s.state!.features.some((f) => f.id === id) || c.seen[id]?.ground === false) return s.say('That is not a ground unit you can attack.');
    const cur = s.draft.find((x) => x.feature_id === tg.fid);
    const attacks = (cur?.op === 'update' ? cur.payload.attacks ?? [] : []).filter((a) => a.slot !== tg.slot);
    s.put({ op: 'update', feature_id: tg.fid, payload: { attacks: [...attacks, { slot: tg.slot, target: id }].sort((a, b) => a.slot - b.slot) } });
    usePlay.setState({ sel: tg.fid });
  }

  /** Buttons for touch screens, where there is no Enter key and double-tap is unreliable. */
  private onDrawCmd = (e: Event) => {
    const cmd = (e as CustomEvent<'finish' | 'undo' | 'cancel'>).detail;
    if (!this.pts) return;
    if (cmd === 'finish') this.finish();
    else if (cmd === 'undo') {
      this.pts = this.pts.slice(0, -1);
      if (!this.pts.length) this.pts = null;
      this.draw();
    } else {
      this.pts = null;
      this.cursor = null;
      this.draw();
    }
  };

  /** Where the dragged object's anchor may go: inside its movement range, or inside its placement zone. */
  private allowed(fid: string, want: Pos): Pos | null {
    const s = S();
    const eff = effective(fid);
    if (!eff || !s.state) return null;
    if (eff.isNew) {
      const c = eff.change as { payload: CreatePayload };
      const bought = c.payload.purchase_id ? s.state.tech.find((x) => x.id === c.payload.purchase_id) : undefined;
      if (bought) return canPlace(bought, want, s.state.spawn_zones, s.state.spawn_points) ? want : null;
      const zone = s.state.allocations.find((a) => a.id === c.payload.allocation_id)?.zone ?? null;
      return inZone(zone, want) ? want : null;
    }
    // A unit in a fight only moves when ordered to retreat.
    if (s.state.combat?.own[fid]?.engaged && !(eff.change?.op === 'update' && eff.change.payload.retreat)) {
      if (!this.warned) s.say('This unit is engaged in combat. Tick "Retreat" in its details to move it.');
      this.warned = true;
      return null;
    }
    return clampToRadius(anchorOf(eff.live!.geometry), want, s.state.radii[fid]);
  }

  private onMove = (e: MapMouseEvent | MapTouchEvent) => {
    const now: Pos = [e.lngLat.lng, e.lngLat.lat];
    const d = this.drag;
    if (d) {
      const eff = effective(d.fid);
      if (!eff) return;
      // Target = where the anchor was when grabbed, plus how far the pointer has travelled since.
      const g0 = toMerc(d.grab);
      const g1 = toMerc(now);
      const f0 = toMerc(d.from);
      const target = this.allowed(d.fid, fromMerc([f0[0] + g1[0] - g0[0], f0[1] + g1[1] - g0[1]]));
      if (!target) return;
      const base = eff.live?.geometry ?? eff.f.geometry;
      const a = toMerc(anchorOf(base));
      const b = toMerc(target);
      const geometry = base.type === 'Point' ? { type: 'Point' as const, coordinates: target } : translateGeom(base, b[0] - a[0], b[1] - a[1]);
      S().put({ op: 'update', feature_id: d.fid, payload: { geometry } });
      return;
    }
    if (this.pts) {
      this.cursor = now;
      this.draw();
    } else if (S().tool === 'select') {
      const eff = effective(this.hit(e.point));
      this.map.getCanvas().style.cursor = eff ? (eff.mine && eff.change?.op !== 'delete' && S().editable() ? 'move' : 'pointer') : '';
    }
  };

  private warned = false;
  private onUp = () => {
    this.drag = null;
    this.warned = false;
  };

  private onClick = (e: MapMouseEvent) => {
    const tool = S().tool;
    const at: Pos = [e.lngLat.lng, e.lngLat.lat];
    if (tool === 'measure') return; // the measuring tool takes the clicks
    const tg = S().targeting;
    if (tg) return this.pickTarget(tg, this.hit(e.point, 12));
    if (tool === 'select') return usePlay.setState({ sel: this.hit(e.point, 10) });
    if (!S().editable()) return void S().put({ op: 'delete', feature_id: '' }); // explains why not
    if (!DRAW.includes(tool)) return this.place(tool, at);
    this.pts = [...(this.pts ?? []), at];
    this.cursor = at;
    this.draw();
  };

  private onDblClick = (e: MapMouseEvent) => {
    e.preventDefault(); // no zoom
    if (this.pts) this.finish();
  };

  private onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (e.key === 'Enter' && this.pts) this.finish();
    else if (e.key === 'Backspace' && this.pts) {
      this.pts = this.pts.slice(0, -1);
      if (!this.pts.length) this.pts = null;
      this.draw();
    } else if (e.key === 'Escape') {
      if (this.pts) {
        this.pts = null;
        this.cursor = null;
        this.draw();
      } else S().setTool('select');
    }
  };
}
