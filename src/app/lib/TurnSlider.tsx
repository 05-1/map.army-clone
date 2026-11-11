// Step back through pushed turns. Shared by the editor, the player page and the viewer.
// It only picks a turn number; what comes back for that turn is filtered by the server.
import type { HistoryEntry } from './types';

export function turnLabel(h: HistoryEntry): string {
  const base = h.number === 0 ? 'Start' : `After turn ${h.number}`;
  return h.label && h.label !== 'Start' ? `${base} (${h.label.toLowerCase()})` : base;
}

export function TurnSlider(p: { history: HistoryEntry[]; viewing: number | null; current?: number | null; /** Set when the turn in progress was opened by a rollback. */ rollbackOf?: number | null; onPick(turn: number | null): void }) {
  const { history, viewing } = p;
  if (!history.length) return null;
  const idx = viewing == null ? history.length : Math.max(0, history.findIndex((h) => h.number === viewing));
  const h = viewing == null ? null : history[idx];
  return (
    <div className="tslider" role="group" aria-label="Turn history">
      <input
        type="range" min={0} max={history.length} step={1} value={idx} aria-label="Turn"
        aria-valuetext={h ? turnLabel(h) : 'Live map'}
        onChange={(e) => {
          const i = +e.target.value;
          p.onPick(i >= history.length ? null : history[i].number);
        }}
      />
      <span className={h ? 'past' : ''}>
        {h ? `${turnLabel(h)} · ${new Date(h.at).toLocaleDateString()}` : `Live${p.current ? ` · turn ${p.current} in progress${p.rollbackOf != null ? ` (rolled back from turn ${p.rollbackOf})` : ''}` : ''}`}
      </span>
      {h && <button type="button" className="btn sm" onClick={() => p.onPick(null)}>Back to live</button>}
    </div>
  );
}
