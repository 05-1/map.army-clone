// Everything the owner manages outside the map itself: maps, history and backups, settings and
// co-admins, diagnostics. Each control calls an owner-only RPC; nothing here needs the Supabase dashboard.
import { useEffect, useRef, useState } from 'react';
import { anonymousSignInsEnabled, SCHEMA_VERSION } from '../lib/supabase';
import { ago, fmtWhen } from '../lib/submissions';
import { turnLabel } from '../lib/TurnSlider';
import type { MapMeta } from '../lib/types';
import type { Activity, AdminList, Backend, CampaignBackup, Diagnostics, MapPatch, Who } from './backend';
import { useEd } from './store';

/** A stable empty list for store selectors (a new [] each read would re-render forever). */
const NONE: never[] = [];
import { Field, IconButton } from './ui';

export type AdminTab = 'maps' | 'history' | 'settings' | 'diagnostics';
const TABS: [AdminTab, string][] = [['maps', 'Maps'], ['history', 'History and backup'], ['settings', 'Settings'], ['diagnostics', 'Diagnostics']];

interface Props {
  backend: Backend;
  who: Who;
  map: MapMeta;
  maps: MapMeta[];
  tab: AdminTab;
  setTab(t: AdminTab): void;
  setMaps(maps: MapMeta[]): void;
  onSwitch(id: string): void;
  onPatchMap(p: MapPatch): void;
  settle(): Promise<void>;
  reload(): void;
  onClose(): void;
}

export function AdminDialog(p: Props) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Manage" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="dialog wide">
        <header>
          <h2>Manage</h2>
          <IconButton icon="x" title="Close" onClick={p.onClose} />
        </header>
        <div className="seg tabs" role="tablist">
          {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={p.tab === t} className={p.tab === t ? 'on' : ''} onClick={() => p.setTab(t)}>{label}</button>)}
        </div>
        {p.tab === 'maps' && <Maps {...p} />}
        {p.tab === 'history' && <History {...p} />}
        {p.tab === 'settings' && <Settings {...p} />}
        {p.tab === 'diagnostics' && <Diag {...p} />}
      </div>
    </div>
  );
}

