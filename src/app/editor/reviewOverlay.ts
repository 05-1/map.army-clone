// Draws the turn in progress over the live map: every player's draft as translucent ghosts in that
// player's colour, placement zones, and conflict markers. While one draft is picked for editing its
// ghosts can be dragged. Nothing here writes to the live map; edits become the draft's owner_changes,
// which push_turn() validates again.
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { toMerc, translateGeom } from '../lib/geo';
import { hitLayers, SceneRenderer } from '../lib/scene';
import { baseId, effectiveChanges, findConflicts, ghostFeatures, GHOST_LAYER, GHOST_LAYERS, putChange, zoneParts } from '../lib/submissions';
import { DEFAULT_STYLE, type Asset, type Change, type Feature, type Pos } from '../lib/types';
import { useEd } from './store';

const GHOST_HIT = hitLayers('gh');
const DEFAULT_COLOR = '#f2a93b';

export class ReviewOverlay {
  private renderer: SceneRenderer;
  private unsub: () => void;
  private drag: { fid: string; last: Pos; moved: boolean } | null = null;

  /** onCommit is called when a drag ends, so the edited draft can be saved. */
  constructor(private map: MlMap, urlFor: (a: Asset) => string, private onCommit: (playerId: string) => void) {
    this.renderer = new SceneRenderer(map, urlFor, { source: 'ghost', prefix: 'gh', opacity: 0.62 });
    this.unsub = useEd.subscribe((s, p) => {
      if (s.review !== p.review || s.bundle !== p.bundle || s.showDrafts !== p.showDrafts || s.viewing !== p.viewing
        || s.features !== p.features || s.assets !== p.assets || s.players !== p.players) this.draw();
    });
    map.on('mousedown', this.onDown);
    map.on('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    this.draw();
  }

  destroy() {
    this.unsub();
    this.map.off('mousedown', this.onDown);
    this.map.off('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    this.renderer.destroy();
  }

  private draw() {
    const s = useEd.getState();
    const assets = new Map(s.assets.map((a) => [a.id, a]));
    const b = s.bundle;
    if (!b || s.viewing) return this.renderer.update(GHOST_LAYERS, [], assets);

    const out: Feature[] = [];
    const extra = (id: string, kind: Feature['kind'], geometry: Feature['geometry'], props: Feature['props'], style: Partial<Feature['style']>) =>
      out.push({ id, layer_id: GHOST_LAYER, kind, geometry, props, style: { ...DEFAULT_STYLE, ...style }, asset_id: null, z: out.length });
    const colorOf = (playerId: string | null) => s.players.find((p) => p.id === playerId)?.color ?? DEFAULT_COLOR;

    // Spawn zones are always shown to the owner (dotted), whether or not a turn is running.
    for (const z of b.economy?.zones ?? []) {
      const color = z.player_id ? colorOf(z.player_id) : z.team ? s.players.find((p) => p.team === z.team)?.color ?? DEFAULT_COLOR : '#ffffff';
      zoneParts(z.zone).forEach((g, i) => extra(`spawn~${z.id}~${i}`, 'polygon', g, {}, { color, width: 1.5, dash: 'dot', fillOpacity: 0.05 }));
    }
    if (!b.turn || !s.showDrafts) return this.renderer.update(GHOST_LAYERS, out, assets);
    for (const a of b.allocations) {
      if (!a.zone) continue;
      const color = a.player_id ? colorOf(a.player_id) : s.players.find((p) => p.team === a.team)?.color ?? DEFAULT_COLOR;
      zoneParts(a.zone).forEach((g, i) => extra(`zone~${a.id}~${i}`, 'polygon', g, {}, { color, width: 1.5, dash: 'dash', fillOpacity: 0.06 }));
    }
    const accepted = b.drafts.map((d) => ({ player_id: d.player_id, changes: effectiveChanges(d) }));
    for (const d of accepted) {
      for (const f of ghostFeatures(d.changes, s.features, colorOf(d.player_id))) out.push({ ...f, z: out.length });
    }
    for (const c of findConflicts(s.features, accepted, b.turn.conflict_m)) {
      extra(`conflict~${c.a}~${c.b}`, 'circle', { type: 'Point', coordinates: c.at }, { radius: Math.max(b.turn.conflict_m! / 2, c.distance / 2) }, { color: '#ff453a', width: 2.5, dash: 'dot', fillOpacity: 0.12 });
    }
    this.renderer.update(GHOST_LAYERS, out, assets);
  }

  /** The change under the pointer, if it belongs to the draft being edited. */
  private changeAt(e: MapMouseEvent): Change | null {
    const s = useEd.getState();
    const d = s.bundle?.drafts.find((x) => x.player_id === s.review?.playerId);
    if (!d) return null;
    const { x, y } = e.point;
    const changes = effectiveChanges(d);
    for (const hit of this.map.queryRenderedFeatures([[x - 5, y - 5], [x + 5, y + 5]], { layers: GHOST_HIT })) {
      const c = changes.find((ch) => ch.feature_id === baseId(String(hit.properties.fid)));
      if (c && c.op !== 'delete') return c;
    }
    return null;
  }

  private onDown = (e: MapMouseEvent) => {
    if (e.originalEvent.button !== 0) return;
    const c = this.changeAt(e);
    if (!c) return;
    e.preventDefault(); // keep the map from panning while a ghost is dragged
    this.drag = { fid: c.feature_id, last: [e.lngLat.lng, e.lngLat.lat], moved: false };
  };

  private onMove = (e: MapMouseEvent) => {
    const s = useEd.getState();
    if (!s.review) return;
    const drag = this.drag;
    if (!drag) {
      this.map.getCanvas().style.cursor = this.changeAt(e) ? 'move' : '';
      return;
    }
    const d = s.bundle?.drafts.find((x) => x.player_id === s.review!.playerId);
    if (!d) return;
    const current = d.owner_changes ?? d.changes;
    const c = current.find((x) => x.feature_id === drag.fid);
    const geom = c?.op === 'create' ? c.payload.geometry : c?.op === 'update' ? c.payload.geometry ?? s.features.find((f) => f.id === drag.fid)?.geometry : null;
    if (!c || !geom) return;
    const now: Pos = [e.lngLat.lng, e.lngLat.lat];
    const a = toMerc(drag.last);
    const b = toMerc(now);
    drag.last = now;
    drag.moved = true;
    s.setOwnerChanges(d.player_id, putChange(current, { op: 'update', feature_id: drag.fid, payload: { geometry: translateGeom(geom, b[0] - a[0], b[1] - a[1]) } }));
  };

  private onUp = () => {
    const pid = useEd.getState().review?.playerId;
    if (this.drag?.moved && pid) this.onCommit(pid);
    this.drag = null;
  };
}
