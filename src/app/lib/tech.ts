// Tech tree rules on the client: what a player may research or buy, what a draft costs, where a
// purchase may go. UX only: save_draft() and push_turn() enforce the same rules in the database.
import { distanceM } from './geo';
import { inZone } from './submissions';
import type { Change, Placement, Pos, SpawnZone, TechItem } from './types';

export const PLACEMENTS: [Placement, string][] = [
  ['either', 'Near a spawn point or in a spawn zone'],
  ['spawn', 'Near a spawn point only'],
  ['zone', 'In a spawn zone only'],
  ['anywhere', 'Anywhere'],
];

export const placementText = (p: Placement) =>
  ({ either: 'near a spawn point or in a spawn zone', spawn: 'near a spawn point', zone: 'in a spawn zone', anywhere: 'anywhere' })[p];

/** "near a Barracks or Factory" when the unit has producing buildings, else the plain placement rule. */
export function whereText(it: TechItem, items: readonly TechItem[]): string {
  if (!it.spawn_from.length || it.placement === 'anywhere' || it.placement === 'zone') return placementText(it.placement);
  const names = it.spawn_from.map((id) => items.find((x) => x.id === id)?.name).filter(Boolean).join(' or ');
  return it.placement === 'spawn' ? `near your ${names}` : `near your ${names} or in a spawn zone`;
}

export const isUnlocked = (it: TechItem, unlocked: readonly string[]) => it.research_cost === 0 || unlocked.includes(it.id);

/** Can be bought in this draft: researched before, free, or being researched in the same draft. */
export const usable = (it: TechItem, unlocked: readonly string[], draft: readonly Change[]) =>
  isUnlocked(it, unlocked) || draft.some((c) => c.op === 'research' && c.feature_id === it.id);

const researching = (draft: readonly Change[], id: string) => draft.some((c) => c.op === 'research' && c.feature_id === id);

/**
 * Items that stop being reachable once `gone` are taken out of a draft: research that needed them
 * (and so on down the chain) unless already done in an earlier turn.
 */
function dependents(changes: readonly Change[], gone: ReadonlySet<string>, unlocked: readonly string[], items: readonly TechItem[]): Set<string> {
  const out = new Set(gone);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of changes) {
      if (c.op !== 'research' || out.has(c.feature_id) || unlocked.includes(c.feature_id)) continue;
      if (items.find((x) => x.id === c.feature_id)?.prereqs.some((p) => out.has(p) && !unlocked.includes(p))) {
        out.add(c.feature_id);
        grew = true;
      }
    }
  }
  return out;
}

/** Draft without a research, without research that needed it, and without anything bought from those (unless researched earlier). */
export function withoutResearch(draft: readonly Change[], itemId: string, unlocked: readonly string[], items: readonly TechItem[]): Change[] {
  const gone = dependents(draft, new Set([itemId]), unlocked, items);
  const free = (id: string) => { const it = items.find((x) => x.id === id); return !!it && isUnlocked(it, unlocked); };
  return draft.filter((c) => !(c.op === 'research' && gone.has(c.feature_id)) && !(c.op === 'create' && c.payload.purchase_id && gone.has(c.payload.purchase_id) && !free(c.payload.purchase_id)));
}

/**
 * Review: rejecting a research also rejects the research and purchases that depend on it (the push
 * would refuse them), and accepting a change accepts the research it needs again.
 */
export function toggleRejected(changes: readonly Change[], rejected: readonly string[], id: string, items: readonly TechItem[] = [], unlocked: readonly string[] = []): string[] {
  const out = new Set(rejected);
  const c = changes.find((x) => x.feature_id === id);
  const inDraft = (itemId: string) => changes.some((x) => x.op === 'research' && x.feature_id === itemId);
  if (out.has(id)) {
    out.delete(id);
    // Walk back up: the item this needs, and that item's prerequisites, if they are researched in this draft.
    const need = [c?.op === 'research' ? id : c?.op === 'create' ? c.payload.purchase_id ?? '' : ''];
    while (need.length) {
      const next = need.pop()!;
      if (inDraft(next)) out.delete(next);
      const it = items.find((x) => x.id === next);
      if (!it) continue;
      for (const p of it.prereqs) if (inDraft(p) && out.has(p)) need.push(p);
    }
  } else {
    out.add(id);
    if (c?.op === 'research') {
      const gone = dependents(changes, new Set([id]), unlocked, items);
      for (const x of changes) {
        if (x.op === 'research' && gone.has(x.feature_id)) out.add(x.feature_id);
        if (x.op === 'create' && x.payload.purchase_id && gone.has(x.payload.purchase_id) && !unlocked.includes(x.payload.purchase_id)) out.add(x.feature_id);
      }
    }
  }
  return [...out];
}

