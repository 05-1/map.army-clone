// The terrain overlay (urban / forest zones) for any map page, drawn under the map's objects.
import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import { TERRAIN_COLORS } from './terrain';

const SRC = 'terrain';
const LAYERS = [
  { id: 'terrain-fill', type: 'fill', source: SRC, paint: { 'fill-color': ['match', ['get', 'type'], 'urban', TERRAIN_COLORS.urban, TERRAIN_COLORS.forest], 'fill-opacity': 0.28 } },
  { id: 'terrain-line', type: 'line', source: SRC, paint: { 'line-color': ['match', ['get', 'type'], 'urban', TERRAIN_COLORS.urban, TERRAIN_COLORS.forest], 'line-width': 1.2, 'line-opacity': 0.8 } },
] as unknown as LayerSpecification[];

/** Show or hide terrain. Data is loaded by the caller (each page has its own RPC). */
export function setTerrain(map: MlMap, fc: FeatureCollection | null) {
  if (!fc) {
    for (const l of LAYERS) if (map.getLayer(l.id)) map.removeLayer(l.id);
    if (map.getSource(SRC)) map.removeSource(SRC);
    return;
  }
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (src) return src.setData(fc);
  map.addSource(SRC, { type: 'geojson', data: fc });
  // Directly above the basemap, below every map object.
  const firstOverlay = map.getStyle().layers.find((l) => l.id !== 'bg' && !l.id.startsWith('bm-'))?.id;
  for (const l of LAYERS) map.addLayer(l, firstOverlay);
}
