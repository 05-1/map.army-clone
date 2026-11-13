import ms from 'milsymbol';
import { describe, expect, it } from 'vitest';
import { computeDiff, isEmptyDiff } from '../app/lib/diff';
import { bearing, centerOf, fromMerc, mpp0, rotateGeom, toMerc, translateGeom } from '../app/lib/geo';
import { buildSidc, CATALOG, DEFAULT_DRAFT, ECHELONS, isLetterSidc, setSidcChar } from '../app/lib/symbols';
import { sniffMime } from '../app/lib/upload';
import type { Feature, Layer, Pos } from '../app/lib/types';

describe('geo', () => {
  it('round-trips Web Mercator', () => {
    for (const p of [[0, 0], [-85.3, 38.4], [179.9, -70], [12.5, 84]] as Pos[]) {
      const q = fromMerc(toMerc(p));
      expect(q[0]).toBeCloseTo(p[0], 9);
      expect(q[1]).toBeCloseTo(p[1], 9);
    }
  });
  it('knows the ground resolution MapLibre uses', () => {
    expect(mpp0(0)).toBeCloseTo(78271.517, 2);
    expect(mpp0(60)).toBeCloseTo(78271.517 / 2, 2);
  });
  it('rotates clockwise: a point due north of the pivot ends up due east after 90 degrees', () => {
    const g = rotateGeom({ type: 'Point', coordinates: [10, 1] }, [10, 0], 90);
    expect(bearing([10, 0], g.coordinates as Pos)).toBeCloseTo(90, 1);
  });
  it('translates and undoes exactly', () => {
    const line = { type: 'LineString' as const, coordinates: [[1, 2], [3, 50]] };
    const back = translateGeom(translateGeom(line, 0.01, -0.02), -0.01, 0.02);
    back.coordinates.flat().forEach((v, i) => expect(v).toBeCloseTo(line.coordinates.flat()[i], 9));
  });
  it('finds the centre of a box', () => {
    const c = centerOf({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 0.5], [0, 0.5], [0, 0]]] });
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[1]).toBeCloseTo(0.25, 3);
  });
});

describe('autosave diff', () => {
  const L = (id: string): Layer => ({ id, name: id, visible: true, locked: false, z: 0 });
  const F = (id: string): Feature => ({ id, layer_id: 'l', kind: 'text', geometry: { type: 'Point', coordinates: [0, 0] }, props: {}, style: { color: '#fff', width: 1, dash: 'solid', fillOpacity: 0 }, asset_id: null, z: 0 });
  it('sends only what changed', () => {
    const a = F('a'), b = F('b'), c = F('c'), l = L('l');
    const savedL = new Map([[l.id, l]]);
    const savedF = new Map([[a.id, a], [b.id, b], [c.id, c]]);
    expect(isEmptyDiff(computeDiff(savedL, savedF, [l], [a, b, c]))).toBe(true);
    const b2 = { ...b, z: 5 }, d = F('d');
    const diff = computeDiff(savedL, savedF, [l], [a, b2, d]);
    expect(diff.featureUpserts).toEqual([b2, d]);
    expect(diff.featureDeletes).toEqual(['c']);
    expect(diff.layerUpserts).toEqual([]);
  });
});

describe('symbols', () => {
  it('every catalogue entry is a symbol milsymbol recognises, for every affiliation', () => {
    for (const g of CATALOG) for (const it of g.items) for (const aff of ['F', 'H', 'N', 'U']) {
      const sidc = buildSidc({ ...DEFAULT_DRAFT, aff, dim: it.dim, fn: it.fn });
      expect(sidc).toHaveLength(15);
      expect(new ms.Symbol(sidc).isValid(), `${it.name} ${sidc}`).toBe(true);
    }
  });
  it('edits SIDC fields by position', () => {
    const s = buildSidc({ ...DEFAULT_DRAFT, ech: 'F' });
    expect(s).toBe('SFGPUCI----F---');
    expect(setSidcChar(s, 1, 'H')).toBe('SHGPUCI----F---');
    expect(isLetterSidc(s)).toBe(true);
    expect(isLetterSidc('10031000001211000000')).toBe(false);
    expect(ECHELONS.map((e) => e[0]).join('')).toBe('-ABCDEFGHIJKLM');
  });
});

