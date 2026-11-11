// Mouse and keyboard controller for the editor: selecting, dragging, vertex editing, rotating,
// drawing, snapping, clipboard and shortcuts. Owns an "overlay" source for handles and previews.
import type { Feature as GjFeature } from 'geojson';
import type { GeoJSONSource, LayerSpecification, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import {
  bearing, centerOf, circlePoly, coordsOf, destinationPt, distanceM, fmtDist, midpoint, norm360, rotateGeom, toMerc, translateGeom,
} from '../lib/geo';
import { HIT_LAYERS } from '../lib/scene';
import { buildSidc } from '../lib/symbols';
import type { Feature, Kind, Pos } from '../lib/types';
import { useEd, type Tool } from './store';

const S = () => useEd.getState();
const OVERLAY = 'overlay';
const SNAP_PX = 10;
const DRAW_TOOLS: Tool[] = ['line', 'arrow', 'polygon', 'circle'];

type Geom = Feature['geometry'];
type Drag =
  | { t: 'move'; start: Pos; startPx: { x: number; y: number }; orig: Map<string, Geom>; moved: boolean }
  | { t: 'vertex'; fid: string; i: number; moved: boolean }
  | { t: 'rotate'; fid: string; pivot: Pos; a0: number; orig: Feature; moved: boolean }
  | { t: 'radius'; fid: string; moved: boolean }
  | { t: 'marquee'; x: number; y: number }
  | { t: 'freehand'; pts: Pos[]; last: { x: number; y: number } };

let clipboard: Feature[] = [];

const verts = (f: Feature): Pos[] =>
  f.geometry.type === 'LineString' ? (f.geometry.coordinates as Pos[])
  : f.geometry.type === 'Polygon' ? (f.geometry.coordinates[0].slice(0, -1) as Pos[])
  : [];
const withVerts = (f: Feature, v: Pos[]): Geom =>
  f.geometry.type === 'Polygon' ? { type: 'Polygon', coordinates: [[...v, v[0]]] } : { type: 'LineString', coordinates: v };

const overlayLayers = [
  { id: 'ov-sel-line', type: 'line', source: OVERLAY, filter: ['==', ['get', 'o'], 'sel'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#35c7f0', 'line-width': 1.5, 'line-dasharray': [3, 3] } },
  { id: 'ov-sel-pt', type: 'circle', source: OVERLAY, filter: ['==', ['get', 'o'], 'selpt'],
    paint: { 'circle-radius': ['get', 'r'], 'circle-color': 'rgba(53,199,240,0.10)', 'circle-stroke-color': '#35c7f0', 'circle-stroke-width': 1.5 } },
  { id: 'ov-draft-fill', type: 'fill', source: OVERLAY, filter: ['==', ['get', 'o'], 'draftfill'],
    paint: { 'fill-color': '#35c7f0', 'fill-opacity': 0.12 } },
  { id: 'ov-draft', type: 'line', source: OVERLAY, filter: ['in', ['get', 'o'], ['literal', ['draft', 'draftfill', 'stem']]],
    paint: { 'line-color': '#35c7f0', 'line-width': 2, 'line-dasharray': [2, 2] } },
  { id: 'ov-handles', type: 'circle', source: OVERLAY, filter: ['==', ['get', 'o'], 'h'],
    paint: {
      'circle-radius': ['match', ['get', 'h'], 'm', 4, 'r', 7, 6],
      'circle-color': ['match', ['get', 'h'], 'm', '#35c7f0', 'r', '#f2a93b', '#ffffff'],
      'circle-stroke-color': '#0d1014', 'circle-stroke-width': 1.5,
    } },
] as unknown as LayerSpecification[];

export class Interaction {
  private drag: Drag | null = null;
  private draft: Pos[] | null = null;
  private cursor: Pos | null = null;
  private raf = 0;
  private unsub: () => void;

  constructor(private map: MlMap, private marquee: HTMLDivElement) {
    map.addSource(OVERLAY, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, maxzoom: 24 });
    for (const l of overlayLayers) map.addLayer(l);
    map.on('mousedown', this.onDown);
    map.on('mousemove', this.onMove);
    map.on('mouseup', this.onUp);
    map.on('click', this.onClick);
    map.on('dblclick', this.onDblClick);
    map.on('move', this.schedule);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKey);
    this.unsub = useEd.subscribe((s, p) => {
      if (s.tool !== p.tool) {
        this.draft = null;
        this.setCursor();
      }
      this.schedule();
    });
    this.setCursor();
  }

  destroy() {
    this.unsub();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
  }

  // ----- helpers ----------------------------------------------------------

  private setCursor(c?: string) {
    this.map.getCanvas().style.cursor = c ?? (S().tool === 'select' ? '' : 'crosshair');
  }

  private hit(pt: { x: number; y: number }): Feature | null {
    const st = S();
    const locked = new Set(st.layers.filter((l) => l.locked).map((l) => l.id));
    const found = this.map.queryRenderedFeatures([[pt.x - 5, pt.y - 5], [pt.x + 5, pt.y + 5]], { layers: HIT_LAYERS });
    for (const g of found) {
      const f = st.features.find((x) => x.id === g.properties.fid);
      if (f && !locked.has(f.layer_id)) return f;
    }
    return null;
  }

  private handleAt(pt: { x: number; y: number }) {
    const h = this.map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: ['ov-handles'] })[0];
    return h ? (h.properties as { h: 'v' | 'm' | 'r' | 'rad'; i: number }) : null;
  }

  /** Snap to the nearest existing vertex or point within SNAP_PX. Alt bypasses. */
  private snap(e: MapMouseEvent, excludeFid?: string): Pos {
    const raw: Pos = [e.lngLat.lng, e.lngLat.lat];
    const st = S();
    if (!st.snap || e.originalEvent.altKey) return raw;
    const visible = new Set(st.layers.filter((l) => l.visible).map((l) => l.id));
    let best = raw;
    let bestD = SNAP_PX;
    const test = (p: Pos) => {
      const s = this.map.project(p);
      const d = Math.hypot(s.x - e.point.x, s.y - e.point.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    for (const f of st.features) {
      if (f.id === excludeFid || !visible.has(f.layer_id)) continue;
      for (const p of coordsOf(f.geometry)) test(p);
    }
    if (this.draft) for (const p of this.draft) test(p);
    return best;
  }

  private selected(): Feature[] {
    const st = S();
    const sel = new Set(st.selection);
    return st.features.filter((f) => sel.has(f.id));
  }

  /** Clockwise screen angle from "up", pivot -> point, in degrees. */
  private screenAngle(pivot: Pos, pt: { x: number; y: number }) {
    const c = this.map.project(pivot);
    return norm360((Math.atan2(pt.x - c.x, -(pt.y - c.y)) * 180) / Math.PI);
  }

  private pxToMerc = (px: number) => px / (512 * 2 ** this.map.getZoom());

  // ----- creating ---------------------------------------------------------

  private make(kind: Kind, geometry: Geom, props: Feature['props'] = {}, assetId: string | null = null): Feature | null {
    const st = S();
    const layer = st.targetLayer();
    if (!layer) return null;
    return { id: crypto.randomUUID(), layer_id: layer.id, kind, geometry, props, style: { ...st.style }, asset_id: assetId, z: st.nextZ() };
  }

  private placePoint(tool: Tool, at: Pos) {
    const st = S();
    const g: Geom = { type: 'Point', coordinates: at };
    let f: Feature | null = null;
    if (tool === 'symbol') {
      f = this.make('symbol', g, { sidc: buildSidc(st.symbolDraft), sizePx: 34 });
    } else if (tool === 'asset') {
      const a = st.assets.find((x) => x.id === st.assetDraft.assetId);
      if (!a) return st.say('Pick a graphic from the library first');
      const d = st.assetDraft;
      f = this.make('asset', g, { name: a.name, heading: 0, sizeMode: d.sizeMode, sizePx: d.sizePx, sizeM: d.sizeM, showLabel: true }, a.id);
    } else if (tool === 'text') {
      f = this.make('text', g, { name: 'Text', fontSize: 18 });
    }
    if (!f) return;
    st.add([f]);
    if (tool === 'text') {
      st.setTool('select');
      window.dispatchEvent(new Event('tacmap:focus-name'));
    }
  }

  private finishDraft() {
    const st = S();
    const tool = st.tool;
    // A double click delivers two clicks first; drop consecutive duplicates.
    const pts = (this.draft ?? []).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    this.draft = null;
    let f: Feature | null = null;
    if ((tool === 'line' || tool === 'arrow') && pts.length >= 2) {
      f = this.make(tool, { type: 'LineString', coordinates: pts });
    } else if (tool === 'polygon' && pts.length >= 3) {
      f = this.make('polygon', { type: 'Polygon', coordinates: [[...pts, pts[0]]] });
    } else if (tool === 'circle' && pts.length >= 2) {
      f = this.make('circle', { type: 'Point', coordinates: pts[0] }, { radius: Math.round(distanceM(pts[0], pts[1])) });
    }
    if (f) {
      st.add([f]);
      st.setTool('select');
    }
    useEd.setState({ hint: '' });
    this.schedule();
  }

  // ----- mouse ------------------------------------------------------------

  private onDown = (e: MapMouseEvent) => {
    if (e.originalEvent.button !== 0 || S().review || S().viewing) return;
    const st = S();
    const ll: Pos = [e.lngLat.lng, e.lngLat.lat];

    if (st.tool === 'freehand') {
      e.preventDefault();
      this.drag = { t: 'freehand', pts: [ll], last: e.point };
      return;
    }
    if (st.tool !== 'select') return;

    const sel = this.selected();
    const h = sel.length === 1 ? this.handleAt(e.point) : null;
    if (h) {
      e.preventDefault();
      const f = sel[0];
      if (h.h === 'v') this.drag = { t: 'vertex', fid: f.id, i: h.i, moved: false };
      else if (h.h === 'm') {
        st.checkpoint();
        const v = verts(f);
        v.splice(h.i, 0, ll);
        st.patch([f.id], (x) => ({ ...x, geometry: withVerts(x, v) }));
        this.drag = { t: 'vertex', fid: f.id, i: h.i, moved: true };
      } else if (h.h === 'rad') this.drag = { t: 'radius', fid: f.id, moved: false };
      else {
        const pivot = centerOf(f.geometry);
        this.drag = { t: 'rotate', fid: f.id, pivot, a0: this.screenAngle(pivot, e.point), orig: f, moved: false };
      }
      return;
    }

    const f = this.hit(e.point);
    if (f) {
      e.preventDefault();
      if (e.originalEvent.shiftKey) {
        st.select(st.selection.includes(f.id) ? st.selection.filter((id) => id !== f.id) : [...st.selection, f.id]);
        return;
      }
      if (!st.selection.includes(f.id)) st.select([f.id]);
      const orig = new Map(this.selected().map((x) => [x.id, x.geometry]));
      this.drag = { t: 'move', start: toMerc(ll), startPx: e.point, orig, moved: false };
      return;
    }

    if (e.originalEvent.shiftKey) {
      e.preventDefault();
      this.drag = { t: 'marquee', x: e.point.x, y: e.point.y };
    }
  };

  private onMove = (e: MapMouseEvent) => {
    const st = S();
    const ll: Pos = [e.lngLat.lng, e.lngLat.lat];
    const d = this.drag;

    if (!d) {
      if (this.draft) {
        this.cursor = this.snap(e);
        const last = this.draft[this.draft.length - 1];
        const dist = distanceM(last, this.cursor);
        useEd.setState({ hint: st.tool === 'circle' ? `radius ${fmtDist(dist)}` : `${fmtDist(dist)}  ·  ${bearing(last, this.cursor).toFixed(0)}°` });
        this.schedule();
      } else {
        this.cursor = ll;
        if (st.tool === 'select') this.setCursor(this.handleAt(e.point) ? 'grab' : this.hit(e.point) ? 'move' : '');
      }
      return;
    }

    switch (d.t) {
      case 'move': {
        if (!d.moved) {
          if (Math.hypot(e.point.x - d.startPx.x, e.point.y - d.startPx.y) < 3) return;
          st.checkpoint();
          d.moved = true;
        }
        const m = toMerc(ll);
        const dx = m[0] - d.start[0];
        const dy = m[1] - d.start[1];
        st.setFeatures((fs) => fs.map((f) => (d.orig.has(f.id) ? { ...f, geometry: translateGeom(d.orig.get(f.id)!, dx, dy) } : f)));
        break;
      }
      case 'vertex': {
        if (!d.moved) {
          st.checkpoint();
          d.moved = true;
        }
        const p = this.snap(e, d.fid);
        st.patch([d.fid], (f) => {
          const v = [...verts(f)];
          v[d.i] = p;
          return { ...f, geometry: withVerts(f, v) };
        });
        break;
      }
      case 'radius': {
        if (!d.moved) {
          st.checkpoint();
          d.moved = true;
        }
        st.patch([d.fid], (f) => {
          const radius = Math.max(1, Math.round(distanceM(f.geometry.coordinates as Pos, this.snap(e, d.fid))));
          useEd.setState({ hint: `radius ${fmtDist(radius)}` });
          return { ...f, props: { ...f.props, radius } };
        });
        break;
      }
      case 'rotate': {
        if (!d.moved) {
          st.checkpoint();
          d.moved = true;
        }
        let a = this.screenAngle(d.pivot, e.point);
        const step = (v: number) => (e.originalEvent.shiftKey ? Math.round(v / 15) * 15 : Math.round(v));
        if (d.orig.geometry.type === 'Point') {
          // The handle sits in the heading direction, so the heading is simply where the cursor is.
          const heading = norm360(step(a + this.map.getBearing()));
          useEd.setState({ hint: `heading ${heading.toFixed(0)}°` });
          st.patch([d.fid], (f) => ({ ...f, props: { ...f.props, heading } }));
        } else {
          a = step(a - d.a0);
          st.patch([d.fid], (f) => ({ ...f, geometry: rotateGeom(d.orig.geometry, d.pivot, a) }));
        }
        break;
      }
      case 'marquee': {
        const s = this.marquee.style;
        s.display = 'block';
        s.left = `${Math.min(d.x, e.point.x)}px`;
        s.top = `${Math.min(d.y, e.point.y)}px`;
        s.width = `${Math.abs(e.point.x - d.x)}px`;
        s.height = `${Math.abs(e.point.y - d.y)}px`;
        break;
      }
      case 'freehand': {
        if (Math.hypot(e.point.x - d.last.x, e.point.y - d.last.y) < 4) return;
        d.pts.push(ll);
        d.last = e.point;
        this.schedule();
        break;
      }
    }
  };

  private onUp = (e: MapMouseEvent | MouseEvent) => {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const st = S();
    if (d.t === 'marquee') {
      this.marquee.style.display = 'none';
      if ('point' in e) {
        const locked = new Set(st.layers.filter((l) => l.locked).map((l) => l.id));
        const ids = new Set<string>();
        for (const g of this.map.queryRenderedFeatures([[d.x, d.y], [e.point.x, e.point.y]], { layers: HIT_LAYERS })) {
          const f = st.features.find((x) => x.id === g.properties.fid);
          if (f && !locked.has(f.layer_id)) ids.add(f.id);
        }
        st.select([...new Set([...st.selection, ...ids])]);
      }
    } else if (d.t === 'freehand') {
      if (d.pts.length >= 2) {
        const f = this.make('freehand', { type: 'LineString', coordinates: d.pts });
        if (f) st.add([f]);
      }
    }
    useEd.setState({ hint: '' });
    this.schedule();
  };

  private onClick = (e: MapMouseEvent) => {
    const st = S();
    if (st.review || st.viewing) return;
    const tool = st.tool;
    if (tool === 'select') {
      if (!e.originalEvent.shiftKey && !this.hit(e.point) && !this.handleAt(e.point)) st.select([]);
      return;
    }
    if (tool === 'symbol' || tool === 'asset' || tool === 'text') return this.placePoint(tool, this.snap(e));
    if (!DRAW_TOOLS.includes(tool)) return;
    if (!this.draft && !st.targetLayer()) return;
    const p = this.snap(e);
    this.draft = [...(this.draft ?? []), p];
    this.cursor = p;
    if (tool === 'circle' && this.draft.length === 2) return this.finishDraft();
    this.schedule();
  };

  private onDblClick = (e: MapMouseEvent) => {
    e.preventDefault();
    if (this.draft) this.finishDraft();
  };

  // ----- keyboard ---------------------------------------------------------

  private onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (document.querySelector('.modal')) return;
    const st = S();
    if (st.review || st.viewing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const done = () => e.preventDefault();

    if (mod) {
      if (k === 'z') return done(), e.shiftKey ? st.redo() : st.undo();
      if (k === 'y') return done(), st.redo();
      if (k === 'a') return done(), this.selectAll();
      if (k === 'c') return this.copy();
      if (k === 'x') return this.copy(), st.remove(st.selection);
      if (k === 'v') return done(), this.paste(true);
      if (k === 'd') return done(), this.copy(), this.paste(false);
      if (k === 's') return done(), window.dispatchEvent(new Event('tacmap:save'));
      return;
    }

    switch (e.key) {
      case 'Escape':
        if (this.draft) {
          this.draft = null;
          useEd.setState({ hint: '' });
          this.schedule();
        } else if (st.tool !== 'select') st.setTool('select');
        else st.select([]);
        return;
      case 'Enter':
        if (this.draft) this.finishDraft();
        return;
      case 'Backspace':
      case 'Delete':
        done();
        if (this.draft) {
          this.draft = this.draft.slice(0, -1);
          if (!this.draft.length) this.draft = null;
          this.schedule();
        } else st.remove(st.selection);
        return;
      case ']': return st.reorder(st.selection, 'front');
      case '[': return st.reorder(st.selection, 'back');
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!st.selection.length) return;
        done();
        const step = this.pxToMerc(e.shiftKey ? 10 : 1);
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (!e.repeat) st.checkpoint();
        st.patch(st.selection, (f) => ({ ...f, geometry: translateGeom(f.geometry, dx, dy) }));
        return;
      }
    }

    const tools: Record<string, Tool> = { v: 'select', s: 'symbol', g: 'asset', t: 'text', l: 'line', a: 'arrow', p: 'polygon', c: 'circle', f: 'freehand' };
    if (tools[k]) st.setTool(tools[k]);
  };

  private selectAll() {
    const st = S();
    const ok = new Set(st.layers.filter((l) => l.visible && !l.locked).map((l) => l.id));
    st.select(st.features.filter((f) => ok.has(f.layer_id)).map((f) => f.id));
  }

  private copy() {
    const sel = this.selected();
    if (sel.length) clipboard = sel;
  }

  private paste(atCursor: boolean) {
    const st = S();
    if (!clipboard.length) return;
    const layers = new Map(st.layers.map((l) => [l.id, l]));
    const fallback = st.targetLayer();
    // Land the group's centre on the cursor, or nudge it by 24 px for duplicate.
    const all = clipboard.flatMap((f) => coordsOf(f.geometry));
    const c = toMerc(centerOf({ type: 'LineString', coordinates: all }));
    const off = this.pxToMerc(24);
    const target = atCursor && this.cursor ? toMerc(this.cursor) : [c[0] + off, c[1] + off];
    let z = st.nextZ();
    const out: Feature[] = [];
    for (const f of clipboard) {
      const l = layers.get(f.layer_id);
      const layer = l && !l.locked && l.visible ? l : fallback;
      if (!layer) return;
      out.push({ ...f, id: crypto.randomUUID(), layer_id: layer.id, z: z++, geometry: translateGeom(f.geometry, target[0] - c[0], target[1] - c[1]) });
    }
    st.add(out);
  }

  // ----- overlay ----------------------------------------------------------

  private schedule = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  };

  private render() {
    const src = this.map.getSource(OVERLAY) as GeoJSONSource | undefined;
    if (!src) return;
    const st = S();
    const out: GjFeature[] = [];
    const add = (geometry: GjFeature['geometry'], properties: Record<string, unknown>) => out.push({ type: 'Feature', geometry, properties });
    const visible = new Set(st.layers.filter((l) => l.visible).map((l) => l.id));
    const sel = this.selected().filter((f) => visible.has(f.layer_id));

    for (const f of sel) {
      if (f.kind === 'circle') add(circlePoly(f.geometry.coordinates as Pos, f.props.radius ?? 1000), { o: 'sel' });
      else if (f.geometry.type === 'Point') {
        const r = f.kind === 'symbol' ? (f.props.sizePx ?? 34) * 0.9 : f.props.sizeMode === 'm' ? 16 : (f.props.sizePx ?? 40) / 2 + 6;
        add(f.geometry, { o: 'selpt', r: Math.max(12, Math.min(120, r)) });
      } else add(f.geometry, { o: 'sel' });
    }

    if (sel.length === 1 && st.tool === 'select') {
      const f = sel[0];
      const v = verts(f);
      if (v.length && v.length <= 60) {
        v.forEach((p, i) => add({ type: 'Point', coordinates: p }, { o: 'h', h: 'v', i }));
        const n = f.geometry.type === 'Polygon' ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) add({ type: 'Point', coordinates: midpoint(v[i], v[(i + 1) % v.length]) }, { o: 'h', h: 'm', i: i + 1 });
      }
      if (f.kind === 'circle') {
        const c = f.geometry.coordinates as Pos;
        add({ type: 'Point', coordinates: destinationPt(c, f.props.radius ?? 1000, 90) }, { o: 'h', h: 'rad', i: 0 });
      } else {
        // Rotation handle, positioned in screen space so it stays reachable at any zoom.
        const pivot = centerOf(f.geometry);
        const pc = this.map.project(pivot);
        let hx = pc.x;
        let hy = pc.y;
        if (f.geometry.type === 'Point') {
          const a = (((f.props.heading ?? 0) - this.map.getBearing()) * Math.PI) / 180;
          const r = f.kind === 'symbol' ? 58 : f.props.sizeMode === 'm' ? 48 : Math.max(40, (f.props.sizePx ?? 40) / 2 + 26);
          hx += Math.sin(a) * r;
          hy -= Math.cos(a) * r;
        } else {
          hy = Math.min(...coordsOf(f.geometry).map((p) => this.map.project(p).y)) - 28;
        }
        const hp = this.map.unproject([hx, hy]);
        add({ type: 'LineString', coordinates: [pivot, [hp.lng, hp.lat]] }, { o: 'stem' });
        add({ type: 'Point', coordinates: [hp.lng, hp.lat] }, { o: 'h', h: 'r', i: 0 });
      }
    }

    if (this.draft && this.cursor) {
      const pts = [...this.draft, this.cursor];
      if (st.tool === 'circle') add(circlePoly(pts[0], distanceM(pts[0], pts[1])), { o: 'draftfill' });
      else if (st.tool === 'polygon' && pts.length >= 3) add({ type: 'Polygon', coordinates: [[...pts, pts[0]]] }, { o: 'draftfill' });
      else add({ type: 'LineString', coordinates: pts }, { o: 'draft' });
      for (const p of this.draft) add({ type: 'Point', coordinates: p }, { o: 'h', h: 'm', i: -1 });
    }
    if (this.drag?.t === 'freehand' && this.drag.pts.length > 1) add({ type: 'LineString', coordinates: this.drag.pts }, { o: 'draft' });

    src.setData({ type: 'FeatureCollection', features: out });
  }
}
