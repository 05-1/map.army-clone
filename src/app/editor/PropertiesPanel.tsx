import { useEffect, useMemo, useRef } from 'react';
import { fmtLatLon } from '../lib/geo';
import { AFFILIATIONS, ECHELONS, isLetterSidc, MODIFIERS, setSidcChar } from '../lib/symbols';
import type { CombatAdmin, Dash, Feature, Pos, Props, Style } from '../lib/types';
import type { Backend } from './backend';
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

export function PropertiesPanel({ onAssign, backend, refreshCombat }: { onAssign?: (ids: string[], playerId: string | null) => void; backend?: Backend; refreshCombat?: () => Promise<void> }) {
  const features = useEd((s) => s.features);
  const selection = useEd((s) => s.selection);
  const layers = useEd((s) => s.layers);
  const assets = useEd((s) => s.assets);
  const players = useEd((s) => s.players);
  const techItems = useEd((s) => s.bundle?.economy.items);
  const combat = useEd((s) => s.combat);
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
      {techItems && techItems.length > 0 && sel.every((f) => f.kind === 'symbol' || f.kind === 'asset') && (
        <Field label="Tech type (pays income, may be a spawn point)" wide>
          <select value={common(sel, (f) => f.props.tech ?? '') ?? '__mixed'} onChange={(e) => (cp(), setP({ tech: e.target.value || undefined }))}>
            {common(sel, (f) => f.props.tech ?? '') === undefined && <option value="__mixed" disabled>Mixed</option>}
            <option value="">None</option>
            {techItems.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.income_spawn || t.income_research ? ` (+${t.income_spawn} spawn, +${t.income_research} research)` : ''}{t.spawn_radius_m ? ' · spawn point' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {combat && sel.every((f) => f.kind === 'symbol' || f.kind === 'asset') && (
        <CombatFields ids={ids} sel={sel} combat={combat} backend={backend} refresh={refreshCombat} setP={setP} cp={cp} />
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

/** Unit template, and for one unit its live combat state with owner overrides. */
function CombatFields(p: { ids: string[]; sel: Feature[]; combat: CombatAdmin; backend?: Backend; refresh?: () => Promise<void>; setP(p: Partial<Props>): void; cp(): void }) {
  const { sel, combat, backend, refresh } = p;
  const one = sel.length === 1 ? sel[0] : null;
  const live = one ? combat.units[one.id] : undefined;
  const tpl = combat.templates.find((t) => t.id === (one?.props.unit ?? live?.template));
  const value = common(sel, (f) => f.props.unit ?? '');
  const auto = one && !one.props.unit && live ? combat.templates.find((t) => t.id === live.template)?.name : undefined;
  const eng = one ? combat.engagements.find((e) => e.units.some((u) => u.fid === one.id)) : undefined;
  const save = async (patch: { strength?: number; experience?: number; stationary_turns?: number }) => {
    if (!one || !backend) return;
    try {
      await backend.setUnitState(one.id, patch);
      await refresh?.();
    } catch (e) {
      useEd.getState().say((e as Error).message);
    }
  };
  const n = (v: string) => Math.max(0, Math.round(+v) || 0);
  return (
    <>
      <Field label="Unit template (combat stats)" wide>
        <select value={value ?? '__mixed'} onChange={(e) => (p.cp(), p.setP({ unit: e.target.value || undefined }))}>
          {value === undefined && <option value="__mixed" disabled>Mixed</option>}
          <option value="">{auto ? `Automatic: ${auto}` : 'Automatic (tech item, or same symbol / graphic)'}</option>
          {combat.templates.filter((t) => !t.deleted_at || t.id === value).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.category})</option>)}
        </select>
      </Field>
      {one && live && tpl && (
        <div className="row2 wrap">
          <Field label={`Strength (max ${tpl.max_strength})`}>
            <input type="number" min={0} max={tpl.max_strength} key={`s${live.strength}`} defaultValue={Math.round(live.strength ?? tpl.max_strength)}
              onBlur={(e) => n(e.target.value) !== Math.round(live.strength ?? tpl.max_strength) && void save({ strength: n(e.target.value) })} />
          </Field>
          <Field label="Experience">
            <input type="number" min={0} key={`x${live.experience}`} defaultValue={live.experience ?? 0} onBlur={(e) => n(e.target.value) !== (live.experience ?? 0) && void save({ experience: n(e.target.value) })} />
          </Field>
          <Field label="Stationary turns">
            <input type="number" min={0} key={`t${live.stationary_turns}`} defaultValue={live.stationary_turns ?? 0} onBlur={(e) => n(e.target.value) !== (live.stationary_turns ?? 0) && void save({ stationary_turns: n(e.target.value) })} />
          </Field>
          {eng && (
            <button type="button" className="btn sm danger" onClick={() => confirm('End the engagement this unit is in?') && backend && void backend.endEngagement(eng.id).then(() => refresh?.(), (e) => useEd.getState().say((e as Error).message))}>
              End its engagement
            </button>
          )}
        </div>
      )}
      {one && !live && value && <p className="tip">Combat state appears once the unit is saved.</p>}
    </>
  );
}
