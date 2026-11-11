// The tech tree as columns of cards (one column per tier) with lines from each prerequisite to the
// items that need it. Shared by the owner's editor (status-free, click to edit) and the player page.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { columns, costText, type TechStatus } from './tech';
import type { TechItem } from './types';

interface Props {
  items: TechItem[];
  icon(it: TechItem): string | null;
  status?(it: TechItem): TechStatus;
  selected?: string | null;
  onPick?(it: TechItem): void;
  /** Extra content under a card's costs (buttons on the player page). */
  footer?(it: TechItem): ReactNode;
}

const STATUS_TEXT: Record<TechStatus, string> = { unlocked: 'unlocked', researching: 'in draft', available: 'can research', locked: 'locked' };

export function TechTree({ items, icon, status, selected, onPick, footer }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ key: string; d: string; hot: boolean }[]>([]);

  // Connectors are measured from the laid-out cards, so they follow wrapping and font sizes.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const at = (id: string) => el.querySelector<HTMLElement>(`[data-tech="${id}"]`)?.getBoundingClientRect();
      const out: { key: string; d: string; hot: boolean }[] = [];
      for (const it of items) {
        const to = at(it.id);
        if (!to) continue;
        for (const pre of it.prereqs) {
          const from = at(pre);
          if (!from) continue;
          const x1 = from.right - base.left + el.scrollLeft;
          const y1 = from.top + from.height / 2 - base.top + el.scrollTop;
          const x2 = to.left - base.left + el.scrollLeft;
          const y2 = to.top + to.height / 2 - base.top + el.scrollTop;
          const mx = (x1 + x2) / 2;
          out.push({ key: `${pre}>${it.id}`, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, hot: selected === it.id || selected === pre });
        }
      }
      setLines(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items, selected]);

  if (!items.length) return <p className="empty">The tech tree is empty.</p>;
  const cols = columns(items);
  return (
    <div className="techtree" ref={box}>
      <svg className="techlines" aria-hidden>
        {lines.map((l) => <path key={l.key} d={l.d} className={l.hot ? 'hot' : ''} />)}
      </svg>
      {cols.map((col) => (
        <div className="techcol" key={col[0].tier}>
          <div className="techtier">Tier {col[0].tier}</div>
          {col.map((it) => {
            const st = status?.(it);
            const src = icon(it);
            return (
              <div
                key={it.id} data-tech={it.id} role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined}
                className={`techcard${st ? ` ${st}` : ''}${selected === it.id ? ' on' : ''}`}
                onClick={() => onPick?.(it)} onKeyDown={(e) => e.key === 'Enter' && onPick?.(it)}
              >
                <div className="techhead">
                  {src ? <img className="mini" src={src} alt="" /> : <span className="mini techdot" aria-hidden>◆</span>}
                  <strong>{it.name}</strong>
                </div>
                <small>
                  {it.research_cost ? `Research ${costText(it, 'research')}` : 'Starts unlocked'}
                  {it.buyable ? ` · Buy ${costText(it, 'buy')}` : ' · research only'}
                </small>
                {(it.income_spawn > 0 || it.income_research > 0 || it.spawn_radius_m) && (
                  <small className="perks">
                    {it.income_spawn > 0 && `+${it.income_spawn} spawn/turn `}
                    {it.income_research > 0 && `+${it.income_research} research/turn `}
                    {it.spawn_radius_m ? `spawn point ${+(it.spawn_radius_m / 1000).toFixed(2)} km` : ''}
                  </small>
                )}
                {st && <span className={`tag ${st === 'unlocked' ? 'ok' : st === 'researching' ? 'warn' : ''}`}>{STATUS_TEXT[st]}</span>}
                {footer?.(it)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
