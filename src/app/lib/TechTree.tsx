// The tech tree as a flowchart: boxes anywhere on a canvas, arrows from each prerequisite to the items
// that need it. Shared by the owner's editor (drag boxes, drag a dot onto another box to link, arrow
// buttons to grow the tree in any direction) and the player page (read-only, with action buttons).
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { costText, type TechStatus } from './tech';
import type { TechItem } from './types';

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface XY { x: number; y: number }

export interface FlowEdit {
  onMove(moves: (XY & { id: string })[]): void;
  /** "item requires prereq" */
  onLink(prereqId: string, itemId: string): void;
  onUnlink(prereqId: string, itemId: string): void;
  onGrow(fromId: string, dir: Dir, at: XY): void;
}

interface Props {
  items: TechItem[];
  icon(it: TechItem): string | null;
  status?(it: TechItem): TechStatus;
  selected?: string | null;
  onPick?(it: TechItem | null): void;
  /** Extra content at the bottom of a box (buttons on the player page). */
  footer?(it: TechItem): ReactNode;
  edit?: FlowEdit;
}

export const NODE_W = 200;
const COL_W = 280;
const ROW_H = 190;
const PAD = 60;
const SNAP = 10;
const GAP = 60;
const STATUS_TEXT: Record<TechStatus, string> = { unlocked: 'unlocked', researching: 'researching', available: 'can research', locked: 'locked' };
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** Where each box goes: its saved position, or by tier (column) and order for items never placed. */
export function layout(items: readonly TechItem[]): Map<string, XY> {
  const out = new Map<string, XY>();
  const rows = new Map<number, number>();
  for (const it of [...items].sort((a, b) => a.tier - b.tier || a.sort - b.sort || a.name.localeCompare(b.name))) {
    if (it.pos_x != null && it.pos_y != null) out.set(it.id, { x: it.pos_x, y: it.pos_y });
    else {
      const r = rows.get(it.tier) ?? 0;
      rows.set(it.tier, r + 1);
      out.set(it.id, { x: it.tier * COL_W, y: r * ROW_H });
    }
  }
  return out;
}

type Drag =
  | { kind: 'node'; id: string; start: XY; from: XY; moved: boolean }
  | { kind: 'link'; id: string; at: XY }
  | { kind: 'pan'; sx: number; sy: number; left: number; top: number; moved: boolean };

