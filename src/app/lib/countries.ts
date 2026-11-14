import type { Zone } from './types';

export interface Country { name: string; geometry: Extract<Zone, { type: 'MultiPolygon' }> }
let countries: Promise<Country[]> | null = null;
/** Natural Earth 1:50m borders, shipped with the site and fetched only when needed (about 1.7 MB). */
export const loadCountries = () => (countries ??= fetch(new URL('countries.json', document.baseURI)).then((r) => {
  if (!r.ok) throw new Error(`Could not load the country list (HTTP ${r.status})`);
  return r.json() as Promise<Country[]>;
}).catch((e) => { countries = null; throw e; }));
