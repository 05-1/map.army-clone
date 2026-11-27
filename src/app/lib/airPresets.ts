// Starting points for the owner's Air window, from public figures (rounded). Everything is editable after.
//
// Ranges: "radius" is the empty combat radius (the payload penalty takes it down with weight); "speed" is how
// far the aircraft can fly in one turn, taken as its ferry range, so on a large map it can rebase across a
// theatre in one move while the radius rule still brings it home. Signature scales radar detection range:
// with the radar equation detection grows with the fourth root of the radar cross-section, so 1 is a
// 4th-generation fighter (~1 m²), 0.25 a stealth fighter (~0.005 m²), 3 a bomber or tanker (~100 m²).
import type { AirGuidance, Airframe, AirWeapon } from './types';

export type AirframePreset = Omit<Airframe, 'id' | 'role_id' | 'families' | 'asset_id' | 'deleted_at' | 'tanker'> & { role: string };

const fighter = { hp: 100, landed_armor: 0, refuelable: true, gun_accuracy: 40, gun_damage: 40, gun_range_m: 1200, squadron_size: 12, cost_per_aircraft: 10, sidc: 'SFAPMF---------' };
const heavy = { landed_armor: 0, refuelable: true, gun_accuracy: 0, gun_damage: 0, gun_range_m: 0, cost_per_aircraft: 30 };

export const AIRFRAME_PRESETS: AirframePreset[] = [
  { ...fighter, name: 'F-16C Block 50', role: 'Multirole', speed_m: 4200000, radius_m: 900000, payload_penalty: 0.4, hardpoints: 9, max_payload: 7700,
    radar_m: 110000, signature: 1, ecm: 20, flares: 20, maneuver: 30 },
  { ...fighter, name: 'F-35A', role: 'Multirole', speed_m: 2800000, radius_m: 1300000, payload_penalty: 0.3, hardpoints: 10, max_payload: 8100,
    radar_m: 150000, signature: 0.25, ecm: 35, flares: 25, maneuver: 25, cost_per_aircraft: 18 },
  { ...fighter, name: 'F-15C', role: 'Fighter', speed_m: 5500000, radius_m: 1300000, payload_penalty: 0.4, hardpoints: 8, max_payload: 7300,
    radar_m: 160000, signature: 2, ecm: 25, flares: 20, maneuver: 35, cost_per_aircraft: 12 },
  { ...fighter, name: 'F-22A', role: 'Fighter', speed_m: 3000000, radius_m: 850000, payload_penalty: 0.3, hardpoints: 8, max_payload: 2300,
    radar_m: 200000, signature: 0.2, ecm: 40, flares: 30, maneuver: 45, cost_per_aircraft: 22 },
  { ...fighter, name: 'Su-35S', role: 'Fighter', speed_m: 4500000, radius_m: 1500000, payload_penalty: 0.4, hardpoints: 12, max_payload: 8000,
    radar_m: 200000, signature: 1.8, ecm: 25, flares: 25, maneuver: 45, cost_per_aircraft: 11 },
  { ...fighter, name: 'MiG-29', role: 'Fighter', speed_m: 2100000, radius_m: 700000, payload_penalty: 0.4, hardpoints: 7, max_payload: 4000,
    radar_m: 80000, signature: 1.5, ecm: 15, flares: 20, maneuver: 40, cost_per_aircraft: 7 },
  { ...heavy, name: 'B-52H', role: 'Bomber', hp: 300, speed_m: 14000000, radius_m: 7200000, payload_penalty: 0.2, hardpoints: 20, max_payload: 31500,
    radar_m: 50000, signature: 3, ecm: 30, flares: 15, maneuver: 5, squadron_size: 12, sidc: 'SFAPMB---------' },
  { ...heavy, name: 'B-1B', role: 'Bomber', hp: 250, speed_m: 12000000, radius_m: 5500000, payload_penalty: 0.2, hardpoints: 24, max_payload: 34000,
    radar_m: 100000, signature: 1, ecm: 35, flares: 20, maneuver: 10, squadron_size: 12, sidc: 'SFAPMB---------' },
  { ...heavy, name: 'B-2A', role: 'Bomber', hp: 250, speed_m: 11000000, radius_m: 5000000, payload_penalty: 0.2, hardpoints: 16, max_payload: 18000,
    radar_m: 80000, signature: 0.15, ecm: 30, flares: 15, maneuver: 5, squadron_size: 8, cost_per_aircraft: 60, sidc: 'SFAPMB---------' },
  { ...heavy, name: 'Tu-160', role: 'Bomber', hp: 250, speed_m: 12300000, radius_m: 6000000, payload_penalty: 0.2, hardpoints: 12, max_payload: 40000,
    radar_m: 100000, signature: 3, ecm: 30, flares: 20, maneuver: 10, squadron_size: 8, sidc: 'SFAPMB---------' },
  { ...heavy, name: 'KC-135R', role: 'Tanker', refuelable: false, hp: 250, speed_m: 17000000, radius_m: 2400000, payload_penalty: 0, hardpoints: 0, max_payload: 0,
    radar_m: 0, signature: 3.5, ecm: 10, flares: 10, maneuver: 0, squadron_size: 4, cost_per_aircraft: 20, sidc: 'SFAPMKT--------' },
  { ...heavy, name: 'KC-46A', role: 'Tanker', refuelable: true, hp: 250, speed_m: 11800000, radius_m: 2800000, payload_penalty: 0, hardpoints: 0, max_payload: 0,
    radar_m: 0, signature: 3.5, ecm: 15, flares: 15, maneuver: 0, squadron_size: 4, cost_per_aircraft: 24, sidc: 'SFAPMKT--------' },
];

