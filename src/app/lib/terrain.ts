// Terrain generation, in the owner's browser. Downloads land use for the campaign area once, then
// turns it into a few coarse zones:
//   1. paint the polygons onto a grid (about 500 m cells) in Web Mercator,
//   2. close small gaps so neighbouring patches merge,
//   3. drop patches below the minimum area (city 25 km², forest 50 km² by default),
//   4. trace the cells back into outlines and simplify them.
// The raw download is kept, so changing a threshold re-runs steps 1-4 without downloading again.
//
// Source: OpenFreeMap vector tiles (OpenMapTiles schema, built from OpenStreetMap; keyless, CORS-enabled).
// Urban = landuse residential / commercial / industrial / retail; forest = landcover wood / forest.
// Data © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap / OpenMapTiles.
import { contours } from 'd3-contour';
import type { MultiPolygon, Polygon } from 'geojson';
import { fromMerc, toMerc } from './geo';
import type { Pos } from './types';

export type TerrainType = 'urban' | 'forest';
type Rings = Pos[][];

export interface RawTerrain {
  urban: Rings[];
  forest: Rings[];
  source: string;
  tiles: number;
}

export interface TerrainOptions {
  /** Minimum patch area to keep, km². */
  minKm2: { urban: number; forest: number };
  /** Grid cell size in metres (coarser = faster, blockier). */
  cellM: number;
  /** Gap to close between neighbouring patches, in cells. */
  closeCells: number;
}

export const DEFAULT_TERRAIN_OPTIONS: TerrainOptions = { minKm2: { urban: 25, forest: 50 }, cellM: 500, closeCells: 2 };
export const TERRAIN_COLORS: Record<'urban' | 'forest' | 'open', string> = { urban: '#c2410c', forest: '#15803d', open: '#a3a3a3' };
export const TERRAIN_SOURCE = 'OpenStreetMap via OpenFreeMap vector tiles';
export const TERRAIN_CREDIT = '© OpenStreetMap contributors (ODbL), OpenFreeMap / OpenMapTiles';

export interface TerrainZone {
  type: TerrainType;
  geometry: MultiPolygon;
}

export interface TerrainResult {
  zones: TerrainZone[];
  stats: { total_km2: number; urban_pct: number; forest_pct: number; open_pct: number; urban_zones: number; forest_zones: number };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const URBAN_CLASSES = new Set(['residential', 'commercial', 'industrial', 'retail']);
const FOREST_CLASSES = new Set(['wood', 'forest']);
export const MAX_TILES = 900;

/** Tiles covering a lng/lat box at a zoom level. */
export function tilesFor(bbox: [number, number, number, number], z: number): [number, number][] {
  const n = 2 ** z;
  const [a, b] = [toMerc([bbox[0], bbox[3]]), toMerc([bbox[2], bbox[1]])];
  const out: [number, number][] = [];
  for (let x = Math.floor(a[0] * n); x <= Math.min(n - 1, Math.floor(b[0] * n)); x++) {
    for (let y = Math.floor(a[1] * n); y <= Math.min(n - 1, Math.floor(b[1] * n)); y++) out.push([x, y]);
  }
  return out;
}

const round5 = (p: number[]): Pos => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

/** Download land use for an area. Throws with a readable message if the tile service cannot be reached. */
export async function downloadTerrain(bbox: [number, number, number, number], zoom: number, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<RawTerrain> {
  const [{ VectorTile }, { default: Pbf }] = await Promise.all([import('@mapbox/vector-tile'), import('pbf')]);
  const tiles = tilesFor(bbox, zoom);
  if (tiles.length > MAX_TILES) throw new Error(`That area needs ${tiles.length} tiles at this detail level (limit ${MAX_TILES}). Pick a smaller area or lower the detail.`);
  let template: string;
  try {
    const tj = await (await fetch(TILEJSON, { signal })).json();
    template = tj.tiles[0];
  } catch {
    throw new Error('Could not reach the OpenFreeMap tile service. Try again later, or upload a terrain GeoJSON file instead.');
  }
  const raw: RawTerrain = { urban: [], forest: [], source: TERRAIN_SOURCE, tiles: tiles.length };
  let done = 0;
  let failedTiles = 0;
  const queue = [...tiles];
  const work = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const [x, y] = t;
      try {
        const res = await fetch(template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y)), { signal });
        if (res.ok && res.status !== 204) {
          const tile = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())));
          const take = (layer: string, classes: Set<string>, into: Rings[]) => {
            const l = tile.layers[layer];
            if (!l) return;
            for (let i = 0; i < l.length; i++) {
              const f = l.feature(i);
              if (f.type !== 3 || !classes.has(String(f.properties.class))) continue;
              const g = f.toGeoJSON(x, y, zoom).geometry as Polygon | MultiPolygon;
              const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
              for (const p of polys) into.push(p.map((r) => r.map(round5)));
            }
          };
          take('landuse', URBAN_CLASSES, raw.urban);
          take('landcover', FOREST_CLASSES, raw.forest);
        } else if (!res.ok && res.status !== 404) failedTiles++;
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        failedTiles++;
      }
      onProgress(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  if (failedTiles > tiles.length / 4) throw new Error(`${failedTiles} of ${tiles.length} tiles could not be downloaded. Try again later.`);
  return raw;
}

