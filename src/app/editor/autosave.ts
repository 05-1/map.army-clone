import { computeDiff, isEmptyDiff } from '../lib/diff';
import type { Feature, Layer, MapMeta } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';

const DEBOUNCE_MS = 600;

/** Watches the store and persists only what changed. Returns a stop function that flushes pending work. */
export function startAutosave(backend: Backend, map: MapMeta, persisted: { layers: Layer[]; features: Feature[] }) {
  let savedL = new Map(persisted.layers.map((l) => [l.id, l]));
  let savedF = new Map(persisted.features.map((f) => [f.id, f]));
  let timer = 0;
  let running = false;
  let again = false;
  let stopped = false;

  const schedule = (ms = DEBOUNCE_MS) => {
    clearTimeout(timer);
    timer = window.setTimeout(flush, ms);
  };

  async function flush() {
    clearTimeout(timer);
    if (running) {
      again = true;
      return;
    }
    const { layers, features } = useEd.getState();
    const diff = computeDiff(savedL, savedF, layers, features);
    if (isEmptyDiff(diff)) {
      if (!stopped) useEd.setState({ saveStatus: 'saved' });
      return;
    }
    running = true;
    if (!stopped) useEd.setState({ saveStatus: 'saving' });
    try {
      await backend.saveDiff(map.id, diff);
      savedL = new Map(layers.map((l) => [l.id, l]));
      savedF = new Map(features.map((f) => [f.id, f]));
      backend.ping(map);
      if (!stopped) useEd.setState({ saveStatus: again ? 'dirty' : 'saved' });
    } catch (e) {
      console.error('autosave failed', e);
      if (!stopped) {
        useEd.setState({ saveStatus: 'error' });
        schedule(5000);
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule(0);
      }
    }
  }

  // The first flush persists the default layer of a brand-new map.
  schedule(0);

  const unsub = useEd.subscribe((s, p) => {
    if (s.layers !== p.layers || s.features !== p.features) {
      if (s.saveStatus !== 'saving') useEd.setState({ saveStatus: 'dirty' });
      schedule();
    }
  });
  const onUnload = (e: BeforeUnloadEvent) => {
    if (useEd.getState().saveStatus !== 'saved') {
      void flush();
      e.preventDefault();
    }
  };
  window.addEventListener('beforeunload', onUnload);

  return {
    flush,
    /**
     * Record rows the server wrote itself (an approved turn) as already saved. Call with the same
     * object references that go into the store, right before store.applyServer(), so the next diff is empty.
     */
    adopt(upserts: Feature[], deletes: string[]) {
      for (const f of upserts) savedF.set(f.id, f);
      for (const id of deletes) savedF.delete(id);
    },
    stop() {
      stopped = true;
      unsub();
      window.removeEventListener('beforeunload', onUnload);
      void flush();
    },
  };
}
