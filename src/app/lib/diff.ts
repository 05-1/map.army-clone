import type { Feature, Layer } from './types';

export interface Diff {
  layerUpserts: Layer[];
  layerDeletes: string[];
  featureUpserts: Feature[];
  featureDeletes: string[];
}

function diffList<T extends { id: string }>(saved: Map<string, T>, current: T[]) {
  const upserts: T[] = [];
  const seen = new Set<string>();
  for (const item of current) {
    seen.add(item.id);
    // State updates are immutable, so reference inequality means "changed since last save".
    if (saved.get(item.id) !== item) upserts.push(item);
  }
  const deletes: string[] = [];
  for (const id of saved.keys()) if (!seen.has(id)) deletes.push(id);
  return { upserts, deletes };
}

export function computeDiff(
  savedLayers: Map<string, Layer>,
  savedFeatures: Map<string, Feature>,
  layers: Layer[],
  features: Feature[],
): Diff {
  const l = diffList(savedLayers, layers);
  const f = diffList(savedFeatures, features);
  return { layerUpserts: l.upserts, layerDeletes: l.deletes, featureUpserts: f.upserts, featureDeletes: f.deletes };
}

export const isEmptyDiff = (d: Diff) =>
  !d.layerUpserts.length && !d.layerDeletes.length && !d.featureUpserts.length && !d.featureDeletes.length;
