// Turns the document (layers + features) into one GeoJSON source and a fixed set of MapLibre layers.
// Shared by the editor and the read-only viewer, so both always draw the same picture.
import type { Feature as GjFeature, FeatureCollection, Geometry } from 'geojson';
import type { GeoJSONSource, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import { bearing, centerOf, circlePoly, destinationPt, midpoint, mpp0 } from './geo';
import { ARROW_BASE, ASSET_BASE, ImageRegistry, type ImageSpec } from './images';
import { DEFAULT_STYLE, type Asset, type Feature, type Layer, type Pos } from './types';

export const SCENE_SOURCE = 'scene';

export interface Scene {
  fc: FeatureCollection;
  images: ImageSpec[];
}

const MISSING_ASSET: Asset = { id: 'missing', name: 'missing', path: '', mime: 'image/png', width: 1, height: 1 };

export function buildScene(layers: Pick<Layer, 'id' | 'z'>[], features: Feature[], assets: Map<string, Asset>): Scene {
  const order = new Map<string, number>();
  [...layers].sort((a, b) => a.z - b.z).forEach((l, i) => order.set(l.id, i));

  const out: GjFeature[] = [];
  const images = new Map<string, ImageSpec>();
  const img = (s: ImageSpec) => (images.set(s.id, s), s.id);
  const push = (geometry: Geometry, properties: Record<string, unknown>) => out.push({ type: 'Feature', geometry, properties });
  const label = (fid: string, at: Pos, text: string, sort: number, pad: number, color = '#ffffff') => {
    const id = img({ id: `tx:13:${color}:${pad}:${text}`, t: 'text', text, fontSize: 13, color, pad });
    push({ type: 'Point', coordinates: at }, { fid, label: id, sort });
  };

  for (const f of features) {
    const li = order.get(f.layer_id);
    if (li === undefined) continue; // hidden or filtered-out layer
    const sort = li * 100000 + f.z;
    const st = { ...DEFAULT_STYLE, ...f.style };
    const p = f.props;
    const base = { fid: f.id, sort, color: st.color, width: st.width, dash: st.dash, fillOpacity: st.fillOpacity };
    const g = f.geometry;

    switch (f.kind) {
      case 'polygon':
        push(g, base);
        if (p.name) label(f.id, centerOf(g), p.name, sort, 0);
        break;
      case 'circle': {
        const c = g.coordinates as Pos;
        push(circlePoly(c, p.radius ?? 1000), base);
        if (p.name) label(f.id, destinationPt(c, p.radius ?? 1000, 0), p.name, sort, 4, st.color);
        break;
      }
      case 'line':
      case 'freehand':
      case 'arrow': {
        if (g.type !== 'LineString' || g.coordinates.length < 2) break;
        const cs = g.coordinates as Pos[];
        push(g, { ...base, fillOpacity: 0 });
        if (f.kind === 'arrow') {
          const head = Math.max(14, st.width * 5);
          push(
            { type: 'Point', coordinates: cs[cs.length - 1] },
            {
              fid: f.id, sort,
              ah: img({ id: `ah:${st.color}`, t: 'ah', color: st.color }),
              ahSize: head / (ARROW_BASE * (2 / 3)),
              rot: bearing(cs[cs.length - 2], cs[cs.length - 1]),
            },
          );
        }
        if (p.name) {
          const i = Math.floor((cs.length - 1) / 2);
          label(f.id, midpoint(cs[i], cs[i + 1]), p.name, sort, 6);
        }
        break;
      }
      case 'symbol': {
        const size = p.sizePx ?? 34;
        const o: Record<string, unknown> = {};
        if (p.name) o.uniqueDesignation = p.name;
        if (p.type) o.type = p.type;
        if (p.speed) o.speed = p.speed;
        if (p.heading != null) o.direction = p.heading;
        if (p.tint) o.fillColor = p.tint; // a player's colour, or one set by the owner
        const sidc = p.sidc || 'SUGP-----------';
        push(g, { fid: f.id, sort, mode: 'up', icon: img({ id: `ms:${sidc}:${size}:${JSON.stringify(o)}`, t: 'ms', sidc, size, o }) });
        break;
      }
      case 'text': {
        const fontSize = p.fontSize ?? 18;
        const text = p.name || 'Text';
        push(g, {
          fid: f.id, sort, mode: 'px', size: 1, rot: p.heading ?? 0,
          icon: img({ id: `tx:${fontSize}:${st.color}:0:${text}`, t: 'text', text, fontSize, color: st.color, pad: 0 }),
        });
        break;
      }
      case 'asset': {
        const asset = (f.asset_id && assets.get(f.asset_id)) || MISSING_ASSET;
        const tint = p.tint || null;
        const icon = img({ id: `as:${asset.id}:${tint ?? ''}`, t: 'asset', asset, tint });
        const c = g.coordinates as Pos;
        const rot = p.heading ?? 0;
        if (p.sizeMode === 'm') {
          // On-screen px = metres / (mpp0 / 2^zoom); s0 is the icon-size at zoom 0.
          push(g, { fid: f.id, sort, mode: 'm', icon, rot, s0: (p.sizeM ?? 100) / mpp0(c[1]) / ASSET_BASE });
        } else {
          push(g, { fid: f.id, sort, mode: 'px', icon, rot, size: (p.sizePx ?? 64) / ASSET_BASE });
        }
        if (p.name && p.showLabel !== false) {
          label(f.id, c, p.name, sort, p.sizeMode === 'm' ? 12 : Math.min(160, (p.sizePx ?? 64) / 2 + 4));
        }
        break;
      }
    }
  }
  return { fc: { type: 'FeatureCollection', features: out }, images: [...images.values()] };
}

// icon-size for true-scale assets: exactly s0 * 2^zoom. A stop per integer zoom keeps the packed
// per-tile sizes small (MapLibre stores them as 16-bit values), which a single 0..24 ramp would overflow.
const trueScale: unknown[] = ['interpolate', ['exponential', 2], ['zoom']];
for (let z = 0; z <= 24; z++) trueScale.push(z, ['*', ['get', 's0'], 2 ** z]);

const symbolLayout = { 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'sort'] };
const notPoint = ['!=', ['geometry-type'], 'Point'];

