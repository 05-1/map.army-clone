// Player page. A separate entry point: this bundle imports nothing from src/editor and contains no
// code that writes to the map. A player edits one draft per turn; the owner's push is what changes the map.
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Map as MlMap } from 'maplibre-gl';
import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { asBasemap, BASEMAP_IDS, BASEMAPS, setBasemap } from '../lib/basemaps';
import { fmtDist, fmtLatLon } from '../lib/geo';
import { symbolDataUrl } from '../lib/images';
import { createMap } from '../lib/mapview';
import { cleanHeading, describeChange, dropPart, fmtWhen, MAX_ORDER_LEN, summarize } from '../lib/submissions';
import { publicAssetUrl } from '../lib/supabase';
import { costText, fmtPts, isUnlocked, techStatus, usable, whereText, withoutResearch } from '../lib/tech';
import { TechTree } from '../lib/TechTree';
import { Measure, type MeasureState } from '../lib/measure';
import { MEASURE_IDLE, MeasurePanel } from '../lib/MeasurePanel';
import { ExportDialog } from '../lib/ExportDialog';
import { attributionText } from '../lib/exportmap';
import { TurnSlider, turnLabel } from '../lib/TurnSlider';
import type { BasemapId, Feature, PlayerAllocation, Pos, TechItem, Zone } from '../lib/types';
import '../styles.css';
import { announceDraft, closeChannel, fetchHistory, fetchState, fetchTerrain, join, openChannel, sb, setReady, type JoinResult } from './client';
import { setTerrain } from '../lib/terrainLayer';
import { TerrainLegend } from '../lib/TerrainLegend';
import { PlayController } from './controller';
import { AirBox, AirReportPart } from './AirPanel';
import { effective, pointsLeft, remaining, usePlay, type PTool } from './store';

const POLL_MS = 60_000;
const DRAW_TOOLS: [PTool, string][] = [['select', 'Select / move'], ['arrow', 'Arrow'], ['line', 'Line'], ['polygon', 'Area'], ['text', 'Note']];
const KIND: Record<Feature['kind'], string> = {
  symbol: 'Unit', asset: 'Unit', text: 'Text', line: 'Line', arrow: 'Arrow', polygon: 'Area', circle: 'Range ring', freehand: 'Sketch',
};
const zoneText = (z: Zone) => (!z ? 'place anywhere' : 'center' in z ? `within ${fmtDist(z.radius_m)} of a point` : 'inside the marked area');

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="splash">
      <div className="login">
        <div className="brand">TACMAP</div>
        <h2>{title}</h2>
        <p className="note">{body}</p>
        {children}
      </div>
    </div>
  );
}

type Phase = { s: 'joining' } | { s: 'pin'; msg: string } | { s: 'error'; msg: string } | { s: 'gone' } | { s: 'ok' };

