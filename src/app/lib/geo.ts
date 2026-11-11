import { bearing as turfBearing } from '@turf/bearing';
import { circle } from '@turf/circle';
import { destination } from '@turf/destination';
import { distance } from '@turf/distance';
import type { LineString, Point, Polygon } from 'geojson';
import type { Pos } from './types';

type Geom = Point | LineString | Polygon;

const EARTH_CIRCUMFERENCE = 40075016.686;
const MAX_LAT = 85.0511;

/** Metres per CSS pixel at zoom 0 for a given latitude (MapLibre uses 512 px world tiles). */
export const mpp0 = (lat: number) => (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 512;

/** Web Mercator, normalised to 0..1 with y pointing down (same convention as the screen). */
export const toMerc = ([lng, lat]: Pos): Pos => {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return [lng / 360 + 0.5, 0.5 - Math.log(Math.tan(Math.PI / 4 + (l * Math.PI) / 360)) / (2 * Math.PI)];
};
export const fromMerc = ([x, y]: Pos): Pos => [
  (x - 0.5) * 360,
  (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90,
];

export function mapCoords<G extends Geom>(g: G, fn: (p: Pos) => Pos): G {
  if (g.type === 'Point') return { ...g, coordinates: fn(g.coordinates as Pos) };
  if (g.type === 'LineString') return { ...g, coordinates: g.coordinates.map((p) => fn(p as Pos)) };
  return { ...g, coordinates: (g as Polygon).coordinates.map((r) => r.map((p) => fn(p as Pos))) };
}

export function coordsOf(g: Geom): Pos[] {
  if (g.type === 'Point') return [g.coordinates as Pos];
  if (g.type === 'LineString') return g.coordinates as Pos[];
  return g.coordinates.flat() as Pos[];
}

/** Translate in Mercator space so shapes keep their on-screen form when dragged across latitudes. */
export function translateGeom<G extends Geom>(g: G, dx: number, dy: number): G {
  return mapCoords(g, (p) => {
    const m = toMerc(p);
    return fromMerc([m[0] + dx, Math.max(0.001, Math.min(0.999, m[1] + dy))]);
  });
}

/** Rotate clockwise (as seen on a north-up map) around a pivot. */
export function rotateGeom<G extends Geom>(g: G, pivot: Pos, deg: number): G {
  const c = toMerc(pivot);
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return mapCoords(g, (p) => {
    const m = toMerc(p);
    const dx = m[0] - c[0];
    const dy = m[1] - c[1];
    return fromMerc([c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos]);
  });
}

/** Centre of the bounding box, computed in Mercator space. */
export function centerOf(g: Geom): Pos {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of coordsOf(g)) {
    const m = toMerc(p);
    if (m[0] < x0) x0 = m[0];
    if (m[0] > x1) x1 = m[0];
    if (m[1] < y0) y0 = m[1];
    if (m[1] > y1) y1 = m[1];
  }
  return fromMerc([(x0 + x1) / 2, (y0 + y1) / 2]);
}

export const midpoint = (a: Pos, b: Pos): Pos => {
  const ma = toMerc(a);
  const mb = toMerc(b);
  return fromMerc([(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2]);
};

/** Initial bearing a -> b, 0..360 clockwise from true north. */
export const bearing = (a: Pos, b: Pos) => (turfBearing(a, b) + 360) % 360;
export const distanceM = (a: Pos, b: Pos) => distance(a, b, { units: 'kilometers' }) * 1000;
export const destinationPt = (from: Pos, metres: number, brg: number): Pos =>
  destination(from, metres / 1000, brg, { units: 'kilometers' }).geometry.coordinates as Pos;

export function circlePoly(center: Pos, radiusM: number): Polygon {
  return circle(center, Math.max(radiusM, 1) / 1000, { steps: 96, units: 'kilometers' }).geometry;
}

export const norm360 = (d: number) => ((d % 360) + 360) % 360;

export function fmtDist(m: number): string {
  if (m >= 100_000) return `${(m / 1000).toFixed(0)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

export function fmtLatLon([lng, lat]: Pos): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${ns}  ${Math.abs(lng).toFixed(5)}°${ew}`;
}
