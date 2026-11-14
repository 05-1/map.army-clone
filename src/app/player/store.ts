import { create } from 'zustand';
import { MAX_CHANGES, proposed, putChange, removeChange } from '../lib/submissions';
import type { Change, CreatePayload, Feature, PlayerAllocation, PlayerState, SnapshotPayload } from '../lib/types';
import { draftCost, withoutResearch } from '../lib/tech';
import { saveDraft } from './client';

export type PTool = 'select' | 'place' | 'buy' | 'text' | 'arrow' | 'line' | 'polygon' | 'measure';
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

interface Play {
  playerId: string;
  state: PlayerState | null;
  /** This turn's draft. Edited locally, saved to the server a moment after every change. */
  draft: Change[];
  saveStatus: SaveStatus;
  /** Why the last save was refused (e.g. a move beyond range). The draft on screen is then ahead of the server. */
  saveError: string;
  savedAt: string | null;
  tool: PTool;
  /** Allocation being placed from (tool = 'place'). */
  allocId: string | null;
  /** Tech item being bought and placed (tool = 'buy'). */
  buyId: string | null;
  /** Points of the arrow, line or area being drawn (0 = not drawing). */
  drawing: number;
  /** Picking a target on the map for one weapon of one of the player's units. */
  targeting: { fid: string; slot: number } | null;
  /** Picking the target of a squadron's mission on the map. */
  airPick: { squadron: string; type: 'strike' | 'patrol' | 'recon'; radius_m?: number } | null;
  /** The squadron whose card is open (its radius ring is drawn). */
  airSel: string | null;
  sel: string | null;
  hint: string;
  /** A past turn shown read-only in place of the live map. */
  viewing: SnapshotPayload | null;
  /** Called after each successful save. */
  onSaved: () => void;

  init(playerId: string, state: PlayerState): void;
  refresh(state: PlayerState): void;
  /** Can the draft be changed right now? */
  editable(): boolean;
  put(c: Change): boolean;
  drop(featureId: string): void;
  patchCreate(featureId: string, fn: (p: CreatePayload) => CreatePayload): void;
  setDraft(draft: Change[]): void;
  /** Send the draft now (also used to retry after an error). */
  flush(): Promise<void>;
  setTool(t: PTool, allocId?: string | null): void;
  /** Start placing units bought from this tech item. */
  startBuy(itemId: string): void;
  say(hint: string): void;
}

const SAVE_DELAY_MS = 900;
let hintTimer = 0;
let saveTimer = 0;
let saving = false;
let again = false;