/**
 * The layer stack for one scene source. `opacity` < 1 gives the "ghost" look used for proposed
 * changes: same shapes and icons, drawn translucent on top of the live map.
 */
function sceneLayers(source: string, pre: string, opacity: number): LayerSpecification[] {
  const ghost = opacity < 1;
  const iconPaint = ghost ? { paint: { 'icon-opacity': opacity } } : {};
  const line = (id: string, dash: string, extra: Record<string, unknown>, cap: string) => ({
    id, type: 'line', source,
    filter: ['all', notPoint, ['==', ['get', 'dash'], dash]],
    layout: { 'line-cap': cap, 'line-join': 'round', 'line-sort-key': ['get', 'sort'] },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], ...(ghost ? { 'line-opacity': Math.min(1, opacity + 0.2) } : {}), ...extra },
  });
  const icon = (id: string, mode: string, layout: Record<string, unknown>) => ({
    id, type: 'symbol', source,
    filter: ['==', ['get', 'mode'], mode],
    layout: { ...symbolLayout, 'icon-image': ['get', 'icon'], ...layout },
    ...iconPaint,
  });
  return [
    {
      id: `${pre}-fill`, type: 'fill', source,
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['>', ['get', 'fillOpacity'], 0]],
      layout: { 'fill-sort-key': ['get', 'sort'] },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ghost ? ['*', ['get', 'fillOpacity'], opacity] : ['get', 'fillOpacity'] },
    },
    line(`${pre}-line-solid`, 'solid', {}, 'butt'),
    line(`${pre}-line-dash`, 'dash', { 'line-dasharray': [3, 2] }, 'butt'),
    line(`${pre}-line-dot`, 'dot', { 'line-dasharray': [0.01, 2] }, 'round'),
    {
      id: `${pre}-arrowhead`, type: 'symbol', source, filter: ['has', 'ah'],
      layout: { ...symbolLayout, 'icon-image': ['get', 'ah'], 'icon-size': ['get', 'ahSize'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map' },
      ...iconPaint,
    },
    icon(`${pre}-icon-m`, 'm', { 'icon-size': trueScale, 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map' }),
    icon(`${pre}-icon-px`, 'px', { 'icon-size': ['get', 'size'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map' }),
    icon(`${pre}-icon-up`, 'up', {}),
    {
      id: `${pre}-label`, type: 'symbol', source, filter: ['has', 'label'],
      layout: { ...symbolLayout, 'icon-image': ['get', 'label'], 'icon-anchor': 'top' },
      ...iconPaint,
    },
  ] as unknown as LayerSpecification[];
}

/** Layers that count for clicking and selecting, for the scene with the given layer-id prefix. */
export const hitLayers = (pre = 'sc') =>
  ['fill', 'line-solid', 'line-dash', 'line-dot', 'arrowhead', 'icon-m', 'icon-px', 'icon-up'].map((l) => `${pre}-${l}`);
export const HIT_LAYERS = hitLayers();

export interface SceneOptions {
  /** Source id and layer-id prefix. Default: the live scene ('scene' / 'sc'). */
  source?: string;
  prefix?: string;
  /** < 1 draws everything translucent (proposed changes). */
  opacity?: number;
}

export class SceneRenderer {
  private raf = 0;
  private args: [Pick<Layer, 'id' | 'z'>[], Feature[], Map<string, Asset>] | null = null;
  private images: ImageRegistry;
  private dead = false;

  private source: string;

  constructor(private map: MlMap, urlFor: (a: Asset) => string, opts: SceneOptions = {}) {
    this.source = opts.source ?? SCENE_SOURCE;
    // maxzoom 24 so tiles are never overscaled; true-scale icon sizing relies on the tile zoom.
    map.addSource(this.source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, maxzoom: 24, tolerance: 0.2 });
    for (const l of sceneLayers(this.source, opts.prefix ?? 'sc', opts.opacity ?? 1)) map.addLayer(l);
    this.images = new ImageRegistry(map, urlFor, () => this.schedule());
  }

  /** Pass only the layers that should be drawn. */
  update(layers: Pick<Layer, 'id' | 'z'>[], features: Feature[], assets: Map<string, Asset>) {
    this.args = [layers, features, assets];
    this.schedule();
  }

  private schedule() {
    if (this.raf || this.dead) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  private flush() {
    if (!this.args || this.dead) return;
    const scene = buildScene(...this.args);
    this.images.ensure(scene.images);
    // Hold back icons whose bitmap is still loading; they appear when the registry calls back.
    scene.fc.features = scene.fc.features.filter((f) => !f.properties?.icon || this.images.has(f.properties.icon));
    (this.map.getSource(this.source) as GeoJSONSource | undefined)?.setData(scene.fc);
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
  }
}