function Game({ token }: { token: string }) {
  const el = useRef<HTMLDivElement>(null);
  const coordEl = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const [phase, setPhase] = useState<Phase>({ s: 'joining' });
  const [pin, setPin] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [online, setOnline] = useState(false);
  const [basemap, setBase] = useState<BasemapId>('satellite');
  const [treeOpen, setTreeOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [terrainOn, setTerrainOn] = useState(false);
  const [terrainEmpty, setTerrainEmpty] = useState(false);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !playerId) return;
    if (!terrainOn) return void setTerrain(m, null);
    fetchTerrain(playerId).then((fc) => {
      if (fc) setTerrain(m, fc);
      setTerrainEmpty(!fc?.features.length);
    }, (e) => usePlay.getState().say((e as Error).message));
  }, [terrainOn, playerId]);
  const [exporting, setExporting] = useState(false);
  const measureRef = useRef<Measure | null>(null);
  const [measured, setMeasured] = useState<MeasureState>(MEASURE_IDLE);
  const tool = usePlay((s) => s.tool);
  const state = usePlay((s) => s.state);
  const hint = usePlay((s) => s.hint);
  const viewing = usePlay((s) => s.viewing);

  /** Bind this browser to the invite. The server answers with what is missing (a PIN) instead of failing. */
  const attempt = (withPin: string | null) => {
    setPhase({ s: 'joining' });
    join(token, withPin).then(
      (r: JoinResult) => {
        if (r.ok) return setPlayerId(r.player_id);
        if (r.reason === 'invalid') return setPhase({ s: 'error', msg: 'This invite is not valid. It may have been revoked or replaced. Ask the map owner for a new link.' });
        if (r.reason === 'locked') return setPhase({ s: 'pin', msg: `Too many wrong PINs. This seat is locked until ${new Date(r.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. The map owner can unlock it sooner.` });
        setPhase({ s: 'pin', msg: r.reason === 'wrong_pin' ? `Wrong PIN. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.` : '' });
      },
      (e) => setPhase({ s: 'error', msg: (e as Error).message }),
    );
  };
  useEffect(() => {
    attempt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!playerId) return;
    let dead = false;
    let controller: PlayController | null = null;
    let timer = 0;
    let debounce = 0;

    const stop = () => {
      clearInterval(timer);
      clearTimeout(debounce);
      closeChannel(channel.current);
      channel.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
    const refresh = async () => {
      try {
        const next = await fetchState(playerId);
        if (dead) return;
        if (!next) {
          // Revoked, link regenerated, or the seat was opened on another device: clear the screen.
          stop();
          controller?.destroy();
          mapRef.current?.remove();
          mapRef.current = null;
          setPhase({ s: 'gone' });
          return;
        }
        usePlay.getState().refresh(next);
      } catch {
        /* transient: keep the last good state, the next ping or poll retries */
      }
    };
    refreshRef.current = refresh;
    const refreshSoon = () => {
      clearTimeout(debounce);
      debounce = window.setTimeout(refresh, 250);
    };
    function onVisible() {
      if (!document.hidden) refreshSoon();
    }

    (async () => {
      const first = await fetchState(playerId);
      if (dead) return;
      if (!first) return setPhase({ s: 'gone' });
      usePlay.getState().init(playerId, first);
      usePlay.setState({ onSaved: () => announceDraft(channel.current) });
      setBase(asBasemap(first.map.basemap));
      setPhase({ s: 'ok' });
      document.title = `${first.map.name} · ${first.player.name} · Tacmap`;

      const map = createMap(el.current!, first.map);
      mapRef.current = map;
      map.on('mousemove', (e) => {
        if (coordEl.current) coordEl.current.textContent = fmtLatLon([e.lngLat.lng, e.lngLat.lat]);
      });
      map.once('load', () => {
        if (dead) return;
        controller = new PlayController(map);
        const m = new Measure(map, setMeasured);
        measureRef.current = m;
        m.setActive(usePlay.getState().tool === 'measure');
        const unsub = usePlay.subscribe((s, p) => s.tool !== p.tool && m.setActive(s.tool === 'measure'));
        const prev = controller.destroy.bind(controller);
        controller.destroy = () => (unsub(), m.destroy(), prev());
      });

      channel.current = openChannel(first.channel, refreshSoon, (ok) => {
        if (dead) return;
        setOnline(ok);
        if (ok) refreshSoon(); // catch up after a reconnect
      });
      timer = window.setInterval(refresh, POLL_MS);
      document.addEventListener('visibilitychange', onVisible);
    })().catch((e) => !dead && setPhase({ s: 'error', msg: (e as Error).message }));

    return () => {
      dead = true;
      stop();
      controller?.destroy();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [playerId]);

  const pickTurn = async (n: number | null) => {
    if (n === null) return usePlay.setState({ viewing: null, sel: null });
    try {
      const snap = await fetchHistory(playerId, n);
      if (snap) usePlay.setState({ viewing: snap, sel: null, tool: 'select', allocId: null });
    } catch (e) {
      usePlay.getState().say((e as Error).message);
    }
  };

  if (phase.s === 'gone') {
    return (
      <Message title="This seat is in use elsewhere" body="The invite was opened on another device, or the map owner revoked or replaced it. Your link works on one device at a time.">
        <button type="button" className="btn primary" onClick={() => location.reload()}>Use it on this device</button>
      </Message>
    );
  }
  if (phase.s === 'error') return <Message title="Could not join the map" body={phase.msg} />;
  if (phase.s === 'pin') {
    const submit = (e: FormEvent) => (e.preventDefault(), attempt(pin), setPin(''));
    return (
      <Message title="Enter your PIN" body="This seat is protected by a 4-digit PIN from the map owner. You only need it once on each device.">
        <form onSubmit={submit}>
          <label className="field wide">
            <span>PIN</span>
            <input autoFocus inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </label>
          {phase.msg && <p className="note bad" role="alert">{phase.msg}</p>}
          <button className="btn primary" disabled={pin.length !== 4}>Join</button>
        </form>
      </Message>
    );
  }

  const turn = state?.turn ?? null;
  return (
    <div className="viewer play">
      <div ref={el} className="map" />
      {phase.s === 'joining' && <div className="splash over">Joining…</div>}
      {phase.s === 'ok' && state && (
        <>
          <div className="vbar">
            <strong>{state.map.name}</strong>
            <span className="pill who"><i className="chip" style={{ background: state.player.color ?? '#8794a4' }} aria-hidden /> {state.player.name}{state.player.team ? ` · ${state.player.team}` : ''}</span>
            <span className={`pill ${online ? 'saved' : 'dirty'}`}>{online ? 'Live' : 'Reconnecting…'}</span>
            <span className={`pill ${turn && !turn.frozen ? 'saved' : 'dirty'}`}>
              {!turn ? 'No turn open' : turn.status === 'locked' ? `Turn ${turn.number} · locked for review` : turn.frozen ? `Turn ${turn.number} · deadline passed` : `Turn ${turn.number}${turn.deadline ? ` · due ${fmtWhen(turn.deadline)}` : ''}`}
            </span>
            <span className="grow" />
            <button type="button" className={`btn sm${tool === 'measure' ? ' on' : ''}`} aria-pressed={tool === 'measure'} onClick={() => usePlay.getState().setTool(tool === 'measure' ? 'select' : 'measure')}>Measure</button>
            <button type="button" className="btn sm" onClick={() => setExporting(true)}>Export</button>
            <button type="button" className={`btn sm${terrainOn ? ' on' : ''}`} aria-pressed={terrainOn} onClick={() => setTerrainOn(!terrainOn)}>Terrain</button>
            <div className="seg compact" role="group" aria-label="Basemap">
              {BASEMAP_IDS.map((id) => (
                <button key={id} type="button" className={basemap === id ? 'on' : ''} onClick={() => (setBase(id), mapRef.current && setBasemap(mapRef.current, id))}>
                  {BASEMAPS[id].label}
                </button>
              ))}
            </div>
          </div>
          {viewing ? (
            <div className="banner" role="status">Viewing {turnLabel({ number: viewing.viewing, label: null, at: '' }).toLowerCase()}. Read-only.</div>
          ) : (
            panelOpen ? (
              <aside className="ppanel left" aria-label="Your turn">
                <button type="button" className="btn sm panelhide" onClick={() => setPanelOpen(false)} title="Hide this panel to see more of the map">Hide ▾</button>
                <TurnBox refresh={() => refreshRef.current()} announce={() => announceDraft(channel.current)} />
                <TechBox openTree={() => setTreeOpen(true)} />
                <Tools />
                <AirBox refresh={() => refreshRef.current()} />
                <DraftList />
                <LastTurn />
                <CombatReportBox />
              </aside>
            ) : (
              <button type="button" className="btn panelshow" onClick={() => setPanelOpen(true)}>Orders ▴</button>
            )
          )}
          <Details />
          {treeOpen && <TechModal onClose={() => setTreeOpen(false)} />}
          {tool === 'measure' && <div className="measurebox right"><MeasurePanel m={measureRef.current} s={measured} onClose={() => usePlay.getState().setTool('select')} /></div>}
          {terrainOn && <TerrainLegend empty={terrainEmpty} />}
          {exporting && (
            <ExportDialog
              map={mapRef.current} title={`${state.map.name} · ${state.player.name}`} attribution={attributionText(BASEMAPS[basemap].attribution)}
              subtitle={`${viewing ? `Turn ${viewing.viewing}` : turn ? `Turn ${turn.number}, with my draft` : 'Live map'} · ${new Date().toLocaleDateString()}`}
              prepare={() => usePlay.setState({ sel: null })} onClose={() => setExporting(false)}
            />
          )}
          {hint && <div className="toast" role="status">{hint}</div>}
          <div className="vfoot mono">
            <span ref={coordEl}>–</span>
            <TurnSlider history={state.history} viewing={viewing?.viewing ?? null} current={turn?.number} rollbackOf={turn?.rollback_of} onPick={(n) => void pickTurn(n)} />
          </div>
        </>
      )}
    </div>
  );
}

function TurnBox({ refresh, announce }: { refresh: () => Promise<void>; announce: () => void }) {
  const state = usePlay((s) => s.state!);
  const saveStatus = usePlay((s) => s.saveStatus);
  const saveError = usePlay((s) => s.saveError);
  const savedAt = usePlay((s) => s.savedAt);
  const draft = usePlay((s) => s.draft);
  const [busy, setBusy] = useState(false);
  const turn = state.turn;
  const ready = state.draft?.ready ?? false;

  if (!turn) {
    return <section className="section"><header><h3>Waiting for the next turn</h3></header><p className="empty">The map owner has not opened a turn yet. This page updates by itself when they do.</p></section>;
  }
  const toggle = async () => {
    setBusy(true);
    try {
      await usePlay.getState().flush();
      await setReady(state.player.id, !ready);
      announce();
      await refresh();
    } catch (e) {
      usePlay.getState().say((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <section className="section">
      <header><h3>Turn {turn.number}{turn.rollback_of != null ? ` (replay from turn ${turn.rollback_of})` : ''}</h3></header>
      <p className="tip">
        {turn.status === 'locked'
          ? 'The owner is reviewing all drafts. Yours is frozen until the turn is pushed.'
          : turn.frozen
            ? 'The deadline has passed, so your draft can no longer change. You can still mark it ready or not.'
            : 'Move your units, research, buy and place units, and give orders. Everything saves by itself. Nobody else sees your draft until the owner pushes the turn.'}
      </p>
      {saveStatus === 'error' ? (
        <p className="note bad" role="alert">
          Not saved: {saveError} <button type="button" className="btn sm" onClick={() => void usePlay.getState().flush()}>Try again</button>
        </p>
      ) : (
        <p className="savestate">{saveStatus === 'saved' ? (savedAt ? `Draft saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Nothing drafted yet') : 'Saving…'}</p>
      )}
      <button type="button" className={`btn ${ready ? '' : 'primary'}`} disabled={busy || turn.status === 'locked' || saveStatus === 'error'} onClick={() => void toggle()}>
        {ready ? '✓ Ready. Click to un-ready' : draft.length ? 'Mark my draft ready' : 'Ready (no changes this turn)'}
      </button>
    </section>
  );
}

function AllocIcon({ a }: { a: PlayerAllocation }) {
  const asset = usePlay((s) => s.state!.allocation_assets.find((x) => x.id === a.asset_id));
  return <img className="mini" src={asset ? publicAssetUrl(asset.path) : symbolDataUrl(a.sidc ?? '', 20)} alt="" />;
}

function Tools() {
  const tool = usePlay((s) => s.tool);
  const drawing = usePlay((s) => s.drawing);
  const allocId = usePlay((s) => s.allocId);
  const state = usePlay((s) => s.state!);
  const draft = usePlay((s) => s.draft);
  const editable = !!state.turn && !state.turn.frozen;
  if (!editable) return null;
  const assetName = (a: PlayerAllocation) => a.props.name || state.allocation_assets.find((x) => x.id === a.asset_id)?.name || 'Unit';

  return (
    <section className="section">
      <div className="ptools" role="toolbar" aria-label="Tools">
        {DRAW_TOOLS.map(([t, label]) => (
          <button key={t} type="button" className={`btn sm${tool === t ? ' on' : ''}`} aria-pressed={tool === t} onClick={() => usePlay.getState().setTool(t)}>{label}</button>
        ))}
      </div>
      {tool === 'select' && <p className="tip">Your units have a ring in your colour and a dashed circle showing how far they can go this turn. Drag one (with the mouse or a finger) to move it, or click or tap it to turn it or give it an order.</p>}
      {(tool === 'arrow' || tool === 'line' || tool === 'polygon') && (
        <>
          <p className="tip">Click or tap to add points. Double-click, Enter or Finish ends it; Backspace or Undo point removes the last point; Esc cancels.</p>
          {drawing > 0 && (
            <div className="row2 wrap">
              <button type="button" className="btn sm primary" disabled={drawing < (tool === 'polygon' ? 3 : 2)} onClick={() => window.dispatchEvent(new CustomEvent('tacmap:draw', { detail: 'finish' }))}>Finish</button>
              <button type="button" className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('tacmap:draw', { detail: 'undo' }))}>Undo point</button>
              <button type="button" className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('tacmap:draw', { detail: 'cancel' }))}>Cancel</button>
            </div>
          )}
        </>
      )}
      {tool === 'text' && <p className="tip">Click the map to drop a note, then type its text.</p>}
      {state.allocations.length > 0 && (
        <>
          <h4>Reinforcements</h4>
          <ul className="allocs">
            {state.allocations.map((a) => {
              const left = remaining(a, draft);
              return (
                <li key={a.id}>
                  <button type="button" className={`btn${tool === 'place' && allocId === a.id ? ' on' : ''}`} disabled={left <= 0} onClick={() => usePlay.getState().setTool('place', a.id)}>
                    <AllocIcon a={a} />
                    <span><strong>{assetName(a)}</strong><small>{left} of {a.quantity} left{a.shared ? ' · shared with your team' : ''} · {zoneText(a.zone)}</small></span>
                  </button>
                </li>
              );
            })}
          </ul>
          {tool === 'place' && <p className="tip">Click the map to place it{state.allocations.find((a) => a.id === allocId)?.zone ? ' inside the dashed zone' : ''}. Esc stops placing.</p>}
        </>
      )}
    </section>
  );
}

function techIcon(it: Pick<TechItem, 'asset_id' | 'sidc'>): string | null {
  const a = usePlay.getState().state?.tech_assets.find((x) => x.id === it.asset_id);
  return a ? publicAssetUrl(a.path) : it.sidc ? symbolDataUrl(it.sidc, 20) : null;
}

/** Points, income, and the units this player can buy right now. */
function TechBox({ openTree }: { openTree(): void }) {
  const state = usePlay((s) => s.state!);
  const draft = usePlay((s) => s.draft);
  const tool = usePlay((s) => s.tool);
  const buyId = usePlay((s) => s.buyId);
  const { economy, tech } = state;
  if (!tech.length && !economy.spawn_points && !economy.research_points) return null;
  const left = pointsLeft();
  const editable = !!state.turn && !state.turn.frozen;
  const buyable = tech.filter((it) => it.buyable && usable(it, economy.tech_unlocked, draft));
  const picked = tech.find((x) => x.id === buyId);

  return (
    <section className="section">
      <header><h3>Supply and research</h3></header>
      <p className="points">
        <span>Spawn <b className={left.spawn < 0 ? 'neg' : ''}>{fmtPts(left.spawn)}</b>{left.spawn !== economy.spawn_points && <small> of {fmtPts(economy.spawn_points)}</small>}</span>
        <span>Research <b className={left.research < 0 ? 'neg' : ''}>{fmtPts(left.research)}</b>{left.research !== economy.research_points && <small> of {fmtPts(economy.research_points)}</small>}</span>
      </p>
      <p className="tip">Income next push: +{fmtPts(economy.income.spawn)} spawn, +{fmtPts(economy.income.research)} research. Points are spent when the owner pushes the turn.</p>
      <button type="button" className="btn" onClick={openTree}>Tech tree{tech.length ? ` (${tech.filter((x) => isUnlocked(x, economy.tech_unlocked)).length}/${tech.length} unlocked)` : ''}</button>
      {editable && buyable.length > 0 && (
        <>
          {([['building', 'Build'], ['unit', 'Recruit']] as const).map(([cat, title]) => {
            const list = buyable.filter((it) => it.category === cat);
            return list.length > 0 && (
              <div key={cat}>
                <h4>{title}</h4>
                <ul className="allocs">
                  {list.map((it) => (
                    <li key={it.id}>
                      <button type="button" className={`btn${tool === 'buy' && buyId === it.id ? ' on' : ''}`} disabled={left.spawn < it.spawn_cost} onClick={() => usePlay.getState().startBuy(it.id)}>
                        {techIcon(it) ? <img className="mini" src={techIcon(it)!} alt="" /> : null}
                        <span><strong>{it.name}</strong><small>{costText(it, 'buy')} · {whereText(it, tech)}{!it.can_move ? ' · cannot move' : ''}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {tool === 'buy' && picked && <p className="tip">Click the map to place {picked.name} {whereText(picked, tech)}{picked.placement !== 'anywhere' ? ' (dashed outlines)' : ''}. Esc stops.</p>}
          {buyable.some((it) => it.placement !== 'anywhere') && !state.spawn_zones.length && !state.spawn_points.length && (
            <p className="note">You have no spawn zone or spawn-point unit yet, so only units placeable anywhere can be bought.</p>
          )}
        </>
      )}
    </section>
  );
}

function TechModal({ onClose }: { onClose(): void }) {
  const state = usePlay((s) => s.state!);
  const draft = usePlay((s) => s.draft);
  const [sel, setSel] = useState<string | null>(null);
  const { economy, tech } = state;
  const editable = !!state.turn && !state.turn.frozen;
  const left = pointsLeft();
  const status = (it: TechItem) => techStatus(it, tech, economy.tech_unlocked, draft);
  const picked = tech.find((x) => x.id === sel);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const footer = (it: TechItem) => {
    if (!editable) return null;
    const st = status(it);
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    if (st === 'available') {
      return <button type="button" className="btn sm primary" disabled={left.research < it.research_cost} onClick={(e) => (stop(e), usePlay.getState().put({ op: 'research', feature_id: it.id }))}>Research ({it.research_cost})</button>;
    }
    if (st === 'researching') {
      const bought = draft.filter((c) => c.op === 'create' && c.payload.purchase_id === it.id).length;
      return (
        <div className="acts">
          {it.buyable && <button type="button" className="btn sm" disabled={left.spawn < it.spawn_cost} onClick={(e) => (stop(e), usePlay.getState().startBuy(it.id), onClose())}>Buy and place</button>}
          <button
            type="button" className="btn sm"
            title={bought ? `Also takes the ${bought} unit${bought === 1 ? '' : 's'} bought from it out of the draft` : undefined}
            onClick={(e) => (stop(e), usePlay.getState().setDraft(withoutResearch(draft, it.id, economy.tech_unlocked, tech)))}
          >
            Cancel research
          </button>
        </div>
      );
    }
    if (st === 'unlocked' && it.buyable) {
      return <button type="button" className="btn sm" disabled={left.spawn < it.spawn_cost} onClick={(e) => (stop(e), usePlay.getState().startBuy(it.id), onClose())}>Buy and place</button>;
    }
    return null;
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Tech tree" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog xwide">
        <header>
          <h2>Tech tree</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <p className="points">
          <span>Spawn <b>{fmtPts(left.spawn)}</b></span>
          <span>Research <b>{fmtPts(left.research)}</b></span>
          <span>Income +{fmtPts(economy.income.spawn)} / +{fmtPts(economy.income.research)} per turn</span>
        </p>
        <TechTree items={tech} icon={techIcon} status={status} selected={sel} onPick={(it) => setSel(it?.id ?? null)} footer={footer} />
        {picked && (
          <div className="quote">
            <strong>{picked.name}</strong>
            {picked.description ? `\n${picked.description}` : ''}
            {picked.prereqs.length ? `\nRequires: ${picked.prereqs.map((id) => tech.find((x) => x.id === id)?.name ?? '?').join(', ')}` : ''}
            {picked.buyable ? `\n${picked.category === 'building' ? 'Built' : 'Placed'} ${whereText(picked, tech)}.${picked.can_move ? '' : ' Cannot move once placed.'}` : '\nResearch only: unlocks what comes after it.'}
          </div>
        )}
        <p className="tip">
          {editable
            ? 'Research is added to your draft and paid for when the owner pushes the turn. You can buy and place a researched unit straight away, in the same draft, and research a whole chain of items in one turn if you have the points.'
            : 'The turn is not open for orders, so nothing can be researched or bought right now.'}
        </p>
      </div>
    </div>
  );
}

function DraftList() {
  const draft = usePlay((s) => s.draft);
  const features = usePlay((s) => s.state!.features);
  const tech = usePlay((s) => s.state!.tech);
  const sel = usePlay((s) => s.sel);
  const editable = usePlay((s) => !!s.state?.turn && !s.state.turn.frozen);
  const live = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const sqName = useSqName();
  const isAir = (c: { op: string }) => c.op === 'research' || c.op === 'mission' || c.op === 'buy_aircraft' || c.op === 'buy_squadron';
  return (
    <section className="section">
      <header><h3>Your draft{draft.length ? ` (${draft.length})` : ''}</h3></header>
      {draft.length === 0 ? (
        <p className="empty">Empty. If you leave it that way, your units stay where they are.</p>
      ) : (
        <ul className="changes">
          {draft.map((c) => (
            <li key={c.feature_id} className={sel === c.feature_id ? 'on' : ''}>
              <div className="row">
                <span role="button" tabIndex={0} onClick={() => !isAir(c) && usePlay.setState({ sel: c.feature_id, tool: 'select' })} onKeyDown={(e) => e.key === 'Enter' && !isAir(c) && usePlay.setState({ sel: c.feature_id, tool: 'select' })}>
                  {describeChange(c, live, tech, sqName)}
                </span>
                {editable && <button type="button" className="ib" title="Take this out of the draft" aria-label="Take this out of the draft" onClick={() => usePlay.getState().drop(c.feature_id)}>✕</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function useSqName() {
  const sqs = usePlay((s) => s.state!.air?.squadrons);
  return (id: string) => sqs?.find((q) => q.id === id)?.name ?? 'squadron';
}

function LastTurn() {
  const last = usePlay((s) => s.state!.last);
  const features = usePlay((s) => s.state!.features);
  const tech = usePlay((s) => s.state!.tech);
  const live = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const sqName = useSqName();
  if (!last) return null;
  const rejected = last.changes.filter((c) => last.rejected.includes(c.feature_id));
  return (
    <section className="section">
      <header><h3>Result of turn {last.number}</h3></header>
      <p className="tip">
        {!last.applied
          ? 'Your draft was not applied, so your units stayed put.'
          : `${summarize(last.changes.filter((c) => !last.rejected.includes(c.feature_id)))} applied${last.edited ? ', after changes by the owner' : ''}.`}
      </p>
      {last.applied && rejected.length > 0 && (
        <ul className="changes">
          {rejected.map((c) => <li key={c.feature_id} className="off"><div className="row"><span><span className="tag bad">rejected</span> {describeChange(c, live, tech, sqName)}</span></div></li>)}
        </ul>
      )}
      {last.owner_note && <p className="quote">Owner: {last.owner_note}</p>}
    </section>
  );
}

function Details() {
  const sel = usePlay((s) => s.sel);
  // Re-render when the draft, the live state or the viewed turn changes under the selection.
  usePlay((s) => s.draft);
  usePlay((s) => s.state);
  usePlay((s) => s.viewing);
  const e = effective(sel);
  if (!e || !sel) return null;
  const { f, change, isNew } = e;
  const st = usePlay.getState();
  const editable = st.editable();
  const mine = e.mine && editable;
  const p = f.props;
  const isPoint = f.geometry.type === 'Point';
  const canTurn = isPoint && f.kind !== 'circle' && f.kind !== 'text';
  const removing = change?.op === 'delete';
  const order = change?.op === 'update' ? change.payload.order ?? '' : '';
  const range = st.state?.radii[sel];

  return (
    <aside className="details" aria-live="polite">
      <header>
        <div>
          <small>{isNew ? `New ${KIND[f.kind].toLowerCase()} (draft)` : e.mine ? `Your ${KIND[f.kind].toLowerCase()}` : KIND[f.kind]}</small>
          <h2>{p.name || 'Unnamed'}</h2>
        </div>
        <button type="button" className="ib" aria-label="Close details" onClick={() => usePlay.setState({ sel: null })}>✕</button>
      </header>

      {isNew && mine && (
        <label className="field">
          <span>{f.kind === 'text' ? 'Text' : 'Name / label'}</span>
          <textarea rows={f.kind === 'text' ? 3 : 1} maxLength={400} value={p.name ?? ''} onChange={(ev) => st.patchCreate(sel, (c) => ({ ...c, props: { ...c.props, name: ev.target.value } }))} />
        </label>
      )}

      {mine && canTurn && !removing && (
        <label className="field">
          <span>Heading {p.heading != null ? `${Math.round(p.heading)}°` : '(none)'}</span>
          <input type="range" min={0} max={359} step={1} value={p.heading ?? 0} onChange={(ev) => st.put({ op: 'update', feature_id: sel, payload: { heading: cleanHeading(+ev.target.value) } })} />
        </label>
      )}

      {mine && !isNew && !removing && (
        <label className="field">
          <span>Order for this unit</span>
          <textarea
            rows={3} maxLength={MAX_ORDER_LEN} value={order} placeholder="e.g. Hold the ridge until 0600, then withdraw north"
            onChange={(ev) => (ev.target.value ? st.put({ op: 'update', feature_id: sel, payload: { order: ev.target.value } }) : st.setDraft(dropPart(st.draft, sel, 'order')))}
          />
        </label>
      )}

      {!isNew && (
        <dl>
          {p.type && <div><dt>Type</dt><dd>{p.type}</dd></div>}
          {p.speed && <div><dt>Speed</dt><dd>{p.speed}</dd></div>}
          {e.mine && st.state?.turn && <div><dt>Range</dt><dd>{range == null ? 'unlimited' : range === 0 ? 'cannot move this turn' : `${fmtDist(range)} from where it started the turn`}</dd></div>}
          {isPoint && <div><dt>Position</dt><dd>{fmtLatLon(f.geometry.coordinates as Pos)}</dd></div>}
        </dl>
      )}
      {!isNew && st.state?.combat?.own[sel] && <OwnCombat fid={sel} editable={mine} />}
      {!isNew && !e.mine && !st.viewing && st.state?.combat && <OtherCombat fid={sel} />}
      {!isNew && p.notes && <p className="notes">{p.notes}</p>}

      {mine && (
        <div className="inline">
          {change && <button type="button" className="btn sm" onClick={() => st.drop(sel)}>{isNew ? 'Remove from draft' : removing ? 'Keep this unit' : 'Undo my changes'}</button>}
          {!isNew && !removing && <button type="button" className="btn sm danger" onClick={() => st.put({ op: 'delete', feature_id: sel })}>Propose removal</button>}
        </div>
      )}
      {!e.mine && !st.viewing && <p className="tip">Not assigned to you.</p>}
      {removing && <p className="tip">Your draft asks the owner to remove it.</p>}
    </aside>
  );
}

/** Own unit: exact strength and experience, weapons with their targets this turn, retreat when engaged. */
function OwnCombat({ fid, editable }: { fid: string; editable: boolean }) {
  const c = usePlay((s) => s.state!.combat.own[fid]);
  const features = usePlay((s) => s.state!.features);
  const draft = usePlay((s) => s.draft);
  const targeting = usePlay((s) => s.targeting);
  const st = usePlay.getState();
  const change = draft.find((x) => x.feature_id === fid);
  const attacks = change?.op === 'update' ? change.payload.attacks ?? [] : [];
  const retreat = change?.op === 'update' && !!change.payload.retreat;
  const ratio = c.max ? c.strength / c.max : 0;
  const nameOf = (id: string) => features.find((f) => f.id === id)?.props.name || 'enemy unit';
  const setAttacks = (next: { slot: number; target: string }[]) => {
    if (next.length || change?.op === 'update') st.put({ op: 'update', feature_id: fid, payload: { attacks: next } });
  };
  if (c.category !== 'ground') return <p className="tip">{c.template}: {c.category} units take no part in ground combat yet.</p>;
  return (
    <div className="combat">
      <dl>
        <div><dt>Strength</dt><dd>{Math.round(c.strength)} / {c.max}</dd></div>
      </dl>
      <div className={`cbar${ratio < 0.3 ? ' low' : ratio < 0.6 ? ' mid' : ''}`}><i style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
      <dl>
        <div><dt>Type</dt><dd>{c.template}</dd></div>
        <div><dt>Experience</dt><dd>{c.experience} encounter{c.experience === 1 ? '' : 's'}</dd></div>
        <div><dt>Stationary</dt><dd>{c.stationary_turns} turn{c.stationary_turns === 1 ? '' : 's'}{c.stationary_turns >= 1 ? ' (dug in if it stays put)' : ''}</dd></div>
        {c.engaged && <div><dt>Status</dt><dd>In combat</dd></div>}
      </dl>
      {c.weapons.length > 0 && <h4>Weapons this turn</h4>}
      <ul className="allocs">
        {c.weapons.map((w) => {
          const a = attacks.find((x) => x.slot === w.slot);
          const picking = targeting?.fid === fid && targeting.slot === w.slot;
          return (
            <li key={w.slot}>
              <div className="row2 wrap">
                <span><strong>{w.name}</strong> <small>· {w.range_m >= 1000 ? `${+(w.range_m / 1000).toFixed(1)} km` : `${w.range_m} m`}{w.indirect ? ' · indirect (unit must stay put)' : ''}</small><br />
                  <small>{a ? `Target: ${nameOf(a.target)}` : w.indirect ? 'No target' : 'No target: returns fire if attacked'}</small></span>
                {editable && (
                  <>
                    <button type="button" className={`btn sm${picking ? ' on' : ''}`} onClick={() => usePlay.setState({ targeting: picking ? null : { fid, slot: w.slot } })}>{picking ? 'Click a target…' : a ? 'Change' : 'Pick target'}</button>
                    {a && <button type="button" className="btn sm" onClick={() => setAttacks(attacks.filter((x) => x.slot !== w.slot))}>Clear</button>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {c.radar_aa && (
        <label className="check">
          <input type="checkbox" disabled={!editable} checked={change?.op === 'update' && change.payload.emit != null ? change.payload.emit : c.emit ?? true}
            onChange={(e) => st.put({ op: 'update', feature_id: fid, payload: { emit: e.target.checked } })} />
          Radar on. Off (dark) hides it from HARMs but halves its radar AA accuracy. Kept until you change it.
        </label>
      )}
      {editable && c.engaged && (
        <label className="check">
          <input type="checkbox" checked={retreat} onChange={(e) => st.put({ op: 'update', feature_id: fid, payload: { retreat: e.target.checked } })} />
          Retreat: leave the fight this turn (takes one parting round of fire), then it may move
        </label>
      )}
      {targeting?.fid === fid && <p className="tip">Click an enemy unit on the map. Range is checked after everyone has moved.</p>}
    </div>
  );
}

/** Another player's unit: an estimate band if it is within intel range of one of yours, else nothing. */
function OtherCombat({ fid }: { fid: string }) {
  const seen = usePlay((s) => s.state!.combat.seen[fid]);
  const km = usePlay((s) => s.state!.combat.intel_km);
  const air = usePlay((s) => s.state!.air);
  const exact = air?.revealed[fid];
  const base = air?.enemy_bases.find((b) => b.base === fid);
  const rsq = air?.revealed_squadrons.filter((q) => q.base === fid) ?? [];
  if (exact || base || rsq.length) {
    return (
      <div className="revealed">
        {exact && <p>Recon (last turn, exact): {exact.type}, strength {exact.strength} / {exact.max}</p>}
        {rsq.length > 0 ? (
          <p>Squadrons here (recon): {rsq.map((q) => `${q.name}, ${q.aircraft} / ${q.max} ${q.airframe}`).join('; ')}</p>
        ) : base && (
          <p>Airbase with {base.squadrons.length} squadron{base.squadrons.length === 1 ? '' : 's'}: {base.squadrons.map((b, i) => <span key={i} className={`band ${b.replace(' ', '-')}`}>{b}</span>)}</p>
        )}
        {!exact && seen?.ground && <p>Estimated condition: <span className={`band ${seen.band.replace(' ', '-')}`}>{seen.band}</span></p>}
      </div>
    );
  }
  if (!seen) return <p className="tip">No intel: none of your units is within {km} km.</p>;
  if (!seen.ground) return null;
  return <p>Estimated condition: <span className={`band ${seen.band.replace(' ', '-')}`}>{seen.band}</span></p>;
}

/** What combat did to this player's units at the last push, and what they know of the other side. */
function CombatReportBox() {
  const r = usePlay((s) => s.state!.combat?.report);
  const a = r?.air;
  if (!r || (!r.own.length && !r.engagements.length && !(a && (a.squadrons.length || a.strikes.length || a.recon.length || a.downed)))) return null;
  return (
    <section className="section">
      <header><h3>Combat report, turn {r.turn}</h3></header>
      <ul className="changes">
        {r.own.map((u) => (
          <li key={u.id}>
            <div className="row">
              <span>
                <strong>{u.name}</strong>{' '}
                {u.destroyed ? <span className="tag bad">destroyed</span> : <small>{Math.round(u.before)} → {Math.round(u.after)} / {u.max}</small>}
                {u.recovered > 0 && <small> · recovered {Math.round(u.recovered)}</small>}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {r.engagements.map((e) => (
        <p key={e.id} className="tip">
          {e.new ? 'New fight' : 'Fight'}: {e.own.join(', ')} against {e.others.map((o) => `${o.name}${o.band ? ` (${o.band})` : ''}`).join(', ') || 'unknown units'}
          {e.status === 'ended' ? ` · ended (${e.end_reason})` : ` · ${e.rounds} round${e.rounds === 1 ? '' : 's'}, continues`}
        </p>
      ))}
      <AirReportPart />
    </section>
  );
}

// The invite sits in the URL fragment, which browsers never send to the page host or to tile servers.
const token = location.hash.slice(1);
window.addEventListener('hashchange', () => location.reload());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {!sb ? (
      <Message title="This site is not set up yet" body="The map owner still has to fill in config.js." />
    ) : /^[0-9a-f]{64}$/.test(token) ? (
      <Game token={token} />
    ) : (
      <Message title="This invite link is not valid" body="Check that you copied the whole address." />
    )}
  </StrictMode>,
);
