// Builds public/countries.json, the country list for spawn zones, from Natural Earth 1:50m borders
// (public domain, via the world-atlas package). Run once after upgrading world-atlas:
//   node scripts/countries.mjs
// Each entry: { name, geometry: MultiPolygon }. Coordinates are rounded to 0.001° (about 100 m).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
const round = (n) => Math.round(n * 1000) / 1000;
const ring = (r) => {
  const out = [];
  for (const [x, y] of r) {
    const p = [round(x), round(y)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length && (out[0][0] !== out.at(-1)[0] || out[0][1] !== out.at(-1)[1])) out.push(out[0]);
  return out;
};
const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)
  .map((p) => p.map(ring).filter((r) => r.length >= 4))
  .filter((p) => p.length);

const out = feature(topo, topo.objects.countries).features
  .filter((f) => f.geometry && f.properties?.name)
  .map((f) => ({ name: f.properties.name, geometry: { type: 'MultiPolygon', coordinates: polys(f.geometry) } }))
  .filter((c) => c.geometry.coordinates.length)
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('public/countries.json', JSON.stringify(out));
const sizes = out.map((c) => [c.name, JSON.stringify(c.geometry).length, c.geometry.coordinates.length, Math.max(...c.geometry.coordinates.flat().map((r) => r.length))]).sort((a, b) => b[1] - a[1]);
console.log(`${out.length} countries, ${JSON.stringify(out).length} bytes; largest:`, sizes.slice(0, 4));
