// Turn-building and ghost-overlay logic shared by the player page and the review panel,
// plus the script that keeps server-side keys out of the published bundle.
import { describe, expect, it } from 'vitest';
import { findSecrets } from '../scripts/check-bundle.mjs';
import { distanceM } from '../app/lib/geo';
import { buildScene } from '../app/lib/scene';
import {
  anchorOf, baseId, clampToRadius, describeChange, dropPart, effectiveChanges, findConflicts, ghostFeatures, GHOST_LAYERS, inZone, proposed, putChange, sameChanges, summarize, zoneFromFeature,
} from '../app/lib/submissions';
import type { Change, Feature } from '../app/lib/types';

const pt = (lng: number, lat: number) => ({ type: 'Point' as const, coordinates: [lng, lat] });
const unit = (id: string, name: string, lng = 1, lat = 2): Feature => ({
  id, layer_id: 'l', kind: 'symbol', geometry: pt(lng, lat), props: { name, sidc: 'SFGPUCI----F---', notes: 'old' },
  style: { color: '#fff', width: 1, dash: 'solid', fillOpacity: 0 }, asset_id: null, z: 0, owner_player_id: 'p1',
});
const live = [unit('u1', '1-64 AR'), unit('u2', '2-7 IN', 5, 5)];
const byId = new Map(live.map((f) => [f.id, f]));
const move = (id: string, lng: number, lat: number): Change => ({ op: 'update', feature_id: id, payload: { geometry: pt(lng, lat) } });
const arrow: Change = { op: 'create', feature_id: 'a1', payload: { kind: 'arrow', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, style: { color: '#f00' } } };

describe('draft turns', () => {
  it('keeps one change per object and merges edits to the same unit', () => {
    let d = putChange([], move('u1', 3, 3));
    d = putChange(d, { op: 'update', feature_id: 'u1', payload: { heading: 90 } });
    d = putChange(d, { op: 'update', feature_id: 'u1', payload: { order: 'Hold' } });
    d = putChange(d, move('u1', 4, 4));
    expect(d).toEqual([{ op: 'update', feature_id: 'u1', payload: { geometry: pt(4, 4), heading: 90, order: 'Hold' } }]);
  });

  it('edits to an object created in the same draft rewrite the create; removing it drops it', () => {
    let d = putChange([], arrow);
    d = putChange(d, { op: 'update', feature_id: 'a1', payload: { geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] }, order: 'ignored' } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ op: 'create', payload: { kind: 'arrow', geometry: { coordinates: [[2, 2], [3, 3]] }, style: { color: '#f00' } } });
    expect(JSON.stringify(d)).not.toContain('ignored');
    expect(putChange(d, { op: 'delete', feature_id: 'a1' })).toEqual([]);
  });

  it('a removal replaces earlier edits to that unit, and an edit replaces the removal', () => {
    const d = putChange(putChange([], move('u1', 3, 3)), { op: 'delete', feature_id: 'u1' });
    expect(d).toEqual([{ op: 'delete', feature_id: 'u1' }]);
    expect(putChange(d, move('u1', 9, 9))).toEqual([move('u1', 9, 9)]);
  });

  it('drops one part of an update, and the change itself when nothing is left', () => {
    const d: Change[] = [{ op: 'update', feature_id: 'u1', payload: { heading: 10, order: 'x' } }];
    expect(dropPart(d, 'u1', 'order')).toEqual([{ op: 'update', feature_id: 'u1', payload: { heading: 10 } }]);
    expect(dropPart(dropPart(d, 'u1', 'order'), 'u1', 'heading')).toEqual([]);
  });
});

