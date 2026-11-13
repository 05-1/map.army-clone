// "Export map" window, shared by the editor, player and viewer pages.
import type { Map as MlMap } from 'maplibre-gl';
import { useEffect, useState } from 'react';
import { exportMap, type ExportOptions } from './exportmap';

interface Props {
  map: MlMap | null;
  title: string;
  subtitle: string;
  attribution: string;
  /** Called before the picture is taken (e.g. to clear a selection). */
  prepare?(): void;
  onClose(): void;
}

export function ExportDialog({ map, title: t0, subtitle, attribution, prepare, onClose }: Props) {
  const [format, setFormat] = useState<ExportOptions['format']>('png');
  const [scale, setScale] = useState<ExportOptions['scale']>(2);
  const [title, setTitle] = useState(t0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const go = async () => {
    if (!map) return;
    setBusy(true);
    setError('');
    try {
      prepare?.();
      await exportMap(map, { format, scale, title: title.trim() || t0, subtitle, attribution });
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Export failed');
    }
    setBusy(false);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Export map" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <header>
          <h2>Export map</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <p className="tip">Saves exactly what is on screen now (zoom, position, visible layers), with a footer for the title, date and map credits.</p>
        <label className="field wide"><span>Title</span><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="row2">
          <label className="field"><span>Format</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as ExportOptions['format'])}>
              <option value="png">PNG image</option>
              <option value="pdf">PDF (one page)</option>
            </select>
          </label>
          <label className="field"><span>Resolution</span>
            <select value={scale} onChange={(e) => setScale(+e.target.value as ExportOptions['scale'])}>
              <option value={2}>High (2× the screen)</option>
              <option value={1}>Screen</option>
            </select>
          </label>
        </div>
        {error && <p className="note bad" role="alert">{error}</p>}
        <div className="row2">
          <button type="button" className="btn primary" disabled={busy || !map} onClick={() => void go()}>{busy ? 'Rendering…' : 'Download'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
