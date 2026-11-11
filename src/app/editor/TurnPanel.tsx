// The owner's turn panel: open and configure the turn, movement rules, reinforcement allocations,
// review of every player's draft, and the push. Every button here calls an owner-only RPC.
import { useMemo, useState } from 'react';
import { fmtDist } from '../lib/geo';
import { symbolDataUrl } from '../lib/images';
import { ago, describeChange, effectiveChanges, findConflicts, fmtWhen, summarize, zoneFromFeature, zoneText } from '../lib/submissions';
import { buildSidc } from '../lib/symbols';
import { draftCost, fmtPts, toggleRejected } from '../lib/tech';
import type { Allocation, Draft, Feature, MapMeta, Player, Turn, Zone } from '../lib/types';
import type { Backend, TurnPatch } from './backend';
import { useEd } from './store';
import { Field, IconButton, Section } from './ui';

interface Props {
  backend: Backend;
  map: MapMeta;
  /** Resolves once the owner's own edits are saved. */
  settle(): Promise<void>;
  /** Re-read the turn from the server. */
  refresh(): Promise<void>;
  /** Reload the whole map (after a push changed it server-side). */
  reload(): void;
}

const km = (m: number | null | undefined) => (m == null ? '' : String(+(m / 1000).toFixed(3)));
const toM = (v: string) => (v.trim() === '' ? null : Math.max(0, +v) * 1000);
const localInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const nameOf = (f: Feature | undefined) => f?.props.name?.split('\n')[0] || (f ? f.kind : 'removed object');

function Chip({ p }: { p?: Player }) {
  return <i className="chip" style={{ background: p?.color ?? '#8794a4' }} aria-hidden />;
}

export function TurnPanel({ backend, map, settle, refresh, reload }: Props) {
  const bundle = useEd((s) => s.bundle);
  const players = useEd((s) => s.players);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const turn = bundle?.turn ?? null;

  /** Run one owner action, then re-read the turn and tell players and viewers to refresh. */
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      backend.ping(map);
      after?.();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  if (!bundle) return <Section title="Turn"><p className="empty">Loading…</p></Section>;

  if (!turn) {
    return (
      <Section title="Turn">
        <p className="tip">
          No turn is running. Opening one records the map as it is now as the starting position, lets players start
          drafting, and gives you the review and push controls.
        </p>
        {players.length === 0 && <p className="note">Create players first (Players, top bar) and assign units to them.</p>}
        {error && <p className="note bad" role="alert">{error}</p>}
        <button type="button" className="btn primary" disabled={busy} onClick={() => void act(() => settle().then(() => backend.openTurn(map.id)))}>
          Open turn {(bundle.history.at(-1)?.number ?? 0) + 1}
        </button>
      </Section>
    );
  }

  const push = () => {
    const ready = bundle.drafts.filter((d) => d.ready).length;
    if (!confirm(`Push turn ${turn.number}? ${ready} accepted draft${ready === 1 ? '' : 's'} will be applied to the live map, a snapshot is saved, and turn ${turn.number + 1} opens. Drafts not marked ready are left out.`)) return;
    void act(
      async () => {
        await settle(); // the push works on the server's copy of the map
        const r = await backend.pushTurn(turn.id);
        useEd.getState().say(`Turn ${r.pushed} is live (${r.applied} changes). Turn ${r.next} is open.`);
      },
      reload,
    );
  };

  return (
    <>
      <Section title={`Turn ${turn.number}`}>
        <div className="row2 wrap">
          <span className={`tag ${turn.status === 'open' ? 'ok' : 'warn'}`}>{turn.status === 'open' ? (turn.frozen ? 'deadline passed' : 'open for orders') : 'locked for review'}</span>
          {turn.rollback_of != null && <span className="tag">rolled back from turn {turn.rollback_of}</span>}
          {turn.deadline && <small>Deadline {fmtWhen(turn.deadline)}</small>}
        </div>
        {error && <p className="note bad" role="alert">{error}</p>}
        <div className="row2">
          {turn.status === 'open' ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act(() => backend.lockTurn(turn.id))}>Lock for review</button>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={push}>Push turn</button>
              <button type="button" className="btn" disabled={busy} title="Reopen the turn so players can keep editing" onClick={() => void act(() => backend.unlockTurn(turn.id))}>Unlock</button>
            </>
          )}
        </div>
        <p className="tip">
          {turn.status === 'open'
            ? 'Players can edit their drafts until the deadline or until you lock. Nothing they draft is visible to anyone else.'
            : 'Players are frozen. Review the drafts below, then push. Only drafts marked ready are applied.'}
        </p>
      </Section>
      <Settings turn={turn} busy={busy} save={(patch) => act(() => backend.updateTurn(turn.id, patch))} />
      <MoveRules backend={backend} turn={turn} act={act} />
      <Allocations backend={backend} turn={turn} act={act} />
      <Drafts backend={backend} turn={turn} act={act} />
    </>
  );
}

