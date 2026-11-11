import { useMemo, useRef, useState } from 'react';
import { symbolDataUrl, symbolIsValid } from '../lib/images';
import { AFFILIATIONS, buildSidc, CATALOG, ECHELONS, MODIFIERS, type SymbolDraft } from '../lib/symbols';
import { prepareUpload } from '../lib/upload';
import type { Backend } from './backend';
import { useEd } from './store';
import { Field, Icon, IconButton, Section } from './ui';

export function SymbolPalette() {
  const d = useEd((s) => s.symbolDraft);
  const tool = useEd((s) => s.tool);
  const set = (p: Partial<SymbolDraft>) => useEd.setState({ symbolDraft: { ...d, ...p }, tool: 'symbol' });
  const land = d.dim === 'G' || d.dim === 'F';
  const sidc = buildSidc(d);
  const rawBad = !!d.raw.trim() && !symbolIsValid(sidc);

  const grid = useMemo(
    () =>
      CATALOG.map((g) => ({
        group: g.group,
        items: g.items.map((it) => ({ ...it, url: symbolDataUrl(buildSidc({ ...d, raw: '', dim: it.dim, fn: it.fn, mod: '-', ech: '-' }), 22) })),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.aff, d.status],
  );

  return (
    <Section title="NATO symbols">
      <div className="seg">
        {AFFILIATIONS.map((a) => (
          <button key={a.code} type="button" className={d.aff === a.code ? 'on' : ''} style={{ ['--chip' as string]: a.color }} onClick={() => set({ aff: a.code })}>
            <i />
            {a.label}
          </button>
        ))}
      </div>
      <div className="row2">
        <Field label="Echelon">
          <select value={d.ech} disabled={!land} onChange={(e) => set({ ech: e.target.value })}>
            {ECHELONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </Field>
        <Field label="Modifier">
          <select value={d.mod} disabled={!land} onChange={(e) => set({ mod: e.target.value })}>
            {MODIFIERS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={d.status === 'A'} onChange={(e) => set({ status: e.target.checked ? 'A' : 'P' })} />
        Planned / anticipated (dashed frame)
      </label>
      {grid.map((g) => (
        <div key={g.group}>
          <h4>{g.group}</h4>
          <div className="symgrid">
            {g.items.map((it) => (
              <button
                key={it.dim + it.fn}
                type="button"
                title={it.name}
                className={tool === 'symbol' && !d.raw && d.dim === it.dim && d.fn === it.fn ? 'on' : ''}
                onClick={() => set({ dim: it.dim, fn: it.fn, raw: '' })}
              >
                <img src={it.url} alt={it.name} />
              </button>
            ))}
          </div>
        </div>
      ))}
      <Field label="Or enter any SIDC (2525C letters or 2525D / APP-6D digits)" wide>
        <input className={rawBad ? 'bad' : ''} value={d.raw} placeholder="e.g. SHGPUCFRMS----- or 10031000001211000000" spellCheck={false} onChange={(e) => set({ raw: e.target.value })} />
      </Field>
      <div className="preview">
        <img src={symbolDataUrl(sidc, 30)} alt="Symbol preview" />
        <code>{sidc}</code>
      </div>
      <p className="tip">Pick a symbol, then click the map to place it. Esc returns to select.</p>
    </Section>
  );
}

export function AssetLibrary({ backend }: { backend: Backend }) {
  const assets = useEd((s) => s.assets);
  const d = useEd((s) => s.assetDraft);
  const tool = useEd((s) => s.tool);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const setDraft = (p: Partial<typeof d>) => useEd.setState({ assetDraft: { ...d, ...p } });

  async function upload(files: FileList | File[]) {
    setBusy(true);
    for (const file of Array.from(files)) {
      try {
        const asset = await backend.uploadAsset(await prepareUpload(file));
        useEd.setState((s) => ({ assets: [asset, ...s.assets], assetDraft: { ...s.assetDraft, assetId: asset.id }, tool: 'asset' }));
      } catch (e) {
        useEd.getState().say(`${file.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
  }

  async function remove(id: string) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    const used = useEd.getState().features.filter((f) => f.asset_id === id).length;
    if (!confirm(`Remove "${a.name}" from the library? ${used ? `It stays on the map where it is already placed (${used}×) and in old turns. ` : ''}You can restore it later.`)) return;
    try {
      const row = await backend.setAssetDeleted(id, true);
      useEd.setState((s) => ({ assets: s.assets.map((x) => (x.id === id ? { ...x, ...row } : x)), assetDraft: { ...s.assetDraft, assetId: s.assetDraft.assetId === id ? null : s.assetDraft.assetId } }));
    } catch (e) {
      useEd.getState().say((e as Error).message);
    }
  }

  const shown = assets.filter((a) => !a.deleted_at);
  const removed = assets.filter((a) => a.deleted_at);

  return (
    <Section title="Graphics library">
      <div
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files);
        }}
      >
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="upload" /> {busy ? 'Uploading…' : 'Upload graphics'}
        </button>
        <small>PNG, WebP or SVG, up to 2 MB. Drop files here.</small>
        <input ref={input} type="file" hidden multiple accept=".png,.webp,.svg,image/png,image/webp,image/svg+xml" onChange={(e) => (e.target.files && void upload(e.target.files), (e.target.value = ''))} />
      </div>
      {shown.length === 0 ? (
        <p className="empty">No graphics yet. Top-down silhouettes with a transparent background work best: nose or bow pointing up.</p>
      ) : (
        <div className="assetgrid">
          {shown.map((a) => (
            <div key={a.id} className={`tile${tool === 'asset' && d.assetId === a.id ? ' on' : ''}`}>
              <button type="button" title={a.name} onClick={() => useEd.setState({ assetDraft: { ...d, assetId: a.id }, tool: 'asset' })}>
                <img src={backend.assetUrl(a)} alt={a.name} loading="lazy" />
                <span>{a.name}</span>
              </button>
              <IconButton icon="x" title="Remove from library (can be restored)" danger onClick={() => void remove(a.id)} />
            </div>
          ))}
        </div>
      )}
      {removed.length > 0 && (
        <details className="removed">
          <summary>Removed graphics ({removed.length})</summary>
          {removed.map((a) => (
            <div key={a.id} className="row2">
              <img className="mini" src={backend.assetUrl(a)} alt="" /> <span>{a.name}</span>
              <button type="button" className="btn sm" onClick={() => void backend.setAssetDeleted(a.id, false).then((row) => useEd.setState((s) => ({ assets: s.assets.map((x) => (x.id === a.id ? { ...x, ...row } : x)) })), (e) => useEd.getState().say((e as Error).message))}>Restore</button>
            </div>
          ))}
        </details>
      )}
      <h4>Size for new placements</h4>
      <div className="seg">
        <button type="button" className={d.sizeMode === 'px' ? 'on' : ''} onClick={() => setDraft({ sizeMode: 'px' })}>Fixed pixels</button>
        <button type="button" className={d.sizeMode === 'm' ? 'on' : ''} onClick={() => setDraft({ sizeMode: 'm' })}>True scale</button>
      </div>
      {d.sizeMode === 'px' ? (
        <Field label="Long side (px)">
          <input type="number" min={8} max={512} value={d.sizePx} onChange={(e) => setDraft({ sizePx: clamp(+e.target.value, 8, 512) })} />
        </Field>
      ) : (
        <Field label="Real length of long side (m)">
          <input type="number" min={1} max={100000} value={d.sizeM} onChange={(e) => setDraft({ sizeM: clamp(+e.target.value, 1, 100000) })} />
        </Field>
      )}
      <p className="tip">True scale draws the graphic at its real ground size, e.g. 333 m for a Nimitz-class carrier. It shrinks to nothing as you zoom out.</p>
    </Section>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