export type MissilePreset = Omit<AirWeapon, 'id' | 'family_id' | 'tech_item_id' | 'research_cost' | 'release_turn' | 'deleted_at'> & { family: string; research_cost: number };

const m = (family: string, tier: number, name: string, guidance: AirGuidance, range_km: number, weight: number, accuracy: number, damage: number, ap: number,
  targets: AirWeapon['targets'], research_cost: number, slots = 1): MissilePreset =>
  ({ family, tier, name, guidance, range_m: range_km * 1000, weight, accuracy, damage, ap, targets, research_cost, slots });

/** Two or three tiers per standard family. Damage: 100 downs one 100-HP aircraft; ground units are around 1000 strength. */
export const MISSILE_PRESETS: MissilePreset[] = [
  m('IR', 1, 'AIM-9M Sidewinder', 'ir', 18, 86, 65, 100, 5, ['air'], 0),
  m('IR', 2, 'AIM-9X Sidewinder', 'ir', 35, 85, 80, 110, 5, ['air'], 15),
  m('ARH', 1, 'AIM-120C AMRAAM', 'radar', 105, 157, 70, 110, 5, ['air'], 0),
  m('ARH', 2, 'AIM-120D AMRAAM', 'radar', 160, 161, 78, 120, 5, ['air'], 20),
  m('ARH', 3, 'AIM-260 JATM', 'radar', 200, 160, 82, 120, 5, ['air'], 35),
  m('HARM', 1, 'AGM-88C HARM', 'harm', 150, 361, 70, 150, 20, ['radar'], 0),
  m('HARM', 2, 'AGM-88G AARGM-ER', 'harm', 300, 460, 80, 180, 25, ['radar'], 25),
  m('AGM', 1, 'AGM-65 Maverick', 'agm', 27, 300, 75, 200, 40, ['ground', 'ship'], 0),
  m('AGM', 2, 'AGM-158 JASSM', 'agm', 370, 1020, 85, 450, 60, ['ground', 'ship'], 20),
  m('AGM', 3, 'AGM-158B JASSM-ER', 'agm', 925, 1020, 85, 450, 60, ['ground', 'ship'], 35),
];