/** Terrain from an uploaded GeoJSON file: features with properties.type (or class) urban / forest. */
export function rawFromGeoJson(fc: { features?: { properties?: Record<string, unknown> | null; geometry?: Polygon | MultiPolygon | null }[] }): RawTerrain {
  const raw: RawTerrain = { urban: [], forest: [], source: 'uploaded GeoJSON file', tiles: 0 };
  for (const f of fc.features ?? []) {
    const t = String(f.properties?.type ?? f.properties?.class ?? '').toLowerCase();
    const kind = t === 'urban' || URBAN_CLASSES.has(t) ? 'urban' : t === 'forest' || FOREST_CLASSES.has(t) ? 'forest' : null;
    if (!kind || !f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) raw[kind].push(p.map((r) => r.map(round5)));
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Grid processing
// ---------------------------------------------------------------------------

const C = 40075016.686;

interface Grid {
  x0: number;
  y0: number;
  cell: number;      // in normalised mercator units
  w: number;
  h: number;
}

function gridFor(area: Rings[], cellM: number): Grid {
  const pts = area.flat(2).map((p) => toMerc(p));
  const x0 = Math.min(...pts.map((p) => p[0]));
  const x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const y1 = Math.max(...pts.map((p) => p[1]));
  const lat = fromMerc([0, (y0 + y1) / 2])[1];
  let cell = cellM / (C * Math.cos((lat * Math.PI) / 180));
  const MAX = 3000;
  cell = Math.max(cell, (x1 - x0) / MAX, (y1 - y0) / MAX);
  return { x0, y0, cell, w: Math.max(1, Math.ceil((x1 - x0) / cell)), h: Math.max(1, Math.ceil((y1 - y0) / cell)) };
}

/** Paint polygons into a mask (even-odd within each polygon, so holes stay empty). */
export function paint(mask: Uint8Array, g: Grid, polys: Rings[]) {
  for (const rings of polys) {
    const edges: [number, number, number, number][] = [];
    let ymin = Infinity, ymax = -Infinity;
    for (const r of rings) {
      const px = r.map((p) => { const m = toMerc(p); return [(m[0] - g.x0) / g.cell, (m[1] - g.y0) / g.cell] as const; });
      for (let i = 0; i < px.length - 1; i++) {
        const [ax, ay] = px[i];
        const [bx, by] = px[i + 1];
        if (ay === by) continue;
        edges.push([ax, ay, bx, by]);
        ymin = Math.min(ymin, ay, by);
        ymax = Math.max(ymax, ay, by);
      }
    }
    const r0 = Math.max(0, Math.floor(ymin));
    const r1 = Math.min(g.h - 1, Math.ceil(ymax));
    const xs: number[] = [];
    for (let row = r0; row <= r1; row++) {
      const yc = row + 0.5;
      xs.length = 0;
      for (const [ax, ay, bx, by] of edges) {
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
        const c1 = Math.min(g.w - 1, Math.floor(xs[k + 1] - 0.5));
        for (let c = c0; c <= c1; c++) mask[row * g.w + c] = 1;
      }
    }
  }
}

/** Square max (dilate) or min (erode) filter of radius r, separably. */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return src;
  const pass = (a: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(a.length);
    const [n, m] = horizontal ? [h, w] : [w, h];
    for (let i = 0; i < n; i++) {
      let count = 0;
      const at = (j: number) => (horizontal ? i * w + j : j * w + i);
      for (let j = 0; j < Math.min(r, m); j++) count += a[at(j)];
      for (let j = 0; j < m; j++) {
        if (j + r < m) count += a[at(j + r)];
        if (j - r - 1 >= 0) count -= a[at(j - r - 1)];
        const span = Math.min(m - 1, j + r) - Math.max(0, j - r) + 1;
        out[at(j)] = dilate ? (count > 0 ? 1 : 0) : count === span ? 1 : 0;
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/** Area of one cell in km², by row (mercator cells shrink towards the poles). */
const cellKm2 = (g: Grid, row: number) => {
  const lat = fromMerc([0, g.y0 + (row + 0.5) * g.cell])[1];
  const side = g.cell * C * Math.cos((lat * Math.PI) / 180);
  return (side * side) / 1e6;
};

/** Remove 4-connected patches smaller than minKm2. */
function dropSmall(mask: Uint8Array, g: Grid, minKm2: number) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0, area = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const row = (i / g.w) | 0;
      area += cellKm2(g, row);
      const col = i - row * g.w;
      for (const j of [col > 0 ? i - 1 : -1, col < g.w - 1 ? i + 1 : -1, row > 0 ? i - g.w : -1, row < g.h - 1 ? i + g.w : -1]) {
        if (j >= 0 && mask[j] && !seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (area < minKm2) for (let k = 0; k < tail; k++) mask[queue[k]] = 0;
  }
}

/** Ramer-Douglas-Peucker on a closed ring in grid units: split at the point farthest from the start, simplify both halves. */
function simplify(ring: number[][], tol: number): number[][] {
  if (ring.length <= 5) return ring;
  let k = 1;
  for (let i = 1; i < ring.length - 1; i++) if (Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]) > Math.hypot(ring[k][0] - ring[0][0], ring[k][1] - ring[0][1])) k = i;
  const a = rdp(ring.slice(0, k + 1), tol);
  const b = rdp(ring.slice(k), tol);
  return [...a, ...b.slice(1)];
}

function rdp(ring: number[][], tol: number): number[][] {
  if (ring.length <= 2) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, far = tol;
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - ring[i][1]) - (ax - ring[i][0]) * (by - ay)) / len;
      if (d > far) (far = d), (best = i);
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/** Turn downloaded land use into coarse zones inside the campaign area. */
export function buildTerrain(raw: RawTerrain, area: Polygon | MultiPolygon, opts: TerrainOptions = DEFAULT_TERRAIN_OPTIONS): TerrainResult {
  const areaPolys: Rings[] = area.type === 'Polygon' ? [area.coordinates as Rings] : (area.coordinates as Rings[]);
  const g = gridFor(areaPolys, opts.cellM);
  const inArea = new Uint8Array(g.w * g.h);
  paint(inArea, g, areaPolys);
  const masks: Record<TerrainType, Uint8Array> = { urban: new Uint8Array(g.w * g.h), forest: new Uint8Array(g.w * g.h) };
  for (const t of ['urban', 'forest'] as const) {
    paint(masks[t], g, raw[t]);
    let m = morph(morph(masks[t], g.w, g.h, opts.closeCells, true), g.w, g.h, opts.closeCells, false);   // close gaps
    for (let i = 0; i < m.length; i++) m[i] &= inArea[i];
    dropSmall(m, g, opts.minKm2[t]);
    masks[t] = m;
  }
  for (let i = 0; i < masks.forest.length; i++) if (masks.urban[i]) masks.forest[i] = 0;   // urban wins

  // Coverage from the grid itself.
  let total = 0, urban = 0, forest = 0;
  for (let row = 0; row < g.h; row++) {
    const a = cellKm2(g, row);
    for (let col = 0; col < g.w; col++) {
      const i = row * g.w + col;
      if (!inArea[i]) continue;
      total += a;
      if (masks.urban[i]) urban += a;
      else if (masks.forest[i]) forest += a;
    }
  }

  const zones: TerrainZone[] = [];
  const tol = 0.75;
  for (const t of ['urban', 'forest'] as const) {
    // Pad by one cell so outlines close at the grid edge.
    const W = g.w + 2, H = g.h + 2;
    const values = new Float64Array(W * H);
    for (let row = 0; row < g.h; row++) for (let col = 0; col < g.w; col++) values[(row + 1) * W + col + 1] = masks[t][row * g.w + col];
    const [mp] = contours().size([W, H]).thresholds([0.5])(Array.from(values));
    for (const poly of mp.coordinates) {
      const rings = poly
        .map((r) => simplify(r, tol))
        .filter((r) => r.length >= 4)
        .map((r) => r.map(([x, y]) => fromMerc([g.x0 + (x - 1) * g.cell, g.y0 + (y - 1) * g.cell])).map(round5));
      if (rings.length) zones.push({ type: t, geometry: { type: 'MultiPolygon', coordinates: [rings] } });
    }
  }
  const pct = (x: number) => (total ? Math.round((10000 * x) / total) / 100 : 0);
  return {
    zones,
    stats: {
      total_km2: Math.round(total), urban_pct: pct(urban), forest_pct: pct(forest), open_pct: Math.round((100 - pct(urban) - pct(forest)) * 100) / 100,
      urban_zones: zones.filter((z) => z.type === 'urban').length, forest_zones: zones.filter((z) => z.type === 'forest').length,
    },
  };
}

/** Lng/lat box of a polygon or multipolygon. */
export function bboxOf(g: Polygon | MultiPolygon): [number, number, number, number] {
  const pts = (g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2)) as Pos[];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

export const boxPolygon = ([w, s, e, n]: [number, number, number, number]): Polygon => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
