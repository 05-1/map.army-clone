import { useEffect, useState } from 'react';
import type { MapMeta, ShareLink } from '../lib/types';
import { viewUrl } from '../lib/urls';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, Icon, IconButton } from './ui';

const EXPIRY: [string, number | null][] = [['Never', null], ['1 hour', 1], ['24 hours', 24], ['7 days', 168], ['30 days', 720]];


function status(l: ShareLink): { text: string; cls: string } {
  if (l.revoked) return { text: 'Revoked', cls: 'bad' };
  if (l.expires_at && new Date(l.expires_at) <= new Date()) return { text: 'Expired', cls: 'bad' };
  if (l.expires_at) return { text: `Expires ${new Date(l.expires_at).toLocaleString()}`, cls: 'ok' };
  return { text: 'Active', cls: 'ok' };
}

export function ShareDialog({ backend, map, flush, onClose }: { backend: Backend; map: MapMeta; flush: () => Promise<void>; onClose: () => void }) {
  const layers = useEd((s) => s.layers);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'live' | 'snapshot'>('live');
  const [hours, setHours] = useState<number | null>(null);
  const [allLayers, setAllLayers] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(layers.map((l) => l.id)));

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      setLinks(await backend.listLinks(map.id));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  useEffect(() => {
    void run(async () => {});
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = () =>
    run(async () => {
      // A snapshot must capture what is on screen, so push pending edits first.
      await flush();
      await backend.createLink(map.id, {
        mode, label,
        visibleLayers: allLayers ? null : [...picked],
        expiresAt: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
      });
      setLabel('');
    });

  const copy = async (l: ShareLink) => {
    await navigator.clipboard.writeText(viewUrl(l.token));
    setCopied(l.id);
    setTimeout(() => setCopied(''), 1500);
  };

  const layerNames = (l: ShareLink) =>
    l.visible_layers === null ? 'All layers' : l.visible_layers.map((id) => layers.find((x) => x.id === id)?.name).filter(Boolean).join(', ') || 'No layers';

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Share map" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <header>
          <h2>Share "{map.name}"</h2>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </header>

        <>
            <div className="newlink">
              <div className="row2">
                <Field label="Label (only you see this)">
                  <input value={label} maxLength={120} placeholder="e.g. Blue team" onChange={(e) => setLabel(e.target.value)} />
                </Field>
                <Field label="Expires">
                  <select value={hours ?? ''} onChange={(e) => setHours(e.target.value ? +e.target.value : null)}>
                    {EXPIRY.map(([n, h]) => <option key={n} value={h ?? ''}>{n}</option>)}
                  </select>
                </Field>
              </div>
              <div className="seg">
                <button type="button" className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live: follows your edits</button>
                <button type="button" className={mode === 'snapshot' ? 'on' : ''} onClick={() => setMode('snapshot')}>Snapshot: frozen now</button>
              </div>
              <label className="check">
                <input type="checkbox" checked={allLayers} onChange={(e) => setAllLayers(e.target.checked)} />
                All layers, including ones added later
              </label>
              {!allLayers && (
                <div className="picks">
                  {[...layers].sort((a, b) => b.z - a.z).map((l) => (
                    <label key={l.id} className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(l.id)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(l.id);
                          else n.delete(l.id);
                          setPicked(n);
                        }}
                      />
                      {l.name}
                      {!l.visible && <em> (hidden in editor, so hidden from viewers)</em>}
                    </label>
                  ))}
                </div>
              )}
              <button type="button" className="btn primary" disabled={busy || (!allLayers && picked.size === 0)} onClick={() => void create()}>
                <Icon name="share" /> Create view-only link
              </button>
            </div>

            {error && <p className="note bad">{error}</p>}

            <h4>Links</h4>
            {links === null ? (
              <p className="empty">Loading…</p>
            ) : links.length === 0 ? (
              <p className="empty">No links yet. Nobody but you can see this map.</p>
            ) : (
              <ul className="links">
                {links.map((l) => {
                  const s = status(l);
                  return (
                    <li key={l.id} className={s.cls}>
                      <div>
                        <strong>{l.label || 'Untitled link'}</strong>
                        <span className="tag">{l.mode}</span>
                        <span className={`tag ${s.cls}`}>{s.text}</span>
                        <small>{layerNames(l)} · created {new Date(l.created_at).toLocaleString()}</small>
                      </div>
                      <button type="button" className="btn sm" onClick={() => void copy(l)}>
                        <Icon name="copy" size={14} /> {copied === l.id ? 'Copied' : 'Copy link'}
                      </button>
                      <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => backend.updateLink(l.id, { revoked: !l.revoked }).then(() => backend.ping(map)))}>
                        {l.revoked ? 'Restore' : 'Revoke'}
                      </button>
                      <IconButton icon="trash" title="Delete link permanently" danger onClick={() => confirm('Delete this link permanently?') && void run(() => backend.deleteLink(l.id).then(() => backend.ping(map)))} />
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="tip">Anyone with a link can view, never edit. Live links also get the turn slider, limited to the layers chosen for that link. Revoking or deleting a link locks out open viewer pages within seconds.</p>
        </>
      </div>
    </div>
  );
}
