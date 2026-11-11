import { useEffect, useMemo, useRef } from 'react';
import { fmtLatLon } from '../lib/geo';
import { AFFILIATIONS, ECHELONS, isLetterSidc, MODIFIERS, setSidcChar } from '../lib/symbols';
import type { Dash, Feature, Pos, Props, Style } from '../lib/types';
import { useEd } from './store';
import { ColorPicker, Field, IconButton, Section } from './ui';

const SHAPES = new Set(['line', 'arrow', 'polygon', 'circle', 'freehand']);
const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));

const toLocalInput = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  return new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/** Shared value across the selection, or undefined when they differ. */
function common<T>(fs: Feature[], get: (f: Feature) => T): T | undefined {
  const v = get(fs[0]);
  return fs.every((f) => get(f) === v) ? v : undefined;
}

export function StylePanel() {
  const style = useEd((s) => s.style);
  const tool = useEd((s) => s.tool);
  const set = (p: Partial<Style>) => useEd.setState({ style: { ...style, ...p } });
  return (
    <Section title="Style for new drawings">
      <StyleFields style={style} set={set} fill={tool === 'polygon' || tool === 'circle'} stroke={tool !== 'text'} />
      <p className="tip">
        {tool === 'freehand' ? 'Press and drag to draw.' : tool === 'text' ? 'Click the map to place text.' : tool === 'circle' ? 'Click the centre, then click again to set the radius.' : 'Click to add points. Double-click or Enter to finish, Backspace removes the last point.'}
      </p>
    </Section>
  );
}

function StyleFields(p: { style: Partial<Style>; set: (s: Partial<Style>) => void; onFocus?: () => void; fill: boolean; stroke: boolean }) {
  const { style, set, onFocus } = p;
  return (
    <>
      <Field label="Color" wide>
        <ColorPicker value={style.color ?? ''} onChange={(color) => set({ color })} onFocus={onFocus} />
      </Field>
      {p.stroke && (
        <div className="row2">
          <Field label={`Width ${style.width ?? '–'}`}>
            <input type="range" min={1} max={16} step={1} value={style.width ?? 3} onPointerDown={onFocus} onChange={(e) => set({ width: +e.target.value })} />
          </Field>
          <Field label="Line">
            <select value={style.dash ?? ''} onFocus={onFocus} onChange={(e) => set({ dash: e.target.value as Dash })}>
              {style.dash === undefined && <option value="">Mixed</option>}
              <option value="solid">Solid</option>
              <option value="dash">Dashed</option>
              <option value="dot">Dotted</option>
            </select>
          </Field>
        </div>
      )}
      {p.fill && (
        <Field label={`Fill opacity ${Math.round((style.fillOpacity ?? 0) * 100)}%`} wide>
          <input type="range" min={0} max={1} step={0.05} value={style.fillOpacity ?? 0} onPointerDown={onFocus} onChange={(e) => set({ fillOpacity: +e.target.value })} />
        </Field>
      )}
    </>
  );
}

