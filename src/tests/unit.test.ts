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