type Act = (fn: () => Promise<unknown>, after?: () => void) => Promise<void>;

function Settings({ turn, busy, save }: { turn: Turn; busy: boolean; save(p: TurnPatch): Promise<void> }) {
  const extend = (days: number) => save({ deadline: new Date(Math.max(Date.now(), turn.deadline ? +new Date(turn.deadline) : 0) + days * 864e5).toISOString() });
  return (
    <Section title="Turn settings">
      <Field label="Deadline (drafts freeze at this time)" wide>
        <input
          type="datetime-local" key={turn.deadline ?? 'none'} defaultValue={localInput(turn.deadline)}
          onBlur={(e) => {
            const v = e.target.value ? new Date(e.target.value).toISOString() : null;
            if (v !== turn.deadline) void save({ deadline: v });
          }}
        />
      </Field>
      <div className="row2">
        <button type="button" className="btn sm" disabled={busy} onClick={() => void extend(1)}>+1 day</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void extend(7)}>+7 days</button>
        <button type="button" className="btn sm" disabled={busy || !turn.deadline} onClick={() => void save({ deadline: null })}>No deadline</button>
      </div>
      <div className="row2">
        <Field label="Move radius (km, blank = any)">
          <input type="number" min={0} step="any" key={`r${turn.default_radius_m}`} defaultValue={km(turn.default_radius_m)}
            onBlur={(e) => toM(e.target.value) !== turn.default_radius_m && void save({ default_radius_m: toM(e.target.value) })} />
        </Field>
        <Field label="Conflict distance (km)">
          <input type="number" min={0} step="any" key={`c${turn.conflict_m}`} defaultValue={km(turn.conflict_m)}
            onBlur={(e) => (toM(e.target.value) || null) !== turn.conflict_m && void save({ conflict_m: toM(e.target.value) || null })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={turn.carry_allocations} onChange={(e) => void save({ carry_allocations: e.target.checked })} />
        Carry unplaced reinforcements over to the next turn (otherwise they expire)
      </label>
    </Section>
  );
}

