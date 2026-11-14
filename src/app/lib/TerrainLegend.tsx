import { TERRAIN_COLORS, TERRAIN_CREDIT } from './terrain';

/** Legend for the terrain overlay, with the defender multiplier for each type when known. */
export function TerrainLegend({ multipliers, empty }: { multipliers?: Record<string, number>; empty?: boolean }) {
  const row = (t: 'urban' | 'forest' | 'open', label: string) => (
    <li key={t}>
      <i className="chip" style={{ background: TERRAIN_COLORS[t], opacity: t === 'open' ? 0.35 : 0.8 }} aria-hidden /> {label}
      {multipliers?.[t] != null && <small> · damage taken ×{multipliers[t]}</small>}
    </li>
  );
  return (
    <div className="terrainlegend" role="note" aria-label="Terrain legend">
      <strong>Terrain</strong>
      {empty ? <small>No terrain has been generated for this map yet.</small> : (
        <ul>{row('urban', 'Urban (large cities)')}{row('forest', 'Forest (large forests)')}{row('open', 'Open (everything else)')}</ul>
      )}
      <small className="credit">{TERRAIN_CREDIT}</small>
    </div>
  );
}