/** Every prerequisite researched, earlier or in this draft. One the player cannot see (not released yet) is not. */
export function prereqsMet(it: TechItem, items: readonly TechItem[], unlocked: readonly string[], draft: readonly Change[] = []): boolean {
  return it.prereqs.every((id) => {
    const p = items.find((x) => x.id === id);
    return !!p && (isUnlocked(p, unlocked) || researching(draft, id));
  });
}

export type TechStatus = 'unlocked' | 'researching' | 'available' | 'locked';

/** unlocked: usable now. researching: in this draft. available: can be researched. locked: prerequisites missing. */
export function techStatus(it: TechItem, items: readonly TechItem[], unlocked: readonly string[], draft: readonly Change[]): TechStatus {
  if (isUnlocked(it, unlocked)) return 'unlocked';
  if (researching(draft, it.id)) return 'researching';
  return prereqsMet(it, items, unlocked, draft) ? 'available' : 'locked';
}

/** Points a draft spends: spawn points on purchases, research points on research. Rejected changes are free. */
export function draftCost(changes: readonly Change[], items: readonly TechItem[], rejected: readonly string[] = []): { spawn: number; research: number } {
  const byId = new Map(items.map((x) => [x.id, x]));
  let spawn = 0;
  let research = 0;
  for (const c of changes) {
    if (rejected.includes(c.feature_id)) continue;
    if (c.op === 'research') research += byId.get(c.feature_id)?.research_cost ?? 0;
    else if (c.op === 'create' && c.payload.purchase_id) spawn += byId.get(c.payload.purchase_id)?.spawn_cost ?? 0;
  }
  return { spawn, research };
}

export interface SpawnSource {
  center: Pos;
  radius_m: number;
  item_id?: string;
}

/** Spawn points this item may be produced at: all of them, or only its producing buildings. */
export const sourcesFor = <T extends SpawnSource>(it: TechItem, sources: readonly T[]): T[] =>
  it.spawn_from.length ? sources.filter((s) => s.item_id && it.spawn_from.includes(s.item_id)) : [...sources];

/** May a unit of this item go at pos? Mirrors private.can_spawn_at(). */
export function canPlace(it: TechItem, pos: Pos, zones: readonly Pick<SpawnZone, 'zone'>[], sources: readonly SpawnSource[]): boolean {
  const nearSpawn = () => sourcesFor(it, sources).some((s) => distanceM(s.center, pos) <= s.radius_m);
  const inSpawnZone = () => zones.some((z) => inZone(z.zone, pos));
  switch (it.placement) {
    case 'anywhere': return true;
    case 'spawn': return nearSpawn();
    case 'zone': return inSpawnZone();
    default: return nearSpawn() || inSpawnZone();
  }
}

export const fmtPts = (n: number) => n.toLocaleString();

/** "30 spawn" / "20 research" / "free" */
export function costText(it: TechItem, kind: 'buy' | 'research'): string {
  const n = kind === 'buy' ? it.spawn_cost : it.research_cost;
  return n ? `${fmtPts(n)} ${kind === 'buy' ? 'spawn' : 'research'}` : 'free';
}

/** Items grouped into tree columns by tier, each column in its sort order. */
export function columns(items: readonly TechItem[]): TechItem[][] {
  const tiers = [...new Set(items.map((x) => x.tier))].sort((a, b) => a - b);
  return tiers.map((t) => items.filter((x) => x.tier === t).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)));
}