export function PropertiesPanel({ onAssign }: { onAssign?: (ids: string[], playerId: string | null) => void }) {
  const features = useEd((s) => s.features);
  const selection = useEd((s) => s.selection);
  const layers = useEd((s) => s.layers);
  const assets = useEd((s) => s.assets);
  const players = useEd((s) => s.players);
  const nameRef = useRef<HTMLTextAreaElement>(null);
  const st = useEd.getState;

  const sel = useMemo(() => {
    const s = new Set(selection);
    return features.filter((f) => s.has(f.id));
  }, [features, selection]);

  useEffect(() => {
    const focus = () => setTimeout(() => (nameRef.current?.focus(), nameRef.current?.select()), 30);
    window.addEventListener('tacmap:focus-name', focus);
    return () => window.removeEventListener('tacmap:focus-name', focus);
  }, []);

  if (!sel.length) return null;
  const ids = sel.map((f) => f.id);
  const one = sel.length === 1 ? sel[0] : null;
  const kind = common(sel, (f) => f.kind);
  const cp = () => st().checkpoint();
  const setP = (p: Partial<Props>) => st().patch(ids, (f) => ({ ...f, props: { ...f.props, ...p } }));
  const setS = (p: Partial<Style>) => st().patch(ids, (f) => ({ ...f, style: { ...f.style, ...p } }));
  const val = <K extends keyof Props>(k: K) => common(sel, (f) => f.props[k]);
  const text = (k: 'name' | 'type' | 'speed' | 'notes') => ({
    value: (val(k) as string | undefined) ?? '',
    placeholder: val(k) === undefined && sel.length > 1 ? 'Mixed' : '',
    onFocus: cp,
    onChange: (e: { target: { value: string } }) => setP({ [k]: e.target.value }),
  });

  const allShapes = sel.every((f) => SHAPES.has(f.kind));
  const hasHeading = sel.every((f) => f.geometry.type === 'Point' && f.kind !== 'circle');
  const sidc = kind === 'symbol' ? val('sidc') : undefined;
  const asset = one?.kind === 'asset' ? assets.find((a) => a.id === one.asset_id) : null;
  const sizeMode = val('sizeMode') ?? 'px';

  const layerSelect = (
    <select
      value={common(sel, (f) => f.layer_id) ?? ''}
      onChange={(e) => {
        cp();
        st().patch(ids, (f) => ({ ...f, layer_id: e.target.value }));
      }}
    >
      {common(sel, (f) => f.layer_id) === undefined && <option value="">Mixed</option>}
      {[...layers].sort((a, b) => b.z - a.z).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  );

  return (
    <Section
      title={one ? titleOf(one) : `${sel.length} objects`}
      action={
        <span className="acts">
          <IconButton icon="up" title="Bring to front  ]" onClick={() => st().reorder(ids, 'front')} />
          <IconButton icon="down" title="Send to back  [" onClick={() => st().reorder(ids, 'back')} />
          <IconButton icon="trash" title="Delete  Del" danger onClick={() => st().remove(ids)} />
        </span>
      }
    >
      <Field label={kind === 'text' ? 'Text' : 'Name / label'} wide>
        <textarea ref={nameRef} rows={kind === 'text' ? 3 : 1} maxLength={400} {...text('name')} />
      </Field>
      <div className="row2">
        <Field label="Type">
          <input maxLength={80} {...text('type')} />
        </Field>
        <Field label="Speed">
          <input maxLength={40} {...text('speed')} />
        </Field>
      </div>
      {hasHeading && (
        <div className="row2">
          <Field label="Heading (°)">
            <input
              type="number" min={0} max={359} value={val('heading') ?? ''} placeholder={kind === 'symbol' ? 'none' : ''} onFocus={cp}
              onChange={(e) => setP({ heading: e.target.value === '' ? undefined : num(e.target.value, 0, 359) })}
            />
          </Field>
          <Field label="Layer">
            {layerSelect}
          </Field>
        </div>
      )}
      {!hasHeading && (
        <Field label="Layer" wide>
          {layerSelect}
        </Field>
      )}
      {players.length > 0 && (
        <Field label="Assigned to (this player moves it and gives it orders)" wide>
          <select
            value={common(sel, (f) => f.owner_player_id ?? '') ?? '__mixed'}
            onChange={(e) => onAssign?.(ids, e.target.value || null)}
          >
            {common(sel, (f) => f.owner_player_id ?? '') === undefined && <option value="__mixed" disabled>Mixed</option>}
            <option value="">Nobody (owner only)</option>
            {players.map((p) => <option key={p.id} value={p.id}>{p.name}{p.team ? ` · ${p.team}` : ''}{p.revoked ? ' (revoked)' : ''}</option>)}
          </select>
        </Field>
      )}
      <Field label="Time" wide>
        <span className="inline">
          <input type="datetime-local" value={toLocalInput(val('timestamp'))} onFocus={cp} onChange={(e) => setP({ timestamp: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
          <button type="button" className="btn sm" onClick={() => (cp(), setP({ timestamp: new Date().toISOString() }))}>Now</button>
        </span>
      </Field>
      <Field label="Notes (visible to viewers)" wide>
        <textarea rows={3} maxLength={4000} {...text('notes')} />
      </Field>

      {kind === 'symbol' && (
        <>
          <h4>Symbol</h4>
          {sidc && isLetterSidc(sidc) && (
            <>
              <div className="seg">
                {AFFILIATIONS.map((a) => (
                  <button key={a.code} type="button" className={sidc[1]?.toUpperCase() === a.code ? 'on' : ''} style={{ ['--chip' as string]: a.color }} onClick={() => (cp(), setP({ sidc: setSidcChar(sidc, 1, a.code) }))}>
                    <i />
                    {a.label}
                  </button>
                ))}
              </div>
              <div className="row2">
                <Field label="Echelon">
                  <select value={sidc[11] ?? '-'} onFocus={cp} onChange={(e) => setP({ sidc: setSidcChar(sidc, 11, e.target.value) })}>
                    {ECHELONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                  </select>
                </Field>
                <Field label="Modifier">
                  <select value={sidc[10] ?? '-'} onFocus={cp} onChange={(e) => setP({ sidc: setSidcChar(sidc, 10, e.target.value) })}>
                    {MODIFIERS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                  </select>
                </Field>
              </div>
            </>
          )}
          <div className="row2">
            <Field label="SIDC">
              <input value={sidc ?? ''} placeholder="Mixed" spellCheck={false} onFocus={cp} onChange={(e) => setP({ sidc: e.target.value.toUpperCase().trim() })} />
            </Field>
            <Field label="Size">
              <input type="number" min={12} max={120} value={val('sizePx') ?? 34} onFocus={cp} onChange={(e) => setP({ sizePx: num(e.target.value, 12, 120) })} />
            </Field>
          </div>
        </>
      )}

      {kind === 'asset' && (
        <>
          <h4>Graphic{asset ? `: ${asset.name}` : ''}</h4>
          <div className="seg">
            <button type="button" className={sizeMode === 'px' ? 'on' : ''} onClick={() => (cp(), setP({ sizeMode: 'px' }))}>Fixed pixels</button>
            <button type="button" className={sizeMode === 'm' ? 'on' : ''} onClick={() => (cp(), setP({ sizeMode: 'm' }))}>True scale</button>
          </div>
          {sizeMode === 'px' ? (
            <Field label="Long side (px)" wide>
              <input type="number" min={8} max={512} value={val('sizePx') ?? 64} onFocus={cp} onChange={(e) => setP({ sizePx: num(e.target.value, 8, 512) })} />
            </Field>
          ) : (
            <Field label="Real length of long side (m)" wide>
              <input type="number" min={1} max={100000} value={val('sizeM') ?? 100} onFocus={cp} onChange={(e) => setP({ sizeM: num(e.target.value, 1, 100000) })} />
            </Field>
          )}
          <Field label="Tint (flat recolor, keeps transparency)" wide>
            <span className="inline">
              <ColorPicker value={val('tint') ?? ''} onFocus={cp} onChange={(tint) => setP({ tint })} />
              <button type="button" className="btn sm" disabled={!val('tint')} onClick={() => (cp(), setP({ tint: null }))}>Clear</button>
            </span>
          </Field>
          <label className="check">
            <input type="checkbox" checked={val('showLabel') !== false} onChange={(e) => (cp(), setP({ showLabel: e.target.checked }))} />
            Show name under the graphic
          </label>
        </>
      )}

      {kind === 'text' && (
        <>
          <h4>Text</h4>
          <Field label="Size (px)" wide>
            <input type="number" min={8} max={96} value={val('fontSize') ?? 18} onFocus={cp} onChange={(e) => setP({ fontSize: num(e.target.value, 8, 96) })} />
          </Field>
          <StyleFields style={{ color: common(sel, (f) => f.style.color) }} set={setS} onFocus={cp} fill={false} stroke={false} />
        </>
      )}

      {kind === 'circle' && (
        <Field label="Radius (m)" wide>
          <input type="number" min={1} max={20000000} value={val('radius') ?? 1000} onFocus={cp} onChange={(e) => setP({ radius: num(e.target.value, 1, 20000000) })} />
        </Field>
      )}

      {allShapes && (
        <>
          <h4>Style</h4>
          <StyleFields
            style={{
              color: common(sel, (f) => f.style.color), width: common(sel, (f) => f.style.width),
              dash: common(sel, (f) => f.style.dash), fillOpacity: common(sel, (f) => f.style.fillOpacity),
            }}
            set={setS}
            onFocus={cp}
            fill={sel.every((f) => f.kind === 'polygon' || f.kind === 'circle')}
            stroke
          />
        </>
      )}

      {one?.geometry.type === 'Point' && <p className="coords">{fmtLatLon(one.geometry.coordinates as Pos)}</p>}
    </Section>
  );
}

function titleOf(f: Feature) {
  return { symbol: 'Unit', asset: 'Graphic', text: 'Text', line: 'Line', arrow: 'Arrow', polygon: 'Polygon', circle: 'Circle', freehand: 'Freehand' }[f.kind];
}
