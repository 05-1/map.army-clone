import { AttributionControl, Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 looks for its worker next to its own module, which no longer exists after bundling.
// Emit the worker as a same-origin asset and point MapLibre at it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { asBasemap, baseStyle } from './basemaps';
import type { BasemapId, Pos } from './types';

setWorkerUrl(workerUrl);

export function createMap(container: HTMLElement, view: { basemap: BasemapId; center: Pos; zoom: number }): MlMap {
  const map = new MlMap({
    container,
    style: baseStyle(asBasemap(view.basemap)),
    center: view.center,
    zoom: view.zoom,
    maxZoom: 21,
    maxPitch: 0, // north-up, flat: tactical overlays are drawn for a plan view
    attributionControl: false,
    doubleClickZoom: false,
    boxZoom: false,
  });
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: false }), 'bottom-right');
  map.addControl(new ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');
  return map;
}
