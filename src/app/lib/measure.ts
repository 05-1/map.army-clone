// Measuring on any map page: distance along a path, or the area (and perimeter) of a shape.
// Purely local: nothing is saved or sent anywhere. Click to add points, double-click or Enter (or the
// panel's Finish button on a touch screen) to finish, Backspace removes the last point, Esc clears.
import type { Feature as GjFeature } from 'geojson';
import { Marker, type GeoJSONSource, type LayerSpecification, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { distanceM, fmtDist } from './geo';
import type { Pos } from './types';

export type MeasureMode = 'distance' | 'area';
export interface MeasureState {
  active: boolean;
  mode: MeasureMode;
  points: number;
  done: boolean;
  text: string;
}

const SRC = 'measure';
const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Length of a path in metres. */
export const pathLength = (pts: readonly Pos[]) => pts.slice(1).reduce((sum, p, i) => sum + distanceM(pts[i], p), 0);

/** Area of a closed shape on the sphere, in square metres. */
export function ringArea(pts: readonly Pos[]): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    a += rad(p2[0] - p1[0]) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1])));
  }
  return Math.abs((a * R * R) / 2);
}

export function fmtArea(m2: number): string {
  if (m2 >= 1e8) return `${(m2 / 1e6).toFixed(0)} km²`;
  if (m2 >= 1e5) return `${(m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(1)} ha`;
  return `${m2.toFixed(0)} m²`;
}

const LAYERS = [
  { id: 'ms-fill', type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffd60a', 'fill-opacity': 0.12 } },
  { id: 'ms-line', type: 'line', source: SRC, filter: ['!=', ['geometry-type'], 'Point'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffd60a', 'line-width': 2.5, 'line-dasharray': [3, 2] } },
  { id: 'ms-pt', type: 'circle', source: SRC, filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 4, 'circle-color': '#ffd60a', 'circle-stroke-color': '#0d1014', 'circle-stroke-width': 1.5 } },
] as unknown as LayerSpecification[];

export class Measure {
  private pts: Pos[] = [];
  private cursor: Pos | null = null;
  private done = false;
  private active = false;
  private mode: MeasureMode = 'distance';
  private label: Marker;
  private el = document.createElement('div');

  constructor(private map: MlMap, private onChange: (s: MeasureState) => void) {
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const l of LAYERS) map.addLayer(l);
    this.el.className = 'measurelabel';
    this.label = new Marker({ element: this.el, anchor: 'bottom', offset: [0, -10] });
    map.on('click', this.onClick);
    map.on('mousemove', this.onMove);
    map.on('dblclick', this.onDbl);
    window.addEventListener('keydown', this.onKey);
  }

  destroy() {
    this.map.off('click', this.onClick);
    this.map.off('mousemove', this.onMove);
    this.map.off('dblclick', this.onDbl);
    window.removeEventListener('keydown', this.onKey);
    this.label.remove();
    for (const l of LAYERS) if (this.map.getLayer(l.id)) this.map.removeLayer(l.id);
    if (this.map.getSource(SRC)) this.map.removeSource(SRC);
  }

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.clear();
    else this.draw();
  }
  setMode(mode: MeasureMode) {
    this.mode = mode;
    this.draw();
  }
  clear() {
    this.pts = [];
    this.cursor = null;
    this.done = false;
    this.draw();
  }
  undo() {
    if (this.done) this.done = false;
    else this.pts = this.pts.slice(0, -1);
    this.draw();
  }
  finish() {
    this.pts = this.pts.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    this.done = this.pts.length >= 2;
    this.cursor = null;
    this.draw();
  }
  /** Add a point, as a click would. */
  add(p: Pos) {
    if (this.done) {
      this.pts = [];
      this.done = false;
    }
    this.pts = [...this.pts, p];
    this.draw();
  }

  private onClick = (e: MapMouseEvent) => {
    if (this.active) this.add([e.lngLat.lng, e.lngLat.lat]);
  };
  private onMove = (e: MapMouseEvent) => {
    if (!this.active || this.done || !this.pts.length) return;
    this.cursor = [e.lngLat.lng, e.lngLat.lat];
    this.draw();
  };
  private onDbl = (e: MapMouseEvent) => {
    if (!this.active) return;
    e.preventDefault();
    this.finish();
  };
  private onKey = (e: KeyboardEvent) => {
    if (!this.active) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (e.key === 'Enter') this.finish();
    else if (e.key === 'Backspace' && this.pts.length) (e.preventDefault(), this.undo());
    else if (e.key === 'Escape' && this.pts.length) (e.stopImmediatePropagation(), this.clear());
  };

  /** Current reading, e.g. "12.4 km" or "38.2 km² · perimeter 26.1 km". */
  private reading(pts: Pos[]): string {
    if (pts.length < 2) return '';
    if (this.mode === 'distance') return fmtDist(pathLength(pts));
    if (pts.length < 3) return fmtDist(pathLength(pts));
    return `${fmtArea(ringArea(pts))} · perimeter ${fmtDist(pathLength([...pts, pts[0]]))}`;
  }

  private draw() {
    const live = this.done || !this.cursor ? this.pts : [...this.pts, this.cursor];
    const out: GjFeature[] = [];
    if (this.active) {
      if (this.mode === 'area' && live.length >= 3) out.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...live, live[0]]] } });
      else if (live.length >= 2) out.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: live } });
      for (const p of this.pts) out.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
    }
    (this.map.getSource(SRC) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: out });
    const text = this.active ? this.reading(live) : '';
    if (text) {
      this.el.textContent = text;
      this.label.setLngLat(live[live.length - 1]).addTo(this.map);
    } else this.label.remove();
    this.onChange({ active: this.active, mode: this.mode, points: this.pts.length, done: this.done, text });
  }
}