describe('describing a turn', () => {
  it('summarises and labels changes', () => {
    const d: Change[] = [
      move('u1', 3, 3), { op: 'update', feature_id: 'u2', payload: { heading: 270, order: 'Go' } }, arrow,
      { op: 'create', feature_id: 't', payload: { kind: 'text', geometry: pt(0, 0), props: { name: 'OBJ 1\nsecond line' } } },
    ];
    expect(summarize(d)).toBe('1 move, 1 turn, 1 order, 1 new arrow, 1 new text');
    expect(summarize([move('u1', 1, 1), move('u2', 1, 1)])).toBe('2 moves');
    expect(summarize([])).toBe('No changes');
    expect(d.map((c) => describeChange(c, byId))).toEqual(['Move: 1-64 AR', 'Turn to 270°, order: 2-7 IN', 'New arrow', 'New text: OBJ 1']);
    expect(describeChange({ op: 'delete', feature_id: 'u1' }, byId)).toBe('Remove 1-64 AR');
    expect(describeChange(move('gone', 1, 1), byId)).toBe('Move: unknown object');
    expect(sameChanges(d, structuredClone(d))).toBe(true);
    expect(sameChanges(d, d.slice(1))).toBe(false);
  });
});

describe('ghost overlay', () => {
  it('shows a moved unit at its new position with a dashed track from the old one', () => {
    const g = ghostFeatures([{ op: 'update', feature_id: 'u1', payload: { geometry: pt(3, 4), heading: 90, order: 'Seize the bridge' } }], live, '#0a84ff');
    expect(g.map((f) => f.id)).toEqual(['u1~path', 'u1', 'u1~order']);
    expect(g[0]).toMatchObject({ kind: 'line', geometry: { coordinates: [[1, 2], [3, 4]] }, style: { dash: 'dash', color: '#0a84ff' } });
    expect(g[1]).toMatchObject({ kind: 'symbol', geometry: pt(3, 4), props: { heading: 90, name: '1-64 AR' } });
    expect(g[2].props.name).toContain('Seize the bridge');
    expect(g.every((f) => baseId(f.id) === 'u1')).toBe(true);
    expect(live[0].geometry).toEqual(pt(1, 2)); // the live feature is never mutated
  });

  it('draws no track for a turn-in-place and skips units the viewer cannot see', () => {
    expect(ghostFeatures([{ op: 'update', feature_id: 'u1', payload: { heading: 45 } }], live).map((f) => f.id)).toEqual(['u1']);
    expect(ghostFeatures([move('hidden', 1, 1), { op: 'delete', feature_id: 'hidden' }], live)).toEqual([]);
  });

  it('marks removals and includes new objects', () => {
    const g = ghostFeatures([{ op: 'delete', feature_id: 'u2' }, arrow], live);
    expect(g.map((f) => f.id)).toEqual(['u2', 'u2~x', 'a1']);
    expect(g[2]).toMatchObject({ kind: 'arrow', style: { color: '#f00', width: 3 } });
    expect(proposed({ op: 'delete', feature_id: 'u2' }, byId)).toBeNull();
    expect(proposed(move('u2', 8, 8), byId)?.geometry).toEqual(pt(8, 8));
  });

  it('feeds the normal scene builder, so ghosts render exactly like the real thing', () => {
    const scene = buildScene(GHOST_LAYERS, ghostFeatures([move('u1', 3, 4), arrow], live), new Map());
    const fids = scene.fc.features.map((f) => f.properties?.fid);
    expect(fids).toEqual(expect.arrayContaining(['u1~path', 'u1', 'a1']));
    expect(scene.fc.features.length).toBeGreaterThanOrEqual(4); // track, unit, arrow line, arrowhead
  });
});

