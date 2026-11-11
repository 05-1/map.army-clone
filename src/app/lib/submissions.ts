// Pure logic for player turns: building a draft, describing changes, and turning a set of proposed
// changes into "ghost" features for the overlay. Shared by the player page and the owner's review panel.
// Nothing here is a security boundary; the database re-validates every change on submit and on approval.
import type { Polygon } from 'geojson';
import { bearing, circlePoly, coordsOf, destinationPt, distanceM, norm360 } from './geo';
import { DEFAULT_STYLE, type Change, type Draft, type Feature, type Kind, type Pos, type TechItem, type UpdatePayload, type Zone } from './types';

export const GHOST_LAYER = 'ghost';
export const GHOST_LAYERS = [{ id: GHOST_LAYER, z: 0 }];
export const MAX_CHANGES = 200;
export const MAX_ORDER_LEN = 2000;

const KIND_NAME: Record<Kind, string> = {
  symbol: 'unit', asset: 'graphic', text: 'text', line: 'line', arrow: 'arrow', polygon: 'area', circle: 'range ring', freehand: 'sketch',
};

/** Overlay features derived from one change carry `<feature id>~<suffix>` ids. */
export const baseId = (ghostId: string) => ghostId.split('~')[0];

export function featureFromCreate(c: Extract<Change, { op: 'create' }>, z = 0): Feature {
  const p = c.payload;
  return {
    id: c.feature_id, layer_id: GHOST_LAYER, kind: p.kind, geometry: p.geometry, props: p.props ?? {},
    style: { ...DEFAULT_STYLE, ...p.style }, asset_id: p.kind === 'asset' ? p.asset_id ?? null : null, z,
  };
}

export function applyUpdate(f: Feature, u: UpdatePayload): Feature {
  return {
    ...f,
    geometry: u.geometry ?? f.geometry,
    props: u.heading != null ? { ...f.props, heading: u.heading } : f.props,
  };
}

