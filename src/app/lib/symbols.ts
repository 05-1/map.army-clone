// A curated slice of MIL-STD-2525C letter SIDCs. Anything outside it can be entered as a raw SIDC
// (letter-based or 2525D/APP-6D number-based); milsymbol renders both.

export const AFFILIATIONS = [
  { code: 'F', label: 'Friend', color: '#80e0ff' },
  { code: 'H', label: 'Hostile', color: '#ff8080' },
  { code: 'N', label: 'Neutral', color: '#aaffaa' },
  { code: 'U', label: 'Unknown', color: '#ffff80' },
] as const;

export const ECHELONS: [string, string][] = [
  ['-', 'None'], ['A', 'Team / Crew'], ['B', 'Squad'], ['C', 'Section'], ['D', 'Platoon'], ['E', 'Company'],
  ['F', 'Battalion'], ['G', 'Regiment'], ['H', 'Brigade'], ['I', 'Division'], ['J', 'Corps'], ['K', 'Army'],
  ['L', 'Army group'], ['M', 'Region'],
];

export const MODIFIERS: [string, string][] = [
  ['-', 'None'], ['A', 'Headquarters'], ['E', 'Task force'], ['B', 'Task force HQ'], ['F', 'Feint / dummy'],
];

export interface SymbolDef {
  name: string;
  dim: string; // battle dimension, SIDC position 3
  fn: string; // function id, positions 5-10
}

export const CATALOG: { group: string; items: SymbolDef[] }[] = [
  {
    group: 'Infantry, armor, artillery',
    items: [
      { name: 'Infantry', dim: 'G', fn: 'UCI---' },
      { name: 'Mechanized infantry', dim: 'G', fn: 'UCIZ--' },
      { name: 'Motorized infantry', dim: 'G', fn: 'UCIM--' },
      { name: 'Light infantry', dim: 'G', fn: 'UCIL--' },
      { name: 'Airborne infantry', dim: 'G', fn: 'UCIA--' },
      { name: 'Air assault infantry', dim: 'G', fn: 'UCIS--' },
      { name: 'Armor', dim: 'G', fn: 'UCA---' },
      { name: 'Anti-armor', dim: 'G', fn: 'UCAA--' },
      { name: 'Reconnaissance', dim: 'G', fn: 'UCR---' },
      { name: 'Armored cavalry', dim: 'G', fn: 'UCRVA-' },
      { name: 'Field artillery', dim: 'G', fn: 'UCF---' },
      { name: 'Rocket artillery', dim: 'G', fn: 'UCFR--' },
      { name: 'Mortar', dim: 'G', fn: 'UCFM--' },
      { name: 'Air defense', dim: 'G', fn: 'UCD---' },
    ],
  },
  {
    group: 'Support and command',
    items: [
      { name: 'Unit (generic)', dim: 'G', fn: 'U-----' },
      { name: 'Engineer', dim: 'G', fn: 'UCE---' },
      { name: 'Army aviation, rotary', dim: 'G', fn: 'UCVR--' },
      { name: 'Army aviation, fixed', dim: 'G', fn: 'UCVF--' },
      { name: 'Signal', dim: 'G', fn: 'UUS---' },
      { name: 'Military intelligence', dim: 'G', fn: 'UUM---' },
      { name: 'Supply', dim: 'G', fn: 'USS---' },
      { name: 'Maintenance', dim: 'G', fn: 'USX---' },
      { name: 'Medical', dim: 'G', fn: 'USM---' },
      { name: 'Transportation', dim: 'G', fn: 'UST---' },
      { name: 'Special operations', dim: 'F', fn: 'G-----' },
    ],
  },
  {
    group: 'Air',
    items: [
      { name: 'Fixed wing', dim: 'A', fn: 'MF----' },
      { name: 'Fighter', dim: 'A', fn: 'MFF---' },
      { name: 'Bomber', dim: 'A', fn: 'MFB---' },
      { name: 'Attack', dim: 'A', fn: 'MFA---' },
      { name: 'Cargo', dim: 'A', fn: 'MFC---' },
      { name: 'UAV', dim: 'A', fn: 'MFQ---' },
      { name: 'Rotary wing', dim: 'A', fn: 'MH----' },
      { name: 'Attack helicopter', dim: 'A', fn: 'MHA---' },
    ],
  },
  {
    group: 'Sea',
    items: [
      { name: 'Surface combatant', dim: 'S', fn: 'C-----' },
      { name: 'Carrier', dim: 'S', fn: 'CLCV--' },
      { name: 'Cruiser', dim: 'S', fn: 'CLCC--' },
      { name: 'Destroyer', dim: 'S', fn: 'CLDD--' },
      { name: 'Frigate', dim: 'S', fn: 'CLFF--' },
      { name: 'Amphibious', dim: 'S', fn: 'CA----' },
      { name: 'Non-combatant', dim: 'S', fn: 'N-----' },
      { name: 'Submarine', dim: 'U', fn: 'S-----' },
      { name: 'Submarine, nuclear', dim: 'U', fn: 'SN----' },
      { name: 'Submarine, conventional', dim: 'U', fn: 'SC----' },
    ],
  },
];

export interface SymbolDraft {
  aff: string;
  status: 'P' | 'A'; // present / anticipated (planned)
  dim: string;
  fn: string;
  mod: string;
  ech: string;
  raw: string; // overrides everything else when non-empty
}

export const DEFAULT_DRAFT: SymbolDraft = { aff: 'F', status: 'P', dim: 'G', fn: 'UCI---', mod: '-', ech: '-', raw: '' };

export function buildSidc(d: SymbolDraft): string {
  if (d.raw.trim()) return d.raw.trim().toUpperCase();
  // Echelon and HQ/TF modifiers only apply to land units.
  const land = d.dim === 'G' || d.dim === 'F';
  return `S${d.aff}${d.dim}${d.status}${d.fn}${land ? d.mod : '-'}${land ? d.ech : '-'}---`;
}

/** True for 2525C-style letter SIDCs, whose fields we can edit by position. */
export const isLetterSidc = (sidc: string) => /^[A-Z][A-Z*-]{9,14}$/i.test(sidc);

export function setSidcChar(sidc: string, index: number, ch: string): string {
  const s = sidc.padEnd(15, '-');
  return s.slice(0, index) + ch + s.slice(index + 1);
}
