import { create } from 'zustand';
import { DEFAULT_DRAFT, type SymbolDraft } from '../lib/symbols';
import { DEFAULT_STYLE, type Asset, type Change, type Feature, type Layer, type MapMeta, type Player, type SnapshotPayload, type Style, type TurnBundle } from '../lib/types';

export type Tool = 'select' | 'symbol' | 'asset' | 'text' | 'line' | 'arrow' | 'polygon' | 'circle' | 'freehand' | 'measure';
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

interface Doc {
  layers: Layer[];
  features: Feature[];
}

export interface AssetDraft {
  assetId: string | null;
  sizeMode: 'px' | 'm';
  sizePx: number;
  sizeM: number;
}


interface Ed extends Doc {
  map: MapMeta | null;
  assets: Asset[];
  players: Player[];
  /** The turn in progress with its rules, allocations and every player's draft. */
  bundle: TurnBundle | null;
  /** Draw all drafts, zones and conflicts over the live map (turn panel open). */
  showDrafts: boolean;
  /** The player whose draft is being edited. While set, the live map is locked. */
  review: { playerId: string } | null;
  /** A past turn shown read-only in place of the live map. */
  viewing: SnapshotPayload | null;
  /** The owner is drawing a spawn zone: the Tech window comes back once a polygon or circle is selected. */
  zoneDraw: boolean;
  selection: string[];
  tool: Tool;
  activeLayerId: string | null;
  style: Style;
  symbolDraft: SymbolDraft;
  assetDraft: AssetDraft;
  snap: boolean;
  undoStack: Doc[];
  redoStack: Doc[];
  saveStatus: SaveStatus;
  hint: string;
  toast: string | null;

  load(map: MapMeta, layers: Layer[], features: Feature[], assets: Asset[]): void;
  /** Record the current document as an undo step. Call before a change (or once before a drag). */
  checkpoint(): void;
  undo(): void;
  redo(): void;
  setFeatures(fn: (fs: Feature[]) => Feature[]): void;
  patch(ids: string[], fn: (f: Feature) => Feature): void;
  add(fs: Feature[]): void;
  remove(ids: string[]): void;
  select(ids: string[]): void;
  setTool(t: Tool): void;
  reorder(ids: string[], dir: 'front' | 'back'): void;
  addLayer(): void;
  patchLayer(id: string, p: Partial<Layer>): void;
  removeLayer(id: string): void;
  moveLayer(id: string, dir: 1 | -1): void;
  nextZ(): number;
  /** Layer new objects go to, or null (with a toast) if it is hidden or locked. */
  targetLayer(): Layer | null;
  say(msg: string): void;
  /** Pick a player's draft for editing (live editing pauses), or stop with null. */
  setReview(playerId: string | null): void;
  /** Replace the owner's edited version of a draft, locally. Saving is the caller's job. */
  setOwnerChanges(playerId: string, changes: Change[] | null): void;
  /**
   * Fold rows the server changed (an approved turn) into the document and into the undo history,
   * so undoing an earlier edit never silently reverts or deletes what was approved.
   */
  applyServer(upserts: Feature[], deletes: string[]): void;
}

let toastTimer = 0;

export const newLayer = (name: string, z: number): Layer => ({ id: crypto.randomUUID(), name, visible: true, locked: false, z });