describe('turn rules on the client (the server enforces the same ones)', () => {
  it('anchors shapes at the centre of their bounding box, like private.anchor() in setup.sql', () => {
    expect(anchorOf(pt(3, 4))).toEqual([3, 4]);
    expect(anchorOf({ type: 'LineString', coordinates: [[0, 0], [4, 2], [1, 6]] })).toEqual([2, 3]);
    expect(anchorOf({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 4], [0, 4], [0, 0]]] })).toEqual([5, 2]);
  });

  it('clamps a drag to the movement radius around the start position', () => {
    const start: [number, number] = [10, 50];
    expect(clampToRadius(start, [10.1, 50], 20000)).toEqual([10.1, 50]);          // inside: untouched
    const c = clampToRadius(start, [12, 50], 20000);
    expect(distanceM(start, c)).toBeGreaterThan(19900);
    expect(distanceM(start, c)).toBeLessThanOrEqual(20000);
    expect(c[0]).toBeGreaterThan(10);                                              // same direction
    expect(clampToRadius(start, [12, 50], null)).toEqual([12, 50]);               // unlimited
    expect(clampToRadius(start, [12, 50], 0)).toEqual(start);                     // pinned
  });

  it('checks placement zones: circle, polygon, none', () => {
    const square = { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
    expect(inZone(null, [50, 50])).toBe(true);
    expect(inZone(square, [1, 1])).toBe(true);
    expect(inZone(square, [3, 1])).toBe(false);
    expect(inZone({ center: [10, 50], radius_m: 5000 }, [10.05, 50])).toBe(true);
    expect(inZone({ center: [10, 50], radius_m: 5000 }, [10.2, 50])).toBe(false);
    expect(zoneFromFeature({ ...unit('c', 'c'), kind: 'circle', props: { radius: 800 } })).toEqual({ center: [1, 2], radius_m: 800 });
    expect(zoneFromFeature({ ...unit('p', 'p'), kind: 'polygon', geometry: square })).toEqual(square);
    expect(zoneFromFeature(unit('s', 's'))).toBeNull();
  });

  it('a draft applies the owner edit if there is one, minus rejected changes', () => {
    const changes = [move('u1', 3, 3), arrow];
    expect(effectiveChanges({ changes, owner_changes: null, rejected: [] })).toEqual(changes);
    expect(effectiveChanges({ changes, owner_changes: null, rejected: ['a1'] })).toEqual([changes[0]]);
    expect(effectiveChanges({ changes, owner_changes: [move('u1', 9, 9)], rejected: ['u1'] })).toEqual([]);
  });

  it('finds units of different players that end the turn too close together', () => {
    const red = { ...unit('r1', 'Red 1', 1.001, 2), owner_player_id: 'p2' };
    const far = { ...unit('r2', 'Red 2', 9, 9), owner_player_id: 'p2' };
    const mate = { ...unit('u9', 'Blue 9', 1.0005, 2), owner_player_id: 'p1' };
    const all = [...live, red, far, mate];
    // Nothing moved this turn: standing next to each other is not news.
    expect(findConflicts(all, [], 500)).toEqual([]);
    // p2 moves the far unit next to p1's u2: one conflict. Same-player neighbours never count.
    const c = findConflicts(all, [{ player_id: 'p2', changes: [move('r2', 5.001, 5)] }], 500);
    expect(c.map((x) => [x.a, x.b])).toEqual([['u2', 'r2']]);
    expect(c[0].distance).toBeLessThan(500);
    // A newly placed unit counts, a removed one does not, and no limit means no check.
    const placed: Change = { op: 'create', feature_id: 'n1', payload: { kind: 'symbol', geometry: pt(1.002, 2), allocation_id: 'x' } };
    expect(findConflicts(all, [{ player_id: 'p1', changes: [placed, { op: 'delete', feature_id: 'u1' }] }], 500).map((x) => [x.a, x.b])).toEqual([['r1', 'n1']]);
    expect(findConflicts(all, [{ player_id: 'p1', changes: [placed] }], null)).toEqual([]);
  });
});

describe('bundle secret check', () => {
  const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
  it('lets the anon key through and stops everything else', () => {
    expect(findSecrets(`const k="${jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'anon' })}"`)).toEqual([]);
    expect(findSecrets('createClient(url, "sb_publishable_abcdefghijklmnop")')).toEqual([]);
    expect(findSecrets(`x=${jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'service_role' })}`)[0]).toMatch(/service_role/);
    expect(findSecrets('k = "sb_secret_abcdefghijklmnop"')[0]).toMatch(/secret key/);
    expect(findSecrets('process.env.SUPABASE_SERVICE_ROLE_KEY')[0]).toMatch(/service-role/);
    expect(findSecrets(`${jwt({ sub: 'someone-else', aud: 'authenticated' })}`)[0]).toMatch(/unknown/);
  });
});