export function TechTree({ items, icon, status, selected, onPick, footer, edit }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [over, setOver] = useState<Map<string, XY>>(new Map());   // positions while dragging, before the save lands
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);

  const base = useMemo(() => layout(items), [items]);
  // A saved position replaces the local one once it comes back from the server.
  const pos = (id: string) => over.get(id) ?? base.get(id) ?? { x: 0, y: 0 };
  const size = (id: string) => sizes.get(id) ?? { w: NODE_W, h: 90 };

  const all = items.map((it) => pos(it.id));
  const minX = Math.min(0, ...all.map((p) => p.x)) - PAD;
  const minY = Math.min(0, ...all.map((p) => p.y)) - PAD;
  const maxX = Math.max(NODE_W, ...items.map((it) => pos(it.id).x + size(it.id).w)) + PAD;
  const maxY = Math.max(90, ...items.map((it) => pos(it.id).y + size(it.id).h)) + PAD;
  const W = maxX - minX;
  const H = maxY - minY;

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const next = new Map<string, { w: number; h: number }>();
    el.querySelectorAll<HTMLElement>('[data-tech]').forEach((n) => next.set(n.dataset.tech!, { w: n.offsetWidth, h: n.offsetHeight }));
    const same = next.size === sizes.size && [...next].every(([k, v]) => sizes.get(k)?.w === v.w && sizes.get(k)?.h === v.h);
    if (!same) setSizes(next);
  });
  useLayoutEffect(() => {
    // Forget local positions the server now agrees with.
    if (!over.size) return;
    const keep = new Map([...over].filter(([id, p]) => { const b = base.get(id); return !b || b.x !== p.x || b.y !== p.y; }));
    if (keep.size !== over.size) setOver(keep);
  }, [base, over]);

  /** Pointer position in tree coordinates. */
  const toTree = (e: { clientX: number; clientY: number }): XY => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom + minX, y: (e.clientY - r.top) / zoom + minY };
  };

  const onNodeDown = (e: RPointerEvent, it: TechItem) => {
    e.stopPropagation();   // a press on a box never pans, and its buttons keep their clicks
    if (e.button !== 0 || !edit || (e.target as HTMLElement).closest('button, .flowdot')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: 'node', id: it.id, start: toTree(e), from: pos(it.id), moved: false });
  };
  const onDotDown = (e: RPointerEvent, it: TechItem) => {
    e.stopPropagation();
    e.preventDefault();
    canvas.current!.setPointerCapture(e.pointerId);
    setDrag({ kind: 'link', id: it.id, at: toTree(e) });
  };
  const onBgDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const s = scroller.current!;
    s.setPointerCapture(e.pointerId);
    setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, left: s.scrollLeft, top: s.scrollTop, moved: false });
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      const s = scroller.current!;
      s.scrollLeft = drag.left - (e.clientX - drag.sx);
      s.scrollTop = drag.top - (e.clientY - drag.sy);
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) setDrag({ ...drag, moved: true });
    } else if (drag.kind === 'node') {
      const p = toTree(e);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * zoom < 4) return;
      setOver(new Map(over).set(drag.id, { x: snap(drag.from.x + dx), y: snap(drag.from.y + dy) }));
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else {
      setDrag({ ...drag, at: toTree(e) });
    }
  };
  const onUp = (e: RPointerEvent) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === 'pan') {
      if (!d.moved) onPick?.(null);
    } else if (d.kind === 'node') {
      const it = items.find((x) => x.id === d.id);
      if (d.moved) edit?.onMove([{ id: d.id, ...pos(d.id) }]);
      else if (it) onPick?.(it);
    } else {
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-tech]')?.dataset.tech;
      if (target && target !== d.id) edit?.onLink(d.id, target);
    }
  };

  /** Arrow from the side of a facing b, as a curve, plus its midpoint. */
  const edgePath = (a: string, b: string) => {
    const pa = pos(a), sa = size(a), pb = pos(b), sb = size(b);
    const ca = { x: pa.x + sa.w / 2, y: pa.y + sa.h / 2 };
    const cb = { x: pb.x + sb.w / 2, y: pb.y + sb.h / 2 };
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    const horiz = Math.abs(dx) / (sa.w + sb.w) >= Math.abs(dy) / (sa.h + sb.h);
    const s = horiz ? { x: dx > 0 ? pa.x + sa.w : pa.x, y: ca.y } : { x: ca.x, y: dy > 0 ? pa.y + sa.h : pa.y };
    const t = horiz ? { x: dx > 0 ? pb.x : pb.x + sb.w, y: cb.y } : { x: cb.x, y: dy > 0 ? pb.y : pb.y + sb.h };
    const k = Math.max(30, (horiz ? Math.abs(t.x - s.x) : Math.abs(t.y - s.y)) / 2);
    const c1 = horiz ? { x: s.x + Math.sign(dx || 1) * k, y: s.y } : { x: s.x, y: s.y + Math.sign(dy || 1) * k };
    const c2 = horiz ? { x: t.x - Math.sign(dx || 1) * k, y: t.y } : { x: t.x, y: t.y - Math.sign(dy || 1) * k };
    const X = (v: number) => v - minX;
    const Y = (v: number) => v - minY;
    return {
      d: `M${X(s.x)},${Y(s.y)} C${X(c1.x)},${Y(c1.y)} ${X(c2.x)},${Y(c2.y)} ${X(t.x)},${Y(t.y)}`,
      mid: { x: X((s.x + 3 * c1.x + 3 * c2.x + t.x) / 8), y: Y((s.y + 3 * c1.y + 3 * c2.y + t.y) / 8) },
    };
  };

  if (!items.length) return <p className="empty">The tech tree is empty.</p>;
  const edges = items.flatMap((it) => it.prereqs.filter((p) => base.has(p)).map((p) => ({ from: p, to: it.id })));
  const sel = selected ? items.find((x) => x.id === selected) : undefined;

  return (
    <div className={`flow${edit ? ' editing' : ''}`}>
      <div className="flowzoom" role="group" aria-label="Zoom">
        <button type="button" className="btn sm" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn sm" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
        <button type="button" className="btn sm" onClick={() => {
          const s = scroller.current!;
          setZoom(Math.max(0.3, Math.min(1, (s.clientWidth - 8) / W, (s.clientHeight - 8) / H)));
        }}>Fit</button>
      </div>
      <div className={`flowscroll${drag?.kind === 'pan' ? ' panning' : ''}`} ref={scroller} onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp}>
        <div style={{ width: W * zoom, height: H * zoom, position: 'relative' }}>
          <div className="flowcanvas" ref={canvas} style={{ width: W, height: H, transform: `scale(${zoom})` }}>
            <svg className="techlines" width={W} height={H} aria-hidden>
              <defs>
                <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" />
                </marker>
              </defs>
              {edges.map((e) => (
                <path key={`${e.from}>${e.to}`} d={edgePath(e.from, e.to).d} markerEnd="url(#flow-arrow)" className={selected === e.from || selected === e.to ? 'hot' : ''} />
              ))}
              {drag?.kind === 'link' && (
                <line className="hot" x1={pos(drag.id).x + size(drag.id).w / 2 - minX} y1={pos(drag.id).y + size(drag.id).h / 2 - minY} x2={drag.at.x - minX} y2={drag.at.y - minY} strokeDasharray="6 4" />
              )}
            </svg>
            {edit && sel && edges.filter((e) => e.from === sel.id || e.to === sel.id).map((e) => {
              const m = edgePath(e.from, e.to).mid;
              const a = items.find((x) => x.id === e.from)?.name;
              const b = items.find((x) => x.id === e.to)?.name;
              return (
                <button key={`x${e.from}>${e.to}`} type="button" className="flowcut" style={{ left: m.x, top: m.y }} title={`Remove link: ${b} requires ${a}`}
                  onPointerDown={(ev) => ev.stopPropagation()} onClick={() => edit.onUnlink(e.from, e.to)}>✕</button>
              );
            })}
            {items.map((it) => {
              const p = pos(it.id);
              const st = status?.(it);
              const src = icon(it);
              return (
                <div
                  key={it.id} data-tech={it.id} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined}
                  className={`techcard${st ? ` ${st}` : ''}${selected === it.id ? ' on' : ''}${drag?.kind === 'node' && drag.id === it.id ? ' dragging' : ''}`}
                  style={{ left: p.x - minX, top: p.y - minY, width: NODE_W }}
                  onPointerDown={(e) => onNodeDown(e, it)}
                  onClick={(e) => { e.stopPropagation(); if (!edit) onPick?.(it); }}
                  onKeyDown={(e) => e.key === 'Enter' && onPick?.(it)}
                >
                  <div className="techhead">
                    {src ? <img className="mini" src={src} alt="" draggable={false} /> : <span className="mini techdot" aria-hidden>◆</span>}
                    <strong>{it.name}</strong>
                  </div>
                  <small>
                    {it.category === 'building' && <span className="tag bld">building</span>}
                    {it.research_cost ? `Research ${costText(it, 'research')}` : 'Starts unlocked'}
                    {it.buyable ? ` · ${it.category === 'building' ? 'Build' : 'Buy'} ${costText(it, 'buy')}` : ' · research only'}
                  </small>
                  {it.spawn_from.length > 0 && <small>Made at {it.spawn_from.map((id) => items.find((x) => x.id === id)?.name).filter(Boolean).join(', ')}</small>}
                  {(it.income_spawn > 0 || it.income_research > 0 || !!it.spawn_radius_m) && (
                    <small className="perks">
                      {it.income_spawn > 0 && `+${it.income_spawn} spawn/turn `}
                      {it.income_research > 0 && `+${it.income_research} research/turn `}
                      {it.spawn_radius_m ? `spawn point ${+(it.spawn_radius_m / 1000).toFixed(2)} km` : ''}
                    </small>
                  )}
                  {st && <span className={`tag ${st === 'unlocked' ? 'ok' : st === 'researching' ? 'warn' : ''}`}>{STATUS_TEXT[st]}</span>}
                  {footer?.(it)}
                  {edit && (['up', 'right', 'down', 'left'] as const).map((side) => (
                    <span key={side} className={`flowdot ${side}`} title="Drag onto another box: that box will require this one" onPointerDown={(e) => onDotDown(e, it)} />
                  ))}
                </div>
              );
            })}
            {edit && sel && (['up', 'right', 'down', 'left'] as const).map((dir) => {
              const p = pos(sel.id);
              const s = size(sel.id);
              const at = { up: { x: p.x + s.w / 2, y: p.y - 22 }, down: { x: p.x + s.w / 2, y: p.y + s.h + 22 }, left: { x: p.x - 22, y: p.y + s.h / 2 }, right: { x: p.x + s.w + 22, y: p.y + s.h / 2 } }[dir];
              // The new box goes a clear gap away from this one's edge.
              const to = { up: { x: p.x, y: p.y - 150 - GAP }, down: { x: p.x, y: p.y + Math.max(s.h, 150) + GAP }, left: { x: p.x - NODE_W - GAP * 1.5, y: p.y }, right: { x: p.x + s.w + GAP * 1.5, y: p.y } }[dir];
              return (
                <button
                  key={dir} type="button" className="flowgrow" style={{ left: at.x - minX, top: at.y - minY }}
                  title={`New item ${dir === 'up' ? 'above' : dir === 'down' ? 'below' : `to the ${dir}`} that requires ${sel.name}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => edit.onGrow(sel.id, dir, { x: snap(to.x), y: snap(to.y) })}
                >
                  {{ up: '↑', down: '↓', left: '←', right: '→' }[dir]}+
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
