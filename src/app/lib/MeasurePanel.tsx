// Controls and reading for the measuring tool, shared by the editor, player and viewer pages.
import type { Measure, MeasureMode, MeasureState } from './measure';

export function MeasurePanel({ m, s, onClose }: { m: Measure | null; s: MeasureState; onClose?(): void }) {
  const mode = (v: MeasureMode) => m?.setMode(v);
  return (
    <div className="measurepanel">
      <div className="seg compact" role="group" aria-label="Measure">
        <button type="button" className={s.mode === 'distance' ? 'on' : ''} onClick={() => mode('distance')}>Distance</button>
        <button type="button" className={s.mode === 'area' ? 'on' : ''} onClick={() => mode('area')}>Area</button>
      </div>
      <p className="measureread mono" aria-live="polite">{s.text || (s.mode === 'distance' ? 'Click points along the route' : 'Click the corners of the area')}</p>
      <div className="row2 wrap">
        <button type="button" className="btn sm" disabled={s.points < 2 || s.done} onClick={() => m?.finish()}>Finish</button>
        <button type="button" className="btn sm" disabled={!s.points} onClick={() => m?.undo()}>Undo point</button>
        <button type="button" className="btn sm" disabled={!s.points} onClick={() => m?.clear()}>Clear</button>
        {onClose && <button type="button" className="btn sm" onClick={onClose}>Done</button>}
      </div>
      <p className="tip">Double-click or Enter finishes; the next click starts a new measurement. Nothing is saved.</p>
    </div>
  );
}

export const MEASURE_IDLE: MeasureState = { active: false, mode: 'distance', points: 0, done: false, text: '' };
