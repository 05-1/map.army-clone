import { useEffect, useState } from 'react';
import { ago } from '../lib/submissions';
import type { MapMeta, Player } from '../lib/types';
import { playUrl } from '../lib/urls';
import type { Backend, NewPlayer } from './backend';
import { useEd } from './store';
import { ColorPicker, Field, Icon, IconButton } from './ui';

const BLANK: NewPlayer = { name: '', team: '', color: '#0a84ff', visibleLayers: null, targetLayerId: null };

function status(p: Player): { text: string; cls: string } {
  if (p.revoked) return { text: 'Revoked', cls: 'bad' };
  if (p.pin_locked_until && new Date(p.pin_locked_until) > new Date()) return { text: 'PIN locked', cls: 'bad' };
  if (p.claimed_at) return { text: `Seen ${ago(p.last_seen_at)}`, cls: 'ok' };
  return { text: 'Invite not opened', cls: '' };
}

function LayerPicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const layers = useEd((s) => s.layers);
  const sorted = [...layers].sort((a, b) => b.z - a.z);
  const picked = new Set(value ?? []);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : layers.map((l) => l.id))} />
        Sees every layer, including ones added later
      </label>
      {value !== null && (
        <div className="picks">
          {sorted.map((l) => (
            <label key={l.id} className="check">
              <input
                type="checkbox" checked={picked.has(l.id)}
                onChange={(e) => {
                  const n = new Set(picked);
                  if (e.target.checked) n.add(l.id);
                  else n.delete(l.id);
                  onChange([...n]);
                }}
              />
              {l.name}
              {!l.visible && <em> (hidden in editor, so hidden from everyone)</em>}
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/** Name, team, colour, visible layers and target layer. Used for new invites and for editing one. */
function PlayerForm({ value, onChange }: { value: NewPlayer; onChange: (v: NewPlayer) => void }) {
  const layers = useEd((s) => s.layers);
  const set = (p: Partial<NewPlayer>) => onChange({ ...value, ...p });
  return (
    <>
      <div className="row2">
        <Field label="Display name"><input value={value.name} maxLength={60} placeholder="e.g. Alex" onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Team / affiliation"><input value={value.team} maxLength={40} placeholder="e.g. Blue" onChange={(e) => set({ team: e.target.value })} /></Field>
      </div>
      <Field label="Colour (their drafts are drawn in it)" wide>
        <ColorPicker value={value.color ?? ''} onChange={(color) => set({ color })} />
      </Field>
      <LayerPicker value={value.visibleLayers} onChange={(visibleLayers) => set({ visibleLayers })} />
      <Field label="Their new units go on layer" wide>
        <select value={value.targetLayerId ?? ''} onChange={(e) => set({ targetLayerId: e.target.value || null })}>
          <option value="">Top visible layer</option>
          {[...layers].sort((a, b) => b.z - a.z).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
    </>
  );
}

export function PlayersDialog(p: { backend: Backend; map: MapMeta; settle: () => Promise<void>; onClose: () => void }) {
  const { backend, map, onClose } = p;
  const players = useEd((s) => s.players);
  const features = useEd((s) => s.features);
  const layers = useEd((s) => s.layers);
  const [draft, setDraft] = useState<NewPlayer>(BLANK);
  const [editing, setEditing] = useState<{ id: string; v: NewPlayer } | null>(null);
  const [pinFor, setPinFor] = useState<{ id: string; pin: string } | null>(null);
  const [teamVis, setTeamVis] = useState<{ team: string; layers: string[] | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      useEd.setState({ players: await backend.listPlayers(map.id) });
      backend.ping(map);
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

  const copy = async (pl: Player) => {
    await navigator.clipboard.writeText(playUrl(pl.invite_token));
    setCopied(pl.id);
    setTimeout(() => setCopied(''), 1500);
  };

  const create = () =>
    run(async () => {
      await p.settle(); // layer ids in the invite must already exist in the database
      const made = await backend.createPlayer(map.id, { ...draft, name: draft.name.trim(), team: draft.team.trim() });
      setDraft({ ...BLANK, team: draft.team, color: draft.color });
      await copy(made).catch(() => {});
    });

  const save = () =>
    editing &&
    run(async () => {
      await p.settle();
      const v = editing.v;
      await backend.updatePlayer(editing.id, { name: v.name.trim(), team: v.team.trim(), color: v.color, visible_layers: v.visibleLayers, target_layer_id: v.targetLayerId });
      setEditing(null);
    });

  const units = (id: string) => features.filter((f) => f.owner_player_id === id).length;
  const layerNames = (pl: Player) =>
    pl.visible_layers === null ? 'all layers' : pl.visible_layers.map((id) => layers.find((l) => l.id === id)?.name).filter(Boolean).join(', ') || 'no layers';
  const teams = [...new Set(players.map((x) => x.team).filter(Boolean))];

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Players" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide">
        <header>
          <h2>Players on "{map.name}"</h2>
          <IconButton icon="x" title="Close" onClick={onClose} />
        </header>

        <div className="newlink">
          <h4>New invite</h4>
          <PlayerForm value={draft} onChange={setDraft} />
          <button type="button" className="btn primary" disabled={busy || !draft.name.trim() || draft.visibleLayers?.length === 0} onClick={() => void create()}>
            <Icon name="plus" /> Create invite and copy link
          </button>
        </div>

        {error && <p className="note bad" role="alert">{error}</p>}

        <h4>Players</h4>
        {players.length === 0 ? (
          <p className="empty">No players yet. Each invite link is one seat. The link is the key: opening it on another device moves the seat there.</p>
        ) : (
          <ul className="links">
            {players.map((pl) => {
              const s = status(pl);
              const locked = !!pl.pin_locked_until && new Date(pl.pin_locked_until) > new Date();
              return (
                <li key={pl.id} className={`${s.cls}${editing?.id === pl.id || pinFor?.id === pl.id ? ' open' : ''}`}>
                  <div>
                    <strong><i className="chip" style={{ background: pl.color ?? '#8794a4' }} aria-hidden /> {pl.name}</strong>
                    {pl.team && <span className="tag">{pl.team}</span>}
                    <span className={`tag ${s.cls}`}>{s.text}</span>
                    {pl.pin_set && <span className="tag">PIN</span>}
                    <small>{units(pl.id)} unit{units(pl.id) === 1 ? '' : 's'} assigned · sees {layerNames(pl)}</small>
                  </div>
                  <button type="button" className="btn sm" onClick={() => void copy(pl)} disabled={pl.revoked}>
                    <Icon name="copy" size={14} /> {copied === pl.id ? 'Copied' : 'Copy link'}
                  </button>
                  <button
                    type="button" className="btn sm"
                    onClick={() => setEditing(editing?.id === pl.id ? null : { id: pl.id, v: { name: pl.name, team: pl.team, color: pl.color, visibleLayers: pl.visible_layers, targetLayerId: pl.target_layer_id } })}
                  >
                    Edit
                  </button>
                  <button type="button" className="btn sm" onClick={() => setPinFor(pinFor?.id === pl.id ? null : { id: pl.id, pin: '' })}>PIN</button>
                  {locked && <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => backend.clearPinLockout(pl.id))}>Unlock PIN</button>}
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => backend.updatePlayer(pl.id, { revoked: !pl.revoked }))}>
                    {pl.revoked ? 'Restore' : 'Revoke'}
                  </button>
                  <button
                    type="button" className="btn sm" disabled={busy}
                    title="Issue a new link. The old link stops working and the browser using it is signed out of the seat."
                    onClick={() => confirm(`Regenerate the link for ${pl.name}? The current link stops working.`) && void run(() => backend.resetInvite(pl.id).then((n) => copy(n).catch(() => {})))}
                  >
                    New link
                  </button>
                  {pinFor?.id === pl.id && (
                    <div className="edit">
                      <Field label="4-digit PIN. The player types it once per device. Blank removes it." wide>
                        <input inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={pinFor.pin} placeholder={pl.pin_set ? 'PIN is set; type a new one to change it' : 'e.g. 4821'} onChange={(e) => setPinFor({ id: pl.id, pin: e.target.value.replace(/\D/g, '') })} />
                      </Field>
                      <div className="row2">
                        <button type="button" className="btn primary" disabled={busy || pinFor.pin.length !== 4} onClick={() => void run(() => backend.setPin(pl.id, pinFor.pin).then(() => setPinFor(null)))}>Set PIN</button>
                        <button type="button" className="btn" disabled={busy || !pl.pin_set} onClick={() => void run(() => backend.setPin(pl.id, null).then(() => setPinFor(null)))}>Remove PIN</button>
                      </div>
                      <p className="tip">Five wrong tries lock the seat for 15 minutes. The PIN is stored hashed and cannot be read back.</p>
                    </div>
                  )}
                  {editing?.id === pl.id && (
                    <div className="edit">
                      <PlayerForm value={editing.v} onChange={(v) => setEditing({ id: pl.id, v })} />
                      <button type="button" className="btn primary" disabled={busy || !editing.v.name.trim()} onClick={() => void save()}>Save</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {teams.length > 0 && (
          <>
            <h4>Layer visibility for a whole team</h4>
            <div className="row2">
              <select value={teamVis?.team ?? ''} onChange={(e) => setTeamVis(e.target.value ? { team: e.target.value, layers: null } : null)} aria-label="Team">
                <option value="">Choose a team…</option>
                {teams.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button type="button" className="btn" disabled={busy || !teamVis} onClick={() => teamVis && void run(() => p.settle().then(() => backend.setTeamVisibility(map.id, teamVis.team, teamVis.layers)))}>
                Apply to every player on the team
              </button>
            </div>
            {teamVis && <LayerPicker value={teamVis.layers} onChange={(l) => setTeamVis({ ...teamVis, layers: l })} />}
          </>
        )}
        <p className="tip">
          Assign units by selecting them on the map (shift-click or box-select for several) and choosing "Assigned to" in the properties panel.
          Layer limits also apply to old turns in the history slider.
        </p>
      </div>
    </div>
  );
}
