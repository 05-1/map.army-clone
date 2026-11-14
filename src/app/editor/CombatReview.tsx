// Combat in the owner's review: resolve all combat for the turn (preview) without applying it, see every
// round and every shot with its base damage, multipliers and roll, hand-edit any number, re-roll one
// engagement or all of them. Push applies exactly the saved preview.
import { useEffect, useMemo, useState } from 'react';
import { newSalt, resolveCombat, type CombatInputs, type CombatResult, type Phase, type PreviewData } from '../lib/combat';
import type { Turn } from '../lib/types';
import type { Backend } from './backend';
import { useEd } from './store';
import { Section } from './ui';

interface Saved {
  data: PreviewData;
  result: CombatResult;
  stale: boolean;
}

/**
 * Make sure the turn has an up-to-date combat preview before a push: keep the saved one if nothing
 * changed, otherwise compute a fresh one (keeping salts, dropping hand edits that no longer apply).
 */
export async function ensureCombatPreview(backend: Backend, turnId: string): Promise<'none' | 'kept' | 'computed'> {
  const [saved, inputs] = await Promise.all([backend.getCombatPreview(turnId), backend.getCombatInputs(turnId)]);
  if (!inputs.units.length && !inputs.engagements.length) return 'none';
  if (saved && !saved.stale) return 'kept';
  const data: PreviewData = saved?.data ? { ...saved.data, edits: {} } : { salt: newSalt(), salts: {}, edits: {} };
  await backend.saveCombatPreview(turnId, data, resolveCombat(inputs, data));
  return 'computed';
}

export function CombatReview({ backend, turn }: { backend: Backend; turn: Turn }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const bundle = useEd((s) => s.bundle);

  const load = () => backend.getCombatPreview(turn.id).then((p) => setSaved(p), (e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    // Drafts or rejections changed: the saved preview may be stale now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn.id, bundle]);

  /** Recompute from fresh inputs with these salts and edits, save, show. */
  const compute = async (data: PreviewData) => {
    setBusy(true);
    setError('');
    try {
      const inputs: CombatInputs = await backend.getCombatInputs(turn.id);
      const result = resolveCombat(inputs, data);
      await backend.saveCombatPreview(turn.id, data, result);
      setSaved({ data, result, stale: false });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const data = saved?.data ?? { salt: newSalt(), salts: {}, edits: {} };
  const r = saved?.result;
  const changed = useMemo(() => r?.units.filter((u) => u.fired || u.hit || u.recovered > 0 || u.destroyed) ?? [], [r]);

  return (
    <Section title="Combat">
      <p className="tip">
        Resolves all combat on the final positions of the accepted drafts, without applying anything. Push applies exactly this result; if a draft,
        a rejection, a unit or a setting changes, it is recomputed first.
      </p>
      {error && <p className="note bad" role="alert">{error}</p>}
      <div className="row2 wrap">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void compute(data)}>{saved ? 'Resolve again' : 'Resolve combat (preview)'}</button>
        {saved && <button type="button" className="btn" disabled={busy} onClick={() => void compute({ salt: newSalt(), salts: {}, edits: {} })}>Re-roll all</button>}
        {saved && Object.keys(data.edits).length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void compute({ ...data, edits: {} })}>Undo hand edits ({Object.keys(data.edits).length})</button>}
      </div>
      {saved?.stale && <p className="note bad">Something changed since this preview. Resolve again (Push does it for you).</p>}
      {r && (
        <>
          {changed.length === 0 && !r.log.failed.length && <p className="empty">No combat this turn.</p>}
          {changed.length > 0 && (
            <table className="shots">
              <thead><tr><th>Unit</th><th>Strength</th><th>Exp.</th><th /></tr></thead>
              <tbody>
                {changed.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td className="num">{Math.round(u.before)} → {Math.round(u.after)} / {u.max}</td>
                    <td className="num">{u.experience}</td>
                    <td>{u.destroyed ? <span className="tag bad">destroyed</span> : u.recovered > 0 ? <span className="tag ok">+{Math.round(u.recovered)} recovered</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.log.indirect && <PhaseTable phase={r.log.indirect} data={data} busy={busy} onEdit={(d) => void compute(d)} />}
          {r.log.engagements.map((e) => (
            <div key={e.id} className="engcard">
              <header>
                <strong>{e.new ? 'New engagement' : `Engaged since turn ${e.start_turn}`}</strong>
                <span className={`tag ${e.status === 'active' ? 'warn' : ''}`}>{e.status === 'active' ? `${e.rounds.length} round${e.rounds.length === 1 ? '' : 's'}` : `ended: ${e.end_reason}`}</span>
                <span className="grow" />
                <button type="button" className="btn sm" disabled={busy} onClick={() => void compute({ ...data, salts: { ...data.salts, [e.id]: newSalt() } })}>Re-roll</button>
                <button type="button" className="btn sm" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide rounds' : 'Show rounds'}</button>
              </header>
              <small>{e.units.map((u) => r.units.find((x) => x.id === u.fid)?.name ?? u.fid.slice(0, 6)).join(', ')}{e.retreated.length ? ` · retreating: ${e.retreated.map((id) => r.units.find((x) => x.id === id)?.name).join(', ')}` : ''}</small>
              {open === e.id && (
                <>
                  {e.parting && <PhaseTable phase={e.parting} data={data} busy={busy} onEdit={(d) => void compute(d)} />}
                  {e.rounds.map((rd) => (
                    <div key={rd.n}>
                      <h4>Round {rd.n} <small>· {rd.damage} damage</small></h4>
                      {rd.phases.map((ph, i) => <PhaseTable key={i} phase={ph} data={data} busy={busy} onEdit={(d) => void compute(d)} />)}
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
          {r.log.failed.length > 0 && (
            <>
              <h4>Attacks that did not happen</h4>
              <ul className="changes">
                {r.log.failed.map((f, i) => <li key={i}><div className="row"><span>{f.attacker_name} ({f.weapon}) → {f.target_name}: <small>{f.reason}</small></span></div></li>)}
              </ul>
            </>
          )}
        </>
      )}
    </Section>
  );
}

function PhaseTable({ phase, data, busy, onEdit }: { phase: Phase; data: PreviewData; busy: boolean; onEdit(d: PreviewData): void }) {
  if (!phase.shots.length) return <p className="tip">{phase.label}: no weapon in range.</p>;
  return (
    <table className="shots">
      <caption><small>{phase.label}</small></caption>
      <thead><tr><th>Shot</th><th>Base</th><th>Multipliers</th><th>Damage</th></tr></thead>
      <tbody>
        {phase.shots.map((s) => (
          <tr key={s.key} className={s.edited ? 'edited' : ''}>
            <td>{s.attacker_name} <small className="mults">({s.weapon})</small> → {s.target_name}</td>
            <td className="num">{s.base.toFixed(1)}</td>
            <td className="mults">{s.mults.map(([n, v]) => `${n} ×${+v.toFixed(3)}`).join(' · ')}</td>
            <td className="num">
              <input
                type="number" min={0} disabled={busy} key={`${s.key}:${s.final}`} defaultValue={s.final} aria-label={`Damage of ${s.attacker_name} ${s.weapon} on ${s.target_name}`}
                title={s.edited ? `Hand-edited (computed ${s.computed})` : 'Type a number to override this shot'}
                onBlur={(e) => {
                  const v = Math.max(0, Math.round(+e.target.value));
                  if (v === s.final) return;
                  const edits = { ...data.edits };
                  if (v === s.computed) delete edits[s.key];
                  else edits[s.key] = v;
                  onEdit({ ...data, edits });
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