/** Runs an action and reports failure in place. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const run = async (fn: () => Promise<unknown>, ok = '') => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const said = await fn();
      setDone(typeof said === 'string' && said.startsWith('::') ? said.slice(2) : ok);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const status = error ? <p className="note bad" role="alert">{error}</p> : done ? <p className="note ok" role="status">{done}</p> : null;
  return { busy, run, status };
}

function Maps({ backend, map, maps, setMaps, onSwitch, onPatchMap, onClose }: Props) {
  const assets = useEd((s) => s.assets);
  const { busy, run, status } = useRun();
  const [name, setName] = useState('');
  const patch = (id: string, pt: MapPatch) =>
    run(async () => {
      const m = await backend.updateMap(id, pt);
      setMaps(maps.map((x) => (x.id === id ? { ...x, ...m } : x)));
    });
  const palette = new Set(map.palette_assets ?? []);

  return (
    <>
      <div className="newlink">
        <h4>New map</h4>
        <div className="row2">
          <input value={name} maxLength={120} placeholder="Name" aria-label="New map name" onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void run(async () => { const m = await backend.createMap(name.trim()); setMaps([m, ...maps]); setName(''); onSwitch(m.id); onClose(); })}>Create and open</button>
        </div>
      </div>
      {status}
      <h4>Maps</h4>
      <ul className="links">
        {maps.map((m) => (
          <li key={m.id} className={m.archived ? 'bad' : ''}>
            <div>
              <input
                className="inline-name" key={m.name} defaultValue={m.name} maxLength={120} aria-label="Map name"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.name) void patch(m.id, { name: v }); else e.target.value = m.name; }}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              {m.id === map.id && <span className="tag ok">open</span>}
              {m.archived && <span className="tag">archived</span>}
            </div>
            {m.id !== map.id && !m.archived && <button type="button" className="btn sm" onClick={() => (onSwitch(m.id), onClose())}>Open</button>}
            <button type="button" className="btn sm" disabled={busy || (m.id === map.id && !m.archived)} title={m.id === map.id && !m.archived ? 'Open another map first' : ''} onClick={() => void patch(m.id, { archived: !m.archived })}>
              {m.archived ? 'Restore' : 'Archive'}
            </button>
          </li>
        ))}
      </ul>
      <p className="tip">Archiving hides a map from the switcher. Its links keep working and nothing is deleted. Default basemap and the start view are set from the top bar of the open map.</p>

      <h4>What may be handed out as reinforcements on "{map.name}"</h4>
      <label className="check">
        <input type="checkbox" checked={map.palette_symbols !== false} onChange={(e) => onPatchMap({ palette_symbols: e.target.checked })} />
        NATO symbols
      </label>
      {assets.filter((a) => !a.deleted_at).length === 0 ? (
        <p className="empty">Upload graphics in the editor (G) first.</p>
      ) : (
        <div className="assetgrid pal">
          {assets.filter((a) => !a.deleted_at).map((a) => (
            <label key={a.id} className={`tile${palette.has(a.id) ? ' on' : ''}`}>
              <input
                type="checkbox" checked={palette.has(a.id)}
                onChange={(e) => {
                  const n = new Set(palette);
                  if (e.target.checked) n.add(a.id);
                  else n.delete(a.id);
                  onPatchMap({ palette_assets: [...n] });
                }}
              />
              <img src={backend.assetUrl(a)} alt="" loading="lazy" />
              <span>{a.name}</span>
            </label>
          ))}
        </div>
      )}
      <p className="tip">With nothing ticked, every graphic in the library is offered when you add an allocation.</p>
    </>
  );
}

function History({ backend, map, maps, setMaps, onSwitch, settle, reload, onClose }: Props) {
  const history = useEd((s) => s.bundle?.history ?? NONE);
  const { busy, run, status } = useRun();
  const file = useRef<HTMLInputElement>(null);

  const view = (n: number) =>
    run(async () => {
      const snap = await backend.getSnapshot(map.id, n);
      if (!snap) throw new Error('That turn has no snapshot');
      useEd.setState({ viewing: snap, review: null, selection: [] });
      onClose();
    });
  const rollback = (n: number) =>
    confirm(`Roll the map back to how it was ${n === 0 ? 'at the start' : `after turn ${n}`}? The turn in progress is closed (its drafts are kept in the archive) and a new turn opens from that position. Later turns stay in the history.`) &&
    run(async () => {
      await settle();
      const r = await backend.rollbackTo(map.id, n);
      backend.ping(map);
      useEd.getState().say(`Rolled back to turn ${r.rollback_of}. Turn ${r.turn} is open.`);
      onClose();
      reload();
    });
  const exportNow = () =>
    run(async () => {
      await settle();
      const data = await backend.exportCampaign(map.id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = `${map.name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.tacmap.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'Backup downloaded. It contains invite and share links, so keep it private.');
  const importFile = (f: File) =>
    run(async () => {
      const data = JSON.parse(await f.text()) as CampaignBackup;
      if (data?.format !== 'tacmap-campaign') throw new Error('That file is not a Tacmap campaign backup.');
      const exists = maps.some((m) => m.id === data.map.id);
      if (exists && !confirm(`"${data.map.name}" already exists here. Replace it with the backup from ${fmtWhen(data.exported_at)}? Everything on the current version of that map is overwritten.`)) return;
      const id = await backend.importCampaign(data, exists);
      setMaps(await backend.listMaps());
      onClose();
      if (id === map.id) reload();
      else onSwitch(id);
    }, 'Campaign restored. Players re-open their invite links to rejoin.');

  return (
    <>
      {status}
      <h4>Turns of "{map.name}"</h4>
      {history.length === 0 ? (
        <p className="empty">No turns yet. The first snapshot is taken when you open turn 1.</p>
      ) : (
        <ul className="links">
          {[...history].reverse().map((h) => (
            <li key={h.number}>
              <div><strong>{turnLabel(h)}</strong><small>{fmtWhen(h.at)}</small></div>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void view(h.number)}>View</button>
              <button type="button" className="btn sm danger" disabled={busy} onClick={() => void rollback(h.number)}>Roll back to here</button>
            </li>
          ))}
        </ul>
      )}
      <p className="tip">Viewing shows the whole map as it was, including layers hidden from players. Players and viewers get the same slider, cut down to the layers they may see.</p>
      <h4>Backup</h4>
      <div className="row2">
        <button type="button" className="btn" disabled={busy} onClick={() => void exportNow()}>Download backup of this map</button>
        <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>Restore from a backup file…</button>
        <input ref={file} type="file" hidden accept=".json,application/json" onChange={(e) => (e.target.files?.[0] && void importFile(e.target.files[0]), (e.target.value = ''))} />
      </div>
      <p className="tip">A backup holds the map, every turn, players, links and the image files. Restoring keeps the same links. The Discord webhook is not included.</p>
    </>
  );
}

function Settings({ backend, map, who }: Props) {
  const { busy, run, status } = useRun();
  const [settings, setSettings] = useState<{ discord: string | null; pg_net: boolean } | null>(null);
  const [admins, setAdmins] = useState<AdminList | null>(null);
  const [hook, setHook] = useState('');
  const [email, setEmail] = useState('');
  const load = async () => {
    const [s, a] = await Promise.all([backend.getSettings(map.id), backend.listAdmins()]);
    setSettings(s);
    setAdmins(a);
  };
  useEffect(() => {
    void run(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isOwner = who.role === 'owner';

  return (
    <>
      {status}
      <h4>Discord announcement for "{map.name}"</h4>
      <p className="tip">Posts "Turn N is live" to a channel when you push. Create the webhook in Discord: channel settings, Integrations, Webhooks.</p>
      <p>Current: <strong className="mono">{settings?.discord ?? 'not set'}</strong></p>
      {settings && !settings.pg_net && <p className="note bad">The pg_net extension is not enabled in this database, so nothing can be sent. Re-run setup.sql.</p>}
      <div className="row2">
        <input type="password" autoComplete="off" value={hook} placeholder="Paste a new webhook URL" aria-label="Discord webhook URL" onChange={(e) => setHook(e.target.value)} />
        <button type="button" className="btn primary" disabled={busy || !hook.trim()} onClick={() => void run(async () => { await backend.setDiscordWebhook(map.id, hook.trim()); setHook(''); await load(); }, 'Webhook saved.')}>Save</button>
      </div>
      <div className="row2">
        <button type="button" className="btn" disabled={busy || !settings?.discord} onClick={() => void run(async () => { if (!(await backend.testDiscordWebhook(map.id))) throw new Error('Could not queue the test message.'); }, 'Test message queued. It should appear in the channel within a few seconds.')}>Send test message</button>
        <button type="button" className="btn danger" disabled={busy || !settings?.discord} onClick={() => void run(async () => { await backend.setDiscordWebhook(map.id, null); await load(); }, 'Webhook cleared.')}>Clear</button>
      </div>

      <h4>Admins</h4>
      <ul className="links">
        {admins?.admins.map((a) => (
          <li key={a.uid}>
            <div><strong>{a.email ?? a.uid}</strong><span className={`tag ${a.role === 'owner' ? 'ok' : ''}`}>{a.role === 'owner' ? 'owner' : 'co-admin'}</span>{a.me && <span className="tag">you</span>}</div>
            {isOwner && a.role === 'admin' && (
              <>
                <button type="button" className="btn sm" disabled={busy} onClick={() => confirm(`Make ${a.email} the owner? You become a co-admin.`) && void run(async () => { await backend.transferOwnership(a.uid); location.reload(); })}>Make owner</button>
                <button type="button" className="btn sm danger" disabled={busy} onClick={() => confirm(`Remove ${a.email} as co-admin?`) && void run(async () => { await backend.removeAdmin(a.uid); await load(); })}>Remove</button>
              </>
            )}
          </li>
        ))}
        {admins?.invites.map((e) => (
          <li key={e}>
            <div><strong>{e}</strong><span className="tag">invited, has not signed in yet</span></div>
            {isOwner && <button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => { await backend.cancelAdminInvite(e); await load(); })}>Cancel</button>}
          </li>
        ))}
      </ul>
      {isOwner ? (
        <>
          <div className="row2">
            <input type="email" value={email} placeholder="Email of the co-admin" aria-label="Co-admin email" onChange={(e) => setEmail(e.target.value)} />
            <button type="button" className="btn primary" disabled={busy || !email.includes('@')} onClick={() => void run(async () => { const r = await backend.inviteAdmin(email); setEmail(''); await load(); return r === 'invited' ? '::Invited. Ask them to open this site, choose "Create account" with that address and confirm the email. They become a co-admin when they next sign in.' : '::Added as co-admin.'; })}>Invite</button>
          </div>
          <p className="tip">Co-admins can run the whole game. Only the owner can add or remove admins or hand over ownership. There is always exactly one owner.</p>
        </>
      ) : (
        <p className="tip">Only the owner can add or remove admins.</p>
      )}
    </>
  );
}

function Diag({ backend, map }: Props) {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [log, setLog] = useState<Activity[]>([]);
  const [anon, setAnon] = useState<boolean | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([backend.diagnostics(), backend.listActivity(map.id), anonymousSignInsEnabled()]).then(
      ([x, l, a]) => { setD(x); setLog(l); setAnon(a); },
      (e) => setError((e as Error).message),
    );
  }, [backend, map.id]);

  const row = (label: string, ok: boolean | null, text: string) => (
    <div><dt>{label}</dt><dd><span className={`tag ${ok === null ? '' : ok ? 'ok' : 'bad'}`}>{ok === null ? 'unknown' : ok ? 'OK' : 'action needed'}</span> {text}</dd></div>
  );
  const keepAge = d?.last_keepalive ? (Date.now() - +new Date(d.last_keepalive)) / 864e5 : null;

  return (
    <>
      {error && <p className="note bad" role="alert">Supabase connection failed: {error}</p>}
      {d && (
        <dl className="diag">
          {row('Supabase connection', true, `reachable, server time ${fmtWhen(d.server_time)}`)}
          {row('Database schema', d.schema_version === SCHEMA_VERSION, d.schema_version === SCHEMA_VERSION ? `version ${d.schema_version}` : d.schema_version < SCHEMA_VERSION ? `database is version ${d.schema_version}, this site needs ${SCHEMA_VERSION}: run setup.sql again` : `database is version ${d.schema_version}, this site expects ${SCHEMA_VERSION}: upload the newer release folder`)}
          {row('Anonymous sign-ins (players)', anon ?? null, anon === false ? 'turned off: players cannot join. Supabase > Authentication > Sign In / Providers > Allow anonymous sign-ins' : anon ? 'enabled' : 'could not be read')}
          {row('Keep-alive', keepAge === null ? null : keepAge < 6, d.last_keepalive ? `last ping ${ago(d.last_keepalive)}` : 'no ping recorded yet. The keepalive workflow runs every 3 days; start it once from the Actions tab.')}
          {row('Discord sending (pg_net)', d.pg_net, d.pg_net ? 'available' : 'extension missing: re-run setup.sql')}
          <div><dt>Totals</dt><dd>{d.maps} maps · {d.players} players · {d.snapshots} turn snapshots</dd></div>
        </dl>
      )}
      <h4>Recent activity on "{map.name}"</h4>
      {log.length === 0 ? <p className="empty">Nothing yet.</p> : (
        <table className="log">
          <tbody>
            {log.map((a) => <tr key={a.id}><td>{fmtWhen(a.at)}</td><td>{a.actor}</td><td>{a.kind}{a.detail ? `: ${a.detail}` : ''}</td></tr>)}
          </tbody>
        </table>
      )}
    </>
  );
}
