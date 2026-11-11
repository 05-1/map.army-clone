import type { Map as MlMap, StyleSpecification } from 'maplibre-gl';
import type { BasemapId } from './types';

interface Basemap {
  label: string;
  tiles: string[];
  maxzoom: number;
  attribution: string;
}

// Raster sources used without an API key (CARTO dark was removed: it needs a key since 2026-09-25). Check each provider's terms before heavy or commercial use (see README).
export const BASEMAPS: Record<BasemapId, Basemap> = {
  satellite: {
    label: 'Satellite',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution:
      'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  topo: {
    label: 'Topo',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17,
    attribution:
      'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)',
  },
};
export const BASEMAP_IDS = Object.keys(BASEMAPS) as BasemapId[];

/** Maps saved before 'dark' was removed (or anything unknown) open on satellite. */
export function asBasemap(v: unknown): BasemapId {
  return typeof v === 'string' && v in BASEMAPS ? (v as BasemapId) : 'satellite';
}

/** One style holding every basemap; switching only flips layer visibility, so the overlay layers survive. */
export function baseStyle(active: BasemapId): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0e12' } }],
  };
  for (const id of BASEMAP_IDS) {
    const b = BASEMAPS[id];
    style.sources[`bm-${id}`] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    style.layers.push({
      id: `bm-${id}`,
      type: 'raster',
      source: `bm-${id}`,
      layout: { visibility: id === active ? 'visible' : 'none' },
    });
  }
  return style;
}

export function setBasemap(map: MlMap, active: BasemapId) {
  for (const id of BASEMAP_IDS) map.setLayoutProperty(`bm-${id}`, 'visibility', id === active ? 'visible' : 'none');
}