/** The object a change is about, as it would look once approved. Null for deletes and unknown targets. */
export function proposed(c: Change, live: Map<string, Feature>): Feature | null {
  if (c.op === 'create') return featureFromCreate(c);
  if (c.op === 'research') return null;
  const f = live.get(c.feature_id);
  if (!f || c.op === 'delete') return null;
  return applyUpdate(f, c.payload);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * Reference point of an object: the point itself, or the centre of a shape's bounding box.
 * Movement range and placement zones are measured from here. Must match private.anchor() in setup.sql.
 */
export function anchorOf(g: Feature['geometry']): Pos {
  if (g.type === 'Point') return g.coordinates as Pos;
  const pts = coordsOf(g);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}
const anchor = anchorOf;
const moved = (a: Pos, b: Pos) => Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9;

/**
 * Features to draw for a set of proposed changes: new objects, moved units at their new position with a
 * dashed track from the old one, order text under the unit, and a cross on anything marked for removal.
 */
export function ghostFeatures(changes: Change[], live: Feature[], color = '#f2a93b'): Feature[] {
  const byId = new Map(live.map((f) => [f.id, f]));
  const out: Feature[] = [];
  const extra = (id: string, kind: Kind, geometry: Feature['geometry'], props: Feature['props'], style: Partial<Feature['style']>, z: number) =>
    out.push({ id, layer_id: GHOST_LAYER, kind, geometry, props, style: { ...DEFAULT_STYLE, color, ...style }, asset_id: null, z });

  changes.forEach((c, i) => {
    const z = i * 4;
    if (c.op === 'research') return;
    if (c.op === 'create') {
      out.push(featureFromCreate(c, z + 1));
      return;
    }
    const f = byId.get(c.feature_id);
    if (!f) return; // not visible to this viewer, or already gone
    const from = anchor(f.geometry);
    if (c.op === 'delete') {
      out.push({ ...f, layer_id: GHOST_LAYER, z: z + 1 });
      extra(`${f.id}~x`, 'text', { type: 'Point', coordinates: from }, { name: '✕', fontSize: 30 }, { color: '#ff453a' }, z + 2);
      return;
    }
    const g = applyUpdate(f, c.payload);
    const to = anchor(g.geometry);
    if (c.payload.geometry && moved(from, to)) {
      extra(`${f.id}~path`, 'line', { type: 'LineString', coordinates: [from, to] }, {}, { width: 2, dash: 'dash' }, z);
    }
    out.push({ ...g, layer_id: GHOST_LAYER, z: z + 1 });
    if (c.payload.order) {
      // Leading blank lines push the text below the unit; text icons are centred on their point.
      extra(`${f.id}~order`, 'text', { type: 'Point', coordinates: to }, { name: `\n\n\n» ${clip(c.payload.order.replace(/\s+/g, ' '), 48)}`, fontSize: 12 }, {}, z + 2);
    }
  });
  return out;
}

const nameOf = (f: Feature | undefined) => clip(f?.props.name?.split('\n')[0] || (f ? KIND_NAME[f.kind] : 'unknown object'), 40);

/** One line per change, for lists. Pass the tech tree to name research and purchases. */
export function describeChange(c: Change, live: Map<string, Feature>, tech: readonly TechItem[] = []): string {
  if (c.op === 'research') {
    const it = tech.find((x) => x.id === c.feature_id);
    return `Research ${it ? clip(it.name, 40) : 'unknown item'}${it?.research_cost ? ` (${it.research_cost} research)` : ''}`;
  }
  if (c.op === 'create') {
    const n = c.payload.props?.name?.split('\n')[0];
    const it = c.payload.purchase_id ? tech.find((x) => x.id === c.payload.purchase_id) : undefined;
    if (c.payload.purchase_id) return `Buy ${clip(it?.name ?? 'unit', 30)}${n && n !== it?.name ? `: ${clip(n, 30)}` : ''}${it?.spawn_cost ? ` (${it.spawn_cost} spawn)` : ''}`;
    return `New ${KIND_NAME[c.payload.kind]}${n ? `: ${clip(n, 40)}` : ''}`;
  }
  const f = live.get(c.feature_id);
  if (c.op === 'delete') return `Remove ${nameOf(f)}`;
  const parts: string[] = [];
  if (c.payload.geometry) parts.push('Move');
  if (c.payload.heading != null) parts.push(`${parts.length ? 'turn' : 'Turn'} to ${Math.round(c.payload.heading)}°`);
  if (c.payload.order) parts.push(parts.length ? 'order' : 'Order');
  return `${parts.join(', ') || 'Change'}: ${nameOf(f)}`;
}

/** "2 moves, 1 order, 1 new arrow" */
export function summarize(changes: Change[]): string {
  const n = new Map<string, number>();
  const add = (k: string) => n.set(k, (n.get(k) ?? 0) + 1);
  for (const c of changes) {
    if (c.op === 'research') add('research');
    else if (c.op === 'create') add(c.payload.purchase_id ? 'purchase' : `new ${KIND_NAME[c.payload.kind]}`);
    else if (c.op === 'delete') add('removal');
    else {
      if (c.payload.geometry) add('move');
      else if (c.payload.heading != null) add('turn');
      if (c.payload.order) add('order');
    }
  }
  if (!n.size) return 'No changes';
  return [...n].map(([k, v]) => `${v} ${k}${v > 1 && k !== 'research' ? 's' : ''}`).join(', ');
}

/**
 * Add a change to a draft turn. A turn holds at most one change per object, so this merges:
 * editing an object created in the same draft rewrites the create, and removing it drops the create.
 */
export function putChange(draft: Change[], c: Change): Change[] {
  const i = draft.findIndex((x) => x.feature_id === c.feature_id);
  if (i < 0) return [...draft, c];
  const cur = draft[i];
  let next: Change | null = c;
  if (cur.op === 'create') {
    if (c.op === 'delete') next = null;
    else if (c.op === 'update') {
      next = {
        ...cur,
        payload: {
          ...cur.payload,
          geometry: c.payload.geometry ?? cur.payload.geometry,
          props: c.payload.heading != null ? { ...cur.payload.props, heading: c.payload.heading } : cur.payload.props,
        },
      };
    }
  } else if (cur.op === 'update' && c.op === 'update') {
    next = { ...cur, payload: { ...cur.payload, ...c.payload } };
  }
  return next ? draft.map((x, k) => (k === i ? next! : x)) : draft.filter((_, k) => k !== i);
}

/** Remove one part of an update (e.g. just the order). The change disappears when nothing is left. */
export function dropPart(draft: Change[], featureId: string, key: keyof UpdatePayload): Change[] {
  return draft.flatMap((c): Change[] => {
    if (c.feature_id !== featureId || c.op !== 'update') return [c];
    const { [key]: _gone, ...rest } = c.payload;
    return Object.keys(rest).length ? [{ ...c, payload: rest }] : [];
  });
}

export const removeChange = (draft: Change[], featureId: string) => draft.filter((c) => c.feature_id !== featureId);

export const sameChanges = (a: Change[], b: Change[]) => JSON.stringify(a) === JSON.stringify(b);

export const cleanHeading = (deg: number) => Math.round(norm360(deg) * 10) / 10;

/** Pull a target back onto the edge of the allowed circle. UX only: the server enforces the same limit. */
export function clampToRadius(origin: Pos, target: Pos, radiusM: number | null | undefined): Pos {
  if (radiusM == null) return target;
  if (radiusM <= 0) return origin;
  return distanceM(origin, target) <= radiusM ? target : destinationPt(origin, radiusM * 0.999, bearing(origin, target));
}

export function inZone(zone: Zone, p: Pos): boolean {
  if (!zone) return true;
  if ('center' in zone) return distanceM(zone.center, p) <= zone.radius_m;
  const ring = zone.coordinates[0] as Pos[];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const zonePolygon = (zone: Exclude<Zone, null>): Polygon => ('center' in zone ? circlePoly(zone.center, zone.radius_m) : zone);

/** A zone from a shape drawn in the editor: a polygon as is, a circle as centre + radius. */
export function zoneFromFeature(f: Feature): Zone {
  if (f.kind === 'polygon' && f.geometry.type === 'Polygon') return f.geometry;
  if (f.kind === 'circle' && f.geometry.type === 'Point' && f.props.radius) return { center: f.geometry.coordinates as Pos, radius_m: f.props.radius };
  return null;
}

/** What the push will apply from a draft: the owner's edited version if there is one, minus rejected changes. */
export function effectiveChanges(d: Pick<Draft, 'changes' | 'owner_changes' | 'rejected'>): Change[] {
  const gone = new Set(d.rejected);
  return (d.owner_changes ?? d.changes).filter((c) => !gone.has(c.feature_id));
}

export interface Conflict {
  a: string;
  b: string;
  at: Pos;
  distance: number;
}

/**
 * Units that would end the turn closer than `limitM` to a unit of another player (or an unassigned
 * one). Only pairs where at least one side moved or was placed this turn are reported.
 */
export function findConflicts(live: Feature[], drafts: { player_id: string; changes: Change[] }[], limitM: number | null | undefined): Conflict[] {
  if (!limitM) return [];
  const isUnit = (f: Feature) => (f.kind === 'symbol' || f.kind === 'asset') && f.geometry.type === 'Point';
  const end = new Map<string, { pos: Pos; owner: string | null; touched: boolean }>();
  for (const f of live) if (isUnit(f)) end.set(f.id, { pos: f.geometry.coordinates as Pos, owner: f.owner_player_id ?? null, touched: false });
  const byId = new Map(live.map((f) => [f.id, f]));
  for (const d of drafts) {
    for (const c of d.changes) {
      if (c.op === 'delete') end.delete(c.feature_id);
      else if (c.op === 'create') {
        const f = featureFromCreate(c);
        if (isUnit(f)) end.set(f.id, { pos: f.geometry.coordinates as Pos, owner: d.player_id, touched: true });
      } else if (c.op === 'update' && c.payload.geometry && end.has(c.feature_id)) {
        const f = byId.get(c.feature_id)!;
        end.set(c.feature_id, { pos: anchorOf(c.payload.geometry), owner: f.owner_player_id ?? null, touched: true });
      }
    }
  }
  const units = [...end];
  const out: Conflict[] = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const [ia, a] = units[i];
      const [ib, b] = units[j];
      if (!(a.touched || b.touched) || (a.owner !== null && a.owner === b.owner)) continue;
      const distance = distanceM(a.pos, b.pos);
      if (distance < limitM) out.push({ a: ia, b: ib, at: [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2], distance });
    }
  }
  return out;
}

export const fmtWhen = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - +new Date(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
