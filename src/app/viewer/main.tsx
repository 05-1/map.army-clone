// Read-only viewer. Separate entry point: this bundle imports nothing from src/editor, so there are
// no edit controls to unhide and no write code to call. All data arrives through one token-checked RPC.
import type { Map as MlMap } from 'maplibre-gl';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { asBasemap, BASEMAP_IDS, BASEMAPS, setBasemap } from '../lib/basemaps';
import { fmtDist, fmtLatLon } from '../lib/geo';
import { createMap } from '../lib/mapview';
import { HIT_LAYERS, SceneRenderer } from '../lib/scene';
import { liveChannelName, publicAssetUrl, supabase } from '../lib/supabase';
import { TurnSlider } from '../lib/TurnSlider';
import type { BasemapId, Feature, HistoryEntry, Pos, SharedPayload } from '../lib/types';
import '../styles.css';

const POLL_MS = 60_000;
const KIND: Record<Feature['kind'], string> = {
  symbol: 'Unit', asset: 'Asset', text: 'Text', line: 'Line', arrow: 'Arrow', polygon: 'Area', circle: 'Range ring', freehand: 'Sketch',
};

/** turn = null for the live map, or a pushed turn number. The server applies this link's layer limits to both. */
async function fetchShared(token: string, turn: number | null = null): Promise<SharedPayload | null> {
  const { data, error } = await supabase!.rpc('get_shared_map', { p_token: token, p_turn: turn });
  if (error) throw new Error(error.message);
  return data as SharedPayload | null;
}

type State = { s: 'loading' } | { s: 'gone' } | { s: 'error'; msg: string } | { s: 'ok' };