describe('upload sniffing', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('accepts real PNG, WebP and SVG headers', () => {
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffMime(enc('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(enc('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
  });
  it('rejects everything else regardless of file name', () => {
    expect(sniffMime(enc('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffMime(enc('GIF89a'))).toBeNull();
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(sniffMime(enc('MZ\x90\0'))).toBeNull();
  });
});

describe('basemaps', () => {
  it('asBasemap maps removed or unknown basemaps to satellite', async () => {
    const { asBasemap } = await import('../app/lib/basemaps');
    expect(asBasemap('topo')).toBe('topo');
    expect(asBasemap('dark')).toBe('satellite');
    expect(asBasemap(undefined)).toBe('satellite');
  });
});

describe('tech tree helpers', () => {
  it('zones: countries with several parts and holes', async () => {
    const { inZone } = await import('../app/lib/submissions');
    const sq = (x: number, y: number, d: number): [number, number][] => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
    const z = { type: 'MultiPolygon' as const, coordinates: [[sq(0, 0, 2), sq(0.8, 0.8, 0.4)], [sq(10, 0, 1)]] };
    expect(inZone(z, [0.5, 0.5])).toBe(true);
    expect(inZone(z, [1, 1])).toBe(false);      // lake
    expect(inZone(z, [10.5, 0.5])).toBe(true);  // second island
    expect(inZone(z, [5, 0.5])).toBe(false);
  });

  it('same-turn research: cancelling it drops its purchases; rejecting it in review rejects them too', async () => {
    const { toggleRejected, withoutResearch, usable } = await import('../app/lib/tech');
    const it = { id: 'heli', research_cost: 5 } as never;
    const draft = [
      { op: 'research' as const, feature_id: 'heli' },
      { op: 'create' as const, feature_id: 'u1', payload: { kind: 'symbol' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] }, purchase_id: 'heli' } },
      { op: 'create' as const, feature_id: 'u2', payload: { kind: 'symbol' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] }, purchase_id: 'other' } },
    ];
    expect(usable(it, [], draft)).toBe(true);
    expect(usable(it, [], [])).toBe(false);
    expect(withoutResearch(draft, 'heli', [], [it]).map((c) => c.feature_id)).toEqual(['u2']);
    expect(withoutResearch(draft, 'heli', ['heli'], [it]).map((c) => c.feature_id)).toEqual(['u1', 'u2']);
    expect(toggleRejected(draft, [], 'heli').sort()).toEqual(['heli', 'u1']);
    expect(toggleRejected(draft, ['heli', 'u1'], 'u1')).toEqual([]);
  });

  it('research chains: cancelling or rejecting a link drops everything after it; accepting pulls the chain back', async () => {
    const { toggleRejected, withoutResearch, techStatus } = await import('../app/lib/tech');
    const mk = (id: string, prereqs: string[] = []) => ({ id, name: id, research_cost: 1, prereqs }) as never;
    const items = [mk('a'), mk('b', ['a']), mk('c', ['b'])];
    const buyC = { op: 'create' as const, feature_id: 'u', payload: { kind: 'symbol' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] }, purchase_id: 'c' } };
    const draft = [{ op: 'research' as const, feature_id: 'a' }, { op: 'research' as const, feature_id: 'b' }, { op: 'research' as const, feature_id: 'c' }, buyC];
    expect(techStatus(items[2], items, [], draft.slice(0, 2))).toBe('available');
    expect(techStatus(items[2], items, [], [])).toBe('locked');
    expect(withoutResearch(draft, 'a', [], items)).toEqual([]);
    expect(withoutResearch(draft, 'b', [], items).map((c) => c.feature_id)).toEqual(['a']);
    expect(toggleRejected(draft, [], 'a', items).sort()).toEqual(['a', 'b', 'c', 'u']);
    expect(toggleRejected(draft, ['a', 'b', 'c', 'u'], 'u', items).sort()).toEqual([]);
  });

  it('flowchart layout: saved positions win, the rest by tier', async () => {
    const { layout } = await import('../app/lib/TechTree');
    const mk = (id: string, tier: number, pos: [number, number] | null) => ({ id, name: id, tier, sort: 0, pos_x: pos?.[0] ?? null, pos_y: pos?.[1] ?? null }) as never;
    const at = layout([mk('a', 0, null), mk('b', 0, null), mk('c', 2, [500, -40])]);
    expect(at.get('a')).toEqual({ x: 0, y: 0 });
    expect(at.get('b')).toEqual({ x: 0, y: 190 });
    expect(at.get('c')).toEqual({ x: 500, y: -40 });
  });
});

describe('measuring and export', () => {
  it('distance along a path and area on the sphere', async () => {
    const { pathLength, ringArea, fmtArea } = await import('../app/lib/measure');
    // One degree of latitude is about 111.2 km.
    expect(pathLength([[0, 0], [0, 1], [0, 2]]) / 1000).toBeCloseTo(222.4, 0);
    // A 1° x 1° square at the equator is about 12 364 km².
    expect(ringArea([[0, 0], [1, 0], [1, 1], [0, 1]]) / 1e6).toBeGreaterThan(12200);
    expect(ringArea([[0, 0], [1, 0], [1, 1], [0, 1]]) / 1e6).toBeLessThan(12500);
    expect(ringArea([[0, 0], [1, 0]])).toBe(0);
    expect(fmtArea(5000)).toBe('5000 m²');
    expect(fmtArea(50_000)).toBe('5.0 ha');
    expect(fmtArea(3_500_000)).toBe('3.50 km²');
  });

  it('writes a valid one-page PDF around a JPEG', async () => {
    const { jpegToPdf } = await import('../app/lib/exportmap');
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const pdf = jpegToPdf(jpeg, 1600, 900);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 842 473.63]');
    expect(text).toContain('/Width 1600 /Height 900');
    // Every xref offset points at the start of its object.
    const xref = +text.match(/startxref\n(\d+)/)![1];
    const offsets = text.slice(xref).match(/\d{10} 00000 n/g)!.map((l) => +l.slice(0, 10));
    offsets.forEach((o, i) => expect(text.slice(o, o + 8)).toBe(`${i + 1} 0 obj\n`));
  });
});