function MoveRules({ backend, turn, act }: { backend: Backend; turn: Turn; act: Act }) {
  const rules = useEd((s) => s.bundle!.rules);
  const features = useEd((s) => s.features);
  const assets = useEd((s) => s.assets);
  const selection = useEd((s) => s.selection);
  const [radius, setRadius] = useState('');
  const [assetId, setAssetId] = useState('');
  const byId = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const r = toM(radius);

  return (
    <Section title="Move overrides">
      {rules.length === 0 ? (
        <p className="empty">Every unit uses the turn's move radius. Add an override for single units or for a type of graphic.</p>
      ) : (
        <ul className="changes">
          {rules.map((x) => (
            <li key={x.feature_id ?? x.asset_id}>
              <div className="row">
                <span>
                  {x.feature_id ? nameOf(byId.get(x.feature_id)) : `Every ${assets.find((a) => a.id === x.asset_id)?.name ?? 'graphic'}`}
                  : <strong>{x.radius_m === 0 ? 'cannot move' : fmtDist(x.radius_m)}</strong>
                </span>
                <IconButton icon="x" title="Remove override" onClick={() => void act(() => backend.setMoveRule(turn.id, x.feature_id ? { feature_id: x.feature_id } : { asset_id: x.asset_id! }, null))} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Field label="Radius for the new override (km, 0 = cannot move)" wide>
        <input type="number" min={0} step="any" value={radius} onChange={(e) => setRadius(e.target.value)} />
      </Field>
      <button
        type="button" className="btn sm" disabled={r == null || selection.length === 0}
        onClick={() => void act(async () => { for (const id of selection) await backend.setMoveRule(turn.id, { feature_id: id }, r); })}
      >
        Apply to {selection.length || 'the'} selected unit{selection.length === 1 ? '' : 's'}
      </button>
      <div className="row2">
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)} aria-label="Graphic type">
          <option value="">Graphic type…</option>
          {assets.filter((a) => !a.deleted_at).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button type="button" className="btn sm" disabled={r == null || !assetId} onClick={() => void act(() => backend.setMoveRule(turn.id, { asset_id: assetId }, r))}>Apply to type</button>
      </div>
    </Section>
  );
}


function Allocations({ backend, turn, act }: { backend: Backend; turn: Turn; act: Act }) {
  const allocations = useEd((s) => s.bundle!.allocations);
  const drafts = useEd((s) => s.bundle!.drafts);
  const players = useEd((s) => s.players);
  const assets = useEd((s) => s.assets);
  const map = useEd((s) => s.map);
  const symbolDraft = useEd((s) => s.symbolDraft);
  const selection = useEd((s) => s.selection);
  const features = useEd((s) => s.features);
  const [who, setWho] = useState('');
  const [what, setWhat] = useState('');
  const [name, setName] = useState('');
  const [qty, setQty] = useState(1);
  const [sizeM, setSizeM] = useState('');
  const [zone, setZone] = useState<Zone>(null);

  const teams = [...new Set(players.map((p) => p.team).filter(Boolean))];
  const palette = new Set(map?.palette_assets ?? []);
  const offered = assets.filter((a) => !a.deleted_at && (palette.size === 0 || palette.has(a.id)));
  const sidc = buildSidc(symbolDraft);
  const picked = features.find((f) => f.id === selection[0]);
  const pickedZone = picked ? zoneFromFeature(picked) : null;

  /** Who has drafted units out of an allocation, e.g. "Alice ×2, Bob ×1". */
  const holders = (a: Allocation) => {
    const out: string[] = [];
    for (const d of drafts) {
      const n = effectiveChanges(d).filter((c) => c.op === 'create' && c.payload.allocation_id === a.id).length;
      if (n) out.push(`${players.find((p) => p.id === d.player_id)?.name ?? '?'} ×${n}`);
    }
    return out;
  };

  const add = () =>
    act(async () => {
      const target = who.startsWith('team:') ? { team: who.slice(5) } : { player_id: who };
      const unit = what === 'symbol' ? { sidc } : { asset_id: what };
      const props = { ...(name.trim() ? { name: name.trim() } : {}), ...(what !== 'symbol' ? (sizeM ? { sizeMode: 'm' as const, sizeM: +sizeM } : { sizeMode: 'px' as const, sizePx: 64 }) : { sizePx: 34 }) };
      await backend.saveAllocation(turn.id, { ...target, ...unit, props, quantity: qty, zone });
      setName('');
      setZone(null);
    });

  return (
    <Section title="Reinforcements">
      {allocations.length === 0 ? (
        <p className="empty">None this turn. An allocation lets a player (or a team, as a shared pool) place new units.</p>
      ) : (
        <ul className="changes">
          {allocations.map((a) => {
            const asset = assets.find((x) => x.id === a.asset_id);
            const held = holders(a);
            return (
              <li key={a.id}>
                <div className="row">
                  <img className="mini" src={asset ? backend.assetUrl(asset) : symbolDataUrl(a.sidc ?? '', 20)} alt="" />
                  <span>
                    <strong>{a.quantity} × {a.props.name || asset?.name || 'unit'}</strong> for {a.player_id ? players.find((p) => p.id === a.player_id)?.name ?? '?' : `team ${a.team}`}
                    <small> · {zoneText(a.zone)}{held.length ? ` · held by ${held.join(', ')}` : ' · none placed'}</small>
                  </span>
                  <IconButton icon="x" title="Remove allocation" onClick={() => void act(() => backend.deleteAllocation(a.id))} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <h4>Add</h4>
      <div className="row2">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="For">
          <option value="">For…</option>
          {players.filter((p) => !p.revoked).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {teams.map((t) => <option key={t} value={`team:${t}`}>Team {t} (shared pool)</option>)}
        </select>
        <select value={what} onChange={(e) => setWhat(e.target.value)} aria-label="Unit">
          <option value="">Unit…</option>
          {map?.palette_symbols !== false && <option value="symbol">NATO symbol (as set in the symbol tool)</option>}
          {offered.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="row2">
        <Field label="Quantity"><input type="number" min={1} max={500} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(500, +e.target.value || 1)))} /></Field>
        <Field label="Name (optional)"><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      {what && what !== 'symbol' && (
        <Field label="True length in metres (blank = fixed 64 px)" wide>
          <input type="number" min={1} max={100000} value={sizeM} onChange={(e) => setSizeM(e.target.value)} />
        </Field>
      )}
      {what === 'symbol' && <p className="tip"><img className="mini" src={symbolDataUrl(sidc, 20)} alt="" /> Change it with the symbol tool (S), then come back here.</p>}
      <div className="row2 wrap">
        <small>Placement zone: <strong>{zoneText(zone)}</strong></small>
        <button type="button" className="btn sm" disabled={!pickedZone} title="Draw a polygon or a circle on the map, select it, then click here" onClick={() => setZone(pickedZone)}>Use selected shape</button>
        {zone && <button type="button" className="btn sm" onClick={() => setZone(null)}>Anywhere</button>}
      </div>
      <p className="tip">Draw the zone with the polygon (P) or circle (C) tool, select it, then "Use selected shape". The shape itself can be deleted afterwards or kept on a hidden layer.</p>
      <button type="button" className="btn primary" disabled={!who || !what} onClick={() => void add()}>Add allocation</button>
    </Section>
  );
}

function Drafts({ backend, turn, act }: { backend: Backend; turn: Turn; act: Act }) {
  const bundle = useEd((s) => s.bundle!);
  const players = useEd((s) => s.players);
  const features = useEd((s) => s.features);
  const review = useEd((s) => s.review);
  const [open, setOpen] = useState<string | null>(null);
  const live = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const byPlayer = new Map(bundle.drafts.map((d) => [d.player_id, d]));
  const seats = players.filter((p) => !p.revoked);
  const conflicts = useMemo(
    () => findConflicts(features, bundle.drafts.map((d) => ({ player_id: d.player_id, changes: effectiveChanges(d) })), turn.conflict_m),
    [features, bundle.drafts, turn.conflict_m],
  );
  const label = (id: string) => {
    for (const d of bundle.drafts) {
      const c = (d.owner_changes ?? d.changes).find((x) => x.feature_id === id);
      if (c?.op === 'create') return c.payload.props?.name || `new ${c.payload.kind}`;
    }
    return nameOf(live.get(id));
  };
  const st = useEd.getState;
  const costLine = (d: Draft) => {
    const c = draftCost(d.owner_changes ?? d.changes, bundle.economy.items, d.rejected);
    return c.spawn || c.research ? ` · spends ${[c.spawn && `${fmtPts(c.spawn)} spawn`, c.research && `${fmtPts(c.research)} research`].filter(Boolean).join(', ')}` : '';
  };

  return (
    <>
      <Section title={`Drafts (${bundle.drafts.filter((d) => d.ready).length} ready of ${seats.length})`}>
        {seats.length === 0 && <p className="empty">No players yet.</p>}
        <ul className="subs">
          {seats.map((p) => {
            const d = byPlayer.get(p.id);
            const n = d ? (d.owner_changes ?? d.changes).length : 0;
            return (
              <li key={p.id} className={open === p.id ? 'on' : ''}>
                <button type="button" onClick={() => { st().setReview(null); setOpen(open === p.id ? null : p.id); }}>
                  <span className="who">
                    <Chip p={p} /> <strong>{p.name}</strong>{p.team && <em>{p.team}</em>}
                    <span className={`tag ${d?.ready ? 'ok' : n ? 'warn' : ''}`}>{d?.ready ? 'ready' : n ? 'not ready' : 'nothing yet'}</span>
                    <time>{d && n ? ago(d.updated_at) : `seen ${ago(p.last_seen_at)}`}</time>
                  </span>
                  <span className="what">{d && n ? summarize(effectiveChanges(d)) : 'Stays put'}{d && n ? costLine(d) : ''}{d?.rejected.length ? ` · ${d.rejected.length} rejected` : ''}{d?.owner_changes ? ' · edited by you' : ''}</span>
                </button>
                {open === p.id && <DraftDetail backend={backend} turn={turn} player={p} draft={d} act={act} editing={review?.playerId === p.id} live={live} />}
              </li>
            );
          })}
        </ul>
      </Section>
      {turn.conflict_m != null && (
        <Section title={`Conflicts (${conflicts.length})`}>
          {conflicts.length === 0 ? (
            <p className="empty">No units end the turn within {fmtDist(turn.conflict_m)} of another player's unit.</p>
          ) : (
            <ul className="changes">
              {conflicts.map((c) => (
                <li key={c.a + c.b}><div className="row"><span><span className="tag bad">{fmtDist(c.distance)}</span> {label(c.a)} and {label(c.b)}</span></div></li>
              ))}
            </ul>
          )}
          <p className="tip">Marked on the map with red dotted rings.</p>
        </Section>
      )}
    </>
  );
}

function DraftDetail(p: { backend: Backend; turn: Turn; player: Player; draft?: Draft; act: Act; editing: boolean; live: Map<string, Feature> }) {
  const { backend, turn, player, draft, act, editing, live } = p;
  const allocations = useEd((s) => s.bundle!.allocations);
  const economy = useEd((s) => s.bundle!.economy);
  const changes = draft ? draft.owner_changes ?? draft.changes : [];
  const bal = economy.players.find((e) => e.id === player.id);
  const cost = draftCost(changes, economy.items, draft?.rejected ?? []);
  const rejected = new Set(draft?.rejected ?? []);
  const review = (patch: Parameters<Backend['reviewDraft']>[2]) => act(() => backend.reviewDraft(turn.id, player.id, patch));
  const toggle = (id: string) => review({ rejected: toggleRejected(changes, [...rejected], id) });

  return (
    <div className="draft">
      {changes.length === 0 ? (
        <p className="empty">No changes in this draft.</p>
      ) : (
        <ul className="changes">
          {changes.map((c) => {
            const alloc = c.op === 'create' ? allocations.find((a) => a.id === c.payload.allocation_id) : undefined;
            return (
              <li key={c.feature_id} className={rejected.has(c.feature_id) ? 'off' : ''}>
                <label className="row">
                  <input type="checkbox" checked={!rejected.has(c.feature_id)} onChange={() => void toggle(c.feature_id)} aria-label="Accept this change" />
                  <span>
                    {describeChange(c, live, economy.items)}
                    {alloc && <small> · from {alloc.team ? `team ${alloc.team} pool` : 'own allocation'}</small>}
                    {c.op === 'update' && c.payload.order && <small> · “{c.payload.order}”</small>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {bal && (
        <p className="points">
          <span>Spawn <b className={cost.spawn > bal.spawn_points ? 'neg' : ''}>{fmtPts(cost.spawn)}</b> of {fmtPts(bal.spawn_points)}</span>
          <span>Research <b className={cost.research > bal.research_points ? 'neg' : ''}>{fmtPts(cost.research)}</b> of {fmtPts(bal.research_points)}</span>
          <span>Income +{fmtPts(bal.income.spawn)} / +{fmtPts(bal.income.research)}</span>
        </p>
      )}
      <p className="tip">Untick a change to reject it. A rejected placement goes back into its allocation; a rejected purchase or research costs nothing.</p>
      <div className="row2 wrap">
        <button type="button" className={`btn sm${editing ? ' on' : ''}`} disabled={!changes.length} onClick={() => useEd.getState().setReview(editing ? null : player.id)}>
          {editing ? 'Done editing' : 'Edit on map'}
        </button>
        {draft?.owner_changes && <button type="button" className="btn sm" onClick={() => void review({ owner_changes: null })}>Undo my edits</button>}
        <button type="button" className="btn sm danger" disabled={!changes.length} onClick={() => confirm(`Clear ${player.name}'s draft? They would have to redo it.`) && void review({ clear: true })}>Clear draft</button>
      </div>
      {editing && <p className="tip">Drag this player's ghosts on the map. Your version replaces theirs in the push; movement radius and zones do not apply to your edits.</p>}
      <Field label="Note to this player (shown after the push)" wide>
        <textarea rows={2} maxLength={1000} key={draft?.owner_note ?? ''} defaultValue={draft?.owner_note ?? ''} onBlur={(e) => e.target.value !== (draft?.owner_note ?? '') && void review({ owner_note: e.target.value })} />
      </Field>
      <button type="button" className={`btn ${draft?.ready ? '' : 'primary'}`} onClick={() => void review({ ready: !draft?.ready })}>
        {draft?.ready ? 'Set aside (do not apply)' : 'Mark ready (apply on push)'}
      </button>
    </div>
  );
}