function Viewer({ token }: { token: string }) {
  const el = useRef<HTMLDivElement>(null);
  const coordEl = useRef<HTMLSpanElement>(null);
  const data = useRef<SharedPayload | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [state, setState] = useState<State>({ s: 'loading' });
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'live' | 'snapshot'>('live');
  const [online, setOnline] = useState(false);
  const [basemap, setBase] = useState<BasemapId>('satellite');
  const [picked, setPicked] = useState<Feature | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [rollbackOf, setRollbackOf] = useState<number | null>(null);
  const turnRef = useRef<number | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let dead = false;
    let renderer: SceneRenderer | null = null;
    let timer = 0;
    let debounce = 0;
    let channel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;

    const draw = () => {
      const p = data.current;
      if (!p || !renderer) return;
      renderer.update(p.layers, p.features, new Map(p.assets.map((a) => [a.id, a])));
    };

    const stop = () => {
      clearInterval(timer);
      clearTimeout(debounce);
      if (channel) void supabase!.removeChannel(channel);
      channel = null;
    };

    const refresh = async () => {
      try {
        const p = await fetchShared(token, turnRef.current);
        if (dead) return;
        if (!p) {
          // Revoked, expired or deleted: drop everything already on screen.
          data.current = null;
          stop();
          mapRef.current?.remove();
          mapRef.current = null;
          setPicked(null);
          setState({ s: 'gone' });
          return;
        }
        data.current = p;
        setTitle(p.map.name);
        setUpdated(new Date());
        setHistory(p.history ?? []);
        setViewing(p.viewing ?? null);
        setCurrent(p.turn ?? null);
        setRollbackOf(p.rollback_of ?? null);
        setPicked((cur) => (cur ? p.features.find((f) => f.id === cur.id) ?? null : null));
        draw();
      } catch {
        /* transient network error: keep showing the last good state and try again on the next tick */
      }
    };
    refreshRef.current = refresh;
    const refreshSoon = () => {
      clearTimeout(debounce);
      debounce = window.setTimeout(refresh, 250);
    };

    (async () => {
      const p = await fetchShared(token);
      if (dead) return;
      if (!p) return setState({ s: 'gone' });
      data.current = p;
      setTitle(p.map.name);
      setMode(p.mode);
      setHistory(p.history ?? []);
      setCurrent(p.turn ?? null);
      setBase(asBasemap(p.map.basemap));
      setUpdated(new Date());
      setState({ s: 'ok' });
      document.title = `${p.map.name} · Tacmap`;

      const map = createMap(el.current!, p.map);
      mapRef.current = map;
      map.on('mousemove', (e) => {
        if (coordEl.current) coordEl.current.textContent = fmtLatLon([e.lngLat.lng, e.lngLat.lat]);
        map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: HIT_LAYERS }).length ? 'pointer' : '';
      });
      map.on('click', (e) => {
        const hit = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: HIT_LAYERS })[0];
        setPicked(hit ? data.current?.features.find((f) => f.id === hit.properties.fid) ?? null : null);
      });
      map.once('load', () => {
        if (dead) return;
        renderer = new SceneRenderer(map, (a) => publicAssetUrl(a.path));
        draw();
      });

      if (p.mode === 'live' && p.channel) {
        // The channel only carries "something changed" pings. Content always comes from the RPC,
        // so a revoked link stops receiving data even if the page stays open.
        channel = supabase!.channel(liveChannelName(p.channel));
        channel.on('broadcast', { event: 'changed' }, refreshSoon).subscribe((status) => {
          if (dead) return;
          setOnline(status === 'SUBSCRIBED');
          if (status === 'SUBSCRIBED') refreshSoon(); // catch up after a reconnect
        });
        timer = window.setInterval(refresh, POLL_MS);
        document.addEventListener('visibilitychange', onVisible);
      } else {
        timer = window.setInterval(refresh, POLL_MS); // snapshots still honour expiry and revocation
      }
    })().catch((e) => !dead && setState({ s: 'error', msg: (e as Error).message }));

    function onVisible() {
      if (!document.hidden) refreshSoon();
    }

    return () => {
      dead = true;
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      renderer?.destroy();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [token]);

  if (state.s === 'gone') return <Message title="This link is no longer available" body="It may have expired or been revoked by the map owner." />;
  if (state.s === 'error') return <Message title="Could not load the map" body={state.msg} />;

  return (
    <div className="viewer">
      <div ref={el} className="map" />
      {state.s === 'loading' && <div className="splash over">Loading…</div>}
      {state.s === 'ok' && (
        <>
          <div className="vbar">
            <strong>{title}</strong>
            {mode === 'live' ? (
              <span className={`pill ${online ? 'saved' : 'dirty'}`}>{online ? 'Live' : 'Reconnecting…'}</span>
            ) : (
              <span className="pill">Snapshot</span>
            )}
            <span className="pill">View only</span>
            <span className="grow" />
            <div className="seg compact" role="group" aria-label="Basemap">
              {BASEMAP_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={basemap === id ? 'on' : ''}
                  onClick={() => {
                    setBase(id);
                    if (mapRef.current) setBasemap(mapRef.current, id);
                  }}
                >
                  {BASEMAPS[id].label}
                </button>
              ))}
            </div>
          </div>
          {picked && <Details f={picked} onClose={() => setPicked(null)} />}
          <div className="vfoot mono">
            <span ref={coordEl}>–</span>
            {updated && mode === 'live' && viewing === null && <span>updated {updated.toLocaleTimeString()}</span>}
            {mode === 'live' && (
              <TurnSlider
                history={history} viewing={viewing} current={current} rollbackOf={rollbackOf}
                onPick={(n) => {
                  turnRef.current = n;
                  setPicked(null);
                  void refreshRef.current();
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Details({ f, onClose }: { f: Feature; onClose: () => void }) {
  const p = f.props;
  const rows: [string, string][] = [];
  if (p.type) rows.push(['Type', p.type]);
  if (p.heading != null && f.geometry.type === 'Point' && f.kind !== 'circle') rows.push(['Heading', `${Math.round(p.heading)}°`]);
  if (p.speed) rows.push(['Speed', p.speed]);
  if (f.kind === 'circle' && p.radius) rows.push(['Radius', fmtDist(p.radius)]);
  if (p.timestamp) rows.push(['Time', new Date(p.timestamp).toLocaleString()]);
  if (f.geometry.type === 'Point') rows.push(['Position', fmtLatLon(f.geometry.coordinates as Pos)]);
  return (
    <aside className="details" aria-live="polite">
      <header>
        <div>
          <small>{KIND[f.kind]}</small>
          <h2>{p.name || 'Unnamed'}</h2>
        </div>
        <button type="button" className="ib" aria-label="Close details" onClick={onClose}>✕</button>
      </header>
      {rows.length > 0 && (
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {p.notes && <p className="notes">{p.notes}</p>}
    </aside>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="splash">
      <div className="login">
        <div className="brand">TACMAP</div>
        <h2>{title}</h2>
        <p className="note">{body}</p>
      </div>
    </div>
  );
}

// The token lives in the URL fragment, which browsers never send to any server: not to the host
// serving this page, and not to tile providers via the Referer header.
const token = location.hash.slice(1);
window.addEventListener('hashchange', () => location.reload());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {!supabase ? (
      <Message title="This site is not set up yet" body="The map owner still has to fill in config.js." />
    ) : /^[0-9a-f]{64}$/.test(token) ? (
      <Viewer token={token} />
    ) : (
      <Message title="This link is not valid" body="Check that you copied the whole address." />
    )}
  </StrictMode>,
);