export const usePlay = create<Play>()((set, get) => {
  const change = (next: Change[]) => {
    // An escort needs its strike: escorts of a strike that was cancelled or changed go with it.
    const strikes = new Set(next.filter((c) => c.op === 'mission' && c.payload.type === 'strike').map((c) => c.feature_id));
    const draft = next.filter((c) => c.op !== 'mission' || c.payload.type !== 'escort' || strikes.has(c.payload.escort_of ?? ''));
    if (draft.length < next.length) get().say('Its escort was stood down too.');
    set({ draft, saveStatus: 'dirty' });
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().flush(), SAVE_DELAY_MS);
  };
  return {
    playerId: '',
    state: null,
    draft: [],
    saveStatus: 'saved',
    saveError: '',
    savedAt: null,
    tool: 'select',
    allocId: null,
    buyId: null,
    drawing: 0,
    targeting: null,
    airPick: null,
    airSel: null,
    sel: null,
    hint: '',
    viewing: null,
    onSaved: () => {},

    init(playerId, state) {
      set({ playerId, state, draft: state.draft?.changes ?? [], savedAt: state.draft?.updated_at ?? null, saveStatus: 'saved', saveError: '' });
    },
    refresh(state) {
      const prev = get();
      const newTurn = state.turn?.id !== prev.state?.turn?.id;
      // While local edits are unsaved they win; otherwise the server's copy is the truth
      // (it also changes when the owner clears a draft, or when a new turn starts).
      const takeServer = newTurn || (prev.saveStatus === 'saved' && !saving);
      const draft = takeServer ? state.draft?.changes ?? [] : prev.draft;
      const known = (id: string) => state.features.some((f) => f.id === id) || draft.some((c) => c.feature_id === id);
      set({
        state, draft,
        ...(takeServer ? { savedAt: state.draft?.updated_at ?? null, saveStatus: 'saved' as const, saveError: '' } : {}),
        sel: prev.sel && known(prev.sel) ? prev.sel : null,
        ...(newTurn ? { tool: 'select' as const, allocId: null, buyId: null } : {}),
      });
      if (newTurn && prev.state?.turn && state.last) get().say(`Turn ${state.last.number} was pushed. See the result on the left.`);
    },
    editable() {
      const { state, viewing } = get();
      return !!state?.turn && !state.turn.frozen && !viewing;
    },
    put(c) {
      const { draft, state } = get();
      if (!get().editable()) {
        get().say(!state?.turn ? 'No turn is open yet.' : state.turn.status === 'locked' ? 'The turn is locked for review.' : get().viewing ? 'You are looking at a past turn.' : 'The deadline for this turn has passed.');
        return false;
      }
      if (draft.length >= MAX_CHANGES && !draft.some((x) => x.feature_id === c.feature_id)) {
        get().say(`A draft holds at most ${MAX_CHANGES} changes.`);
        return false;
      }
      change(putChange(draft, c));
      return true;
    },
    drop(featureId) {
      if (!get().editable()) return;
      const { draft, state } = get();
      // Taking out a research also takes out what was bought from it this turn.
      const research = draft.some((c) => c.op === 'research' && c.feature_id === featureId);
      change(research && state ? withoutResearch(draft, featureId, state.economy.tech_unlocked, state.tech) : removeChange(draft, featureId));
      if (get().sel === featureId && !get().state?.features.some((f) => f.id === featureId)) set({ sel: null });
    },
    patchCreate(featureId, fn) {
      if (!get().editable()) return;
      change(get().draft.map((c) => (c.feature_id === featureId && c.op === 'create' ? { ...c, payload: fn(c.payload) } : c)));
    },
    setDraft(draft) {
      if (get().editable()) change(draft);
    },
    async flush() {
      clearTimeout(saveTimer);
      if (saving) {
        again = true;
        return;
      }
      const { playerId, draft } = get();
      saving = true;
      set({ saveStatus: 'saving' });
      try {
        const r = await saveDraft(playerId, draft);
        // Only "saved" if nothing changed while the request was in flight.
        set(get().draft === draft ? { saveStatus: 'saved', saveError: '', savedAt: r.updated_at } : { saveError: '' });
        get().onSaved();
      } catch (e) {
        set({ saveStatus: 'error', saveError: (e as Error).message });
      }
      saving = false;
      if (again || (get().draft !== draft && get().saveStatus !== 'error')) {
        again = false;
        void get().flush();
      }
    },
    // Any tool but select closes the details box, which would otherwise sit over the map (on a phone above all).
    setTool: (tool, allocId = null) => set({ tool, allocId, buyId: null, hint: '', targeting: null, airPick: null, ...(tool !== 'select' ? { sel: null } : {}) }),
    startBuy: (buyId) => set({ tool: 'buy', buyId, allocId: null, hint: '', sel: null }),
    say(hint) {
      set({ hint });
      clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => set({ hint: '' }), 5000);
    },
  };
});

/** Units still available from an allocation: its quantity minus what teammates and this draft have taken. */
export function remaining(a: PlayerAllocation, draft: Change[]): number {
  const mine = draft.filter((c) => c.op === 'create' && c.payload.allocation_id === a.id).length;
  return Math.max(0, a.quantity - a.used_by_others - mine);
}

/** Spawn and research points left after what this draft spends. */
export function pointsLeft(): { spawn: number; research: number } {
  const { state, draft } = usePlay.getState();
  if (!state) return { spawn: 0, research: 0 };
  const c = draftCost(draft, state.tech, [], (sq) => state.air?.squadrons.find((q) => q.id === sq)?.airframe.cost_per_aircraft ?? 0);
  return { spawn: state.economy.spawn_points - c.spawn, research: state.economy.research_points - c.research };
}

/** A feature as it would look with the draft applied, plus how the player may act on it. */
export function effective(id: string | null): { f: Feature; live: Feature | null; change: Change | null; mine: boolean; isNew: boolean } | null {
  const { state, draft, viewing } = usePlay.getState();
  if (!id || !state) return null;
  if (viewing) {
    const f = viewing.features.find((x) => x.id === id);
    return f ? { f, live: f, change: null, mine: false, isNew: false } : null;
  }
  const change = draft.find((c) => c.feature_id === id) ?? null;
  const live = state.features.find((x) => x.id === id) ?? null;
  if (change?.op === 'create') return { f: proposed(change, new Map())!, live: null, change, mine: true, isNew: true };
  if (!live) return null;
  const f = change ? proposed(change, new Map([[id, live]])) ?? live : live;
  return { f, live, change, mine: state.mine.includes(id), isNew: false };
}