export const useEd = create<Ed>()((set, get) => ({
  map: null,
  layers: [],
  features: [],
  assets: [],
  players: [],
  bundle: null,
  showDrafts: false,
  review: null,
  zoneDraw: false,
  viewing: null,
  selection: [],
  tool: 'select',
  activeLayerId: null,
  style: DEFAULT_STYLE,
  symbolDraft: DEFAULT_DRAFT,
  assetDraft: { assetId: null, sizeMode: 'px', sizePx: 64, sizeM: 300 },
  snap: true,
  undoStack: [],
  redoStack: [],
  saveStatus: 'saved',
  hint: '',
  toast: null,

  load(map, layers, features, assets) {
    const ls = layers.length ? layers : [newLayer('Layer 1', 0)];
    set({
      map, layers: ls, features, assets, players: [], bundle: null, showDrafts: false, review: null, viewing: null,
      selection: [], tool: 'select', undoStack: [], redoStack: [],
      activeLayerId: ls[ls.length - 1].id, saveStatus: 'saved', hint: '',
    });
  },

  checkpoint() {
    const { layers, features, undoStack } = get();
    const top = undoStack[undoStack.length - 1];
    if (top && top.layers === layers && top.features === features) return;
    set({ undoStack: [...undoStack.slice(-99), { layers, features }], redoStack: [] });
  },
  undo() {
    const { undoStack, redoStack, layers, features, selection, activeLayerId } = get();
    let doc = undoStack[undoStack.length - 1];
    let rest = undoStack.slice(0, -1);
    // Skip checkpoints that turned out to be no-ops (e.g. a field was focused but not edited).
    while (doc && doc.layers === layers && doc.features === features) {
      doc = rest[rest.length - 1];
      rest = rest.slice(0, -1);
    }
    if (!doc) return set({ undoStack: [] });
    const alive = new Set(doc.features.map((f) => f.id));
    set({
      ...doc, undoStack: rest, redoStack: [...redoStack, { layers, features }],
      selection: selection.filter((id) => alive.has(id)),
      activeLayerId: doc.layers.some((l) => l.id === activeLayerId) ? activeLayerId : doc.layers[doc.layers.length - 1]?.id ?? null,
    });
  },
  redo() {
    const { undoStack, redoStack, layers, features, selection } = get();
    const doc = redoStack[redoStack.length - 1];
    if (!doc) return;
    const alive = new Set(doc.features.map((f) => f.id));
    set({ ...doc, redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, { layers, features }], selection: selection.filter((id) => alive.has(id)) });
  },

  setFeatures: (fn) => set({ features: fn(get().features) }),
  patch(ids, fn) {
    const s = new Set(ids);
    set({ features: get().features.map((f) => (s.has(f.id) ? fn(f) : f)) });
  },
  add(fs) {
    if (!fs.length) return;
    get().checkpoint();
    set({ features: [...get().features, ...fs], selection: fs.map((f) => f.id) });
  },
  remove(ids) {
    if (!ids.length) return;
    const s = new Set(ids);
    get().checkpoint();
    set({ features: get().features.filter((f) => !s.has(f.id)), selection: get().selection.filter((id) => !s.has(id)) });
  },
  select: (ids) => set({ selection: ids }),
  setTool: (tool) => set({ tool, hint: '' }),

  reorder(ids, dir) {
    if (!ids.length) return;
    const s = new Set(ids);
    const zs = get().features.map((f) => f.z);
    const edge = dir === 'front' ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - ids.length;
    get().checkpoint();
    let i = 0;
    set({ features: get().features.map((f) => (s.has(f.id) ? { ...f, z: edge + i++ } : f)) });
  },

  addLayer() {
    const { layers } = get();
    const l = newLayer(`Layer ${layers.length + 1}`, Math.max(-1, ...layers.map((x) => x.z)) + 1);
    get().checkpoint();
    set({ layers: [...layers, l], activeLayerId: l.id });
  },
  patchLayer(id, p) {
    set({ layers: get().layers.map((l) => (l.id === id ? { ...l, ...p } : l)) });
  },
  removeLayer(id) {
    const { layers, features, activeLayerId, selection } = get();
    if (layers.length <= 1) return get().say('A map needs at least one layer');
    get().checkpoint();
    const rest = layers.filter((l) => l.id !== id);
    const gone = new Set(features.filter((f) => f.layer_id === id).map((f) => f.id));
    set({
      layers: rest,
      features: features.filter((f) => f.layer_id !== id),
      selection: selection.filter((x) => !gone.has(x)),
      activeLayerId: activeLayerId === id ? rest[rest.length - 1].id : activeLayerId,
    });
  },
  moveLayer(id, dir) {
    const sorted = [...get().layers].sort((a, b) => a.z - b.z);
    const i = sorted.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sorted.length) return;
    get().checkpoint();
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    const z = new Map(sorted.map((l, k) => [l.id, k]));
    set({ layers: get().layers.map((l) => (l.z === z.get(l.id) ? l : { ...l, z: z.get(l.id)! })) });
  },

  nextZ: () => Math.max(0, ...get().features.map((f) => f.z)) + 1,
  targetLayer() {
    const { layers, activeLayerId } = get();
    const l = layers.find((x) => x.id === activeLayerId) ?? null;
    if (!l) return null;
    if (l.locked || !l.visible) {
      get().say(`Layer "${l.name}" is ${l.locked ? 'locked' : 'hidden'}`);
      return null;
    }
    return l;
  },
  setReview(playerId) {
    set(playerId ? { review: { playerId }, selection: [], tool: 'select', hint: '' } : { review: null });
  },
  setOwnerChanges(playerId, changes) {
    const b = get().bundle;
    if (b) set({ bundle: { ...b, drafts: b.drafts.map((d) => (d.player_id === playerId ? { ...d, owner_changes: changes } : d)) } });
  },
  applyServer(upserts, deletes) {
    if (!upserts.length && !deletes.length) return;
    const up = new Map(upserts.map((f) => [f.id, f]));
    const gone = new Set(deletes);
    const merge = (fs: Feature[]) => {
      const seen = new Set<string>();
      const out = fs.filter((f) => !gone.has(f.id)).map((f) => (seen.add(f.id), up.get(f.id) ?? f));
      for (const f of upserts) if (!seen.has(f.id)) out.push(f);
      return out;
    };
    const { features, undoStack, redoStack, selection } = get();
    set({
      features: merge(features),
      undoStack: undoStack.map((d) => ({ ...d, features: merge(d.features) })),
      redoStack: redoStack.map((d) => ({ ...d, features: merge(d.features) })),
      selection: selection.filter((id) => !gone.has(id)),
    });
  },
  say(msg) {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 3500);
  },
}));
