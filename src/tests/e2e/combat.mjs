// End-to-end run of ground combat through the real UI and the real setup.sql (with PostGIS):
// weapons and templates -> sandbox -> settings -> terrain -> a player declares an attack ->
// owner previews, hand-edits a shot, pushes -> the other player reads the report.
//   node tests/e2e/combat.mjs <screenshot dir>
import { writeFileSync } from 'node:fs';
import { launch, B } from './lib.mjs';
const { sql } = await import('./fake-supabase.mjs');
const OUT = process.argv[2] ?? '.';
const { browser, open, errors } = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const wait = (p, ms = 700) => p.waitForTimeout(ms);
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
let failed = false;
let blue = null, red = null;
const step = async (name, fn) => { if (failed) return; try { await fn(); } catch (e) { failed = true; check(name, false, String(e.message).split('\n').slice(0, 4).join(' ').slice(0, 400)); for (const [p, n] of [[ed, 'editor'], [blue, 'blue'], [red, 'red']]) await p?.screenshot({ path: `${OUT}/fail-${n}.png` }).catch(() => {}); } };

const ed = await open();
let C;
const at = (dx, dy) => [C.x + dx, C.y + dy];
const UB = [-200, 60], UR = [-80, 60];
const dlg = () => ed.locator('.dialog');
const field = (label) => dlg().locator('label.field', { hasText: label }).locator('input, select, textarea').first();

await step('owner claims and places two tanks', async () => {
  await ed.goto(B + '/'); await wait(ed, 1200);
  await ed.fill('input[type=email]', 'owner@example.com'); await ed.fill('input[type=password]', 'correct horse battery');
  await ed.getByRole('button', { name: 'Create account' }).click(); await wait(ed, 1200);
  const claim = ed.getByRole('button', { name: /claim/i });
  if (await claim.count()) await claim.first().click();
  await ed.waitForSelector('.topbar', { timeout: 15000 }); await wait(ed, 2500);
  const box = await ed.locator('.stage').boundingBox(); C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await ed.keyboard.press('s'); await ed.mouse.click(...at(...UB)); await wait(ed, 250); await ed.mouse.click(...at(...UR)); await wait(ed, 250);
  await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 1500);
  check('two units on the map', (await sql('select count(*)::int n from public.features'))[0].n === 2);
});

await step('weapons and templates in the Combat window', async () => {
  await ed.getByRole('button', { name: 'Combat', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Weapons' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: 'New weapon' }).click();
  await field('Name').fill('120mm'); await field('Attacks').fill('100'); await field('AP').fill('28'); await field('Range').fill('9000');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Unit templates' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: 'New template' }).click();
  await field('Name').fill('MBT'); await field('Max strength').fill('1000'); await field('Armor').fill('25');
  await dlg().getByLabel('Add weapon').selectOption({ label: '120mm' });
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 900);
  const t = (await sql('select name, max_strength, armor, sidc, cardinality(weapon_ids) n from public.unit_templates'))[0];
  check('template saved, linked to the NATO symbol the units use, with its weapon', t?.name === 'MBT' && t.armor === 25 && !!t.sidc && t.n === 1, JSON.stringify(t));
  await shot(ed, 'c10-templates');
});

await step('sandbox shows the full breakdown', async () => {
  await dlg().getByRole('tab', { name: 'Sandbox' }).click(); await wait(ed, 300);
  await dlg().locator('.setgrp').first().locator('label.check', { hasText: 'Stationary' }).locator('input').check(); await wait(ed, 200);
  const dmg = await dlg().locator('.shots tbody td.num strong').first().innerText();
  check('120mm vs armor 25, attacker stationary, no variance: 113', dmg === '113', dmg);
  await shot(ed, 'c11-sandbox');
});

await step('settings are saved from the current turn', async () => {
  await dlg().getByRole('tab', { name: 'Settings' }).click(); await wait(ed, 300);
  await field('Recovery per turn').fill('20');
  await field('Intel range').fill('9000');   // the tanks are far apart at this zoom
  await dlg().getByRole('button', { name: /Save from turn/ }).click(); await wait(ed, 900);
  const s = (await sql('select from_turn, settings from public.combat_settings'))[0];
  check('settings version stored for turn 1', s?.from_turn === 1 && s.settings.recovery_pct === 20);
});

await step('terrain from an uploaded file: coverage and overlay', async () => {
  await dlg().getByRole('tab', { name: 'Terrain' }).click(); await wait(ed, 300);
  // The red tank sits in a big "city"; the test machine cannot reach the tile service, so use the file fallback.
  const [{ geometry: g }] = await sql(`select geometry from public.features order by z desc limit 1`);
  const [x, y] = g.coordinates;
  const file = `${OUT}/terrain.geojson`;
  writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { type: 'urban' },
    geometry: { type: 'Polygon', coordinates: [[[x - 1, y - 1], [x + 1, y - 1], [x + 1, y + 1], [x - 1, y + 1], [x - 1, y - 1]]] } }] }));
  await dlg().locator('input[type=file]').setInputFiles(file); await wait(ed, 3000);
  const z = await sql('select type, area_km2 from public.terrain_zones');
  const cover = await dlg().locator('.points').innerText();
  check('terrain zones stored with PostGIS and coverage shown', z.length >= 1 && z[0].type === 'urban' && /Open/.test(cover) && /Urban/.test(cover), cover.replace(/\s+/g, ' '));
  await shot(ed, 'c12-terrain');
  await ed.keyboard.press('Escape'); await wait(ed, 400);
  check('terrain overlay and legend on the map', (await ed.locator('.terrainlegend').count()) === 1);
});

await step('players, assignment, turn', async () => {
  await ed.getByRole('button', { name: 'Players', exact: true }).click(); await wait(ed);
  for (const [n, t] of [['Blue', 'Blue'], ['Red', 'Red']]) {
    await ed.getByPlaceholder('e.g. Alex').fill(n); await ed.getByPlaceholder('e.g. Blue').fill(t);
    await ed.locator('.dialog .btn.primary').first().click(); await wait(ed, 900);
  }
  await ed.keyboard.press('Escape'); await wait(ed, 300);
  for (const [u, who] of [[UB, 'Blue'], [UR, 'Red']]) {
    await ed.mouse.click(...at(...u)); await wait(ed, 400);
    const sel = ed.locator('.right label', { hasText: 'Assigned to' }).locator('select');
    await sel.selectOption({ label: await sel.locator('option', { hasText: who }).first().textContent() }); await wait(ed, 900);
  }
  await ed.mouse.click(...at(300, -250)); await wait(ed, 300);
  await ed.getByRole('button', { name: 'Turn', exact: true }).click(); await wait(ed);
  await ed.getByRole('button', { name: /Open turn 1/ }).click(); await wait(ed, 1200);
  check('both tanks assigned', (await sql('select count(*)::int n from public.features where owner_player_id is not null'))[0].n === 2);
});

const pc = { x: 640, y: 400 };
const pat = (dx, dy) => [pc.x + dx, pc.y + dy];
const tok = async (name) => (await sql(`select invite_token from public.players where name = $1`, [name]))[0].invite_token;
await step('Blue sees exact stats and picks a target for its gun', async () => {
  blue = await open(1280, 800);
  await blue.goto(`${B}/play.html#${await tok('Blue')}`); await blue.waitForSelector('.ppanel', { timeout: 15000 }); await wait(blue, 2500);
  await blue.mouse.click(...pat(...UB)); await wait(blue, 500);
  const det = await blue.locator('.details').innerText();
  check('own unit shows strength, experience and weapon name and range only', /1000 \/ 1000/.test(det) && /120mm/.test(det) && !/\bAP\b|\barmor\b|\battacks\b/i.test(det), det.replace(/\s+/g, ' ').slice(0, 200));
  await blue.locator('.details').getByRole('button', { name: 'Pick target' }).click(); await wait(blue, 200);
  await blue.mouse.click(...pat(...UR)); await wait(blue, 2500);
  const d = (await sql(`select changes from public.drafts`))[0]?.changes ?? [];
  check('attack order saved in the draft', d.some((c) => c.op === 'update' && c.payload.attacks?.[0]?.slot === 0), JSON.stringify(d));
  await shot(blue, 'c20-blue-target');
  await blue.getByRole('button', { name: /Mark my draft ready/ }).click(); await wait(blue, 1200);
});

await step('owner previews, sees every multiplier, hand-edits one shot, pushes', async () => {
  await ed.reload(); await ed.waitForSelector('.topbar'); await wait(ed, 2500);
  await ed.getByRole('button', { name: /^Turn/ }).click(); await wait(ed);
  await ed.getByRole('button', { name: 'Lock for review' }).click(); await wait(ed, 1200);
  await ed.getByRole('button', { name: 'Resolve combat (preview)' }).click(); await wait(ed, 2000);
  await ed.locator('.engcard').getByRole('button', { name: 'Show rounds' }).click(); await wait(ed, 300);
  const card = await ed.locator('.engcard').innerText();
  check('breakdown lists base, multipliers (incl. urban terrain) and roll', /New engagement/.test(card) && /terrain: urban ×0\.7/.test(card) && /variance roll/.test(card) && /Attacker fires first/.test(card), card.replace(/\s+/g, ' ').slice(0, 300));
  await shot(ed, 'c30-preview');
  const first = ed.locator('.engcard .shots input').first();
  await first.fill('50'); await first.blur(); await wait(ed, 2000);
  const prev = (await sql('select data from public.combat_previews'))[0];
  check('hand edit stored with the preview', Object.values(prev.data.edits).includes(50));
  await ed.getByRole('button', { name: 'Push turn' }).click(); await wait(ed, 3500);
  const redState = (await sql(`select s.strength from public.unit_state s join public.features f on f.id = s.feature_id join public.players p on p.id = f.owner_player_id where p.name = 'Red'`))[0];
  check('push applied the edited result exactly', redState?.strength === 950, JSON.stringify(redState));
  check('engagement running and log stored with the snapshot',
    (await sql(`select count(*)::int n from public.engagements where status = 'active'`))[0].n === 1
    && !!(await sql(`select payload -> 'combat_log' l from public.snapshots where turn_number = 1`))[0]?.l);
});

await step('Red reads its report and sees Blue only as a band', async () => {
  red = await open(1280, 800);
  await red.goto(`${B}/play.html#${await tok('Red')}`); await red.waitForSelector('.ppanel', { timeout: 15000 }); await wait(red, 2500);
  const panel = await red.locator('.ppanel').innerText();
  check('combat report shows own loss', /combat report, turn 1/i.test(panel) && /1000 → 950/.test(panel), panel.replace(/\s+/g, ' ').slice(-300));
  await red.mouse.click(...pat(...UB)); await wait(red, 500);
  const det = await red.locator('.details').innerText();
  check('enemy unit shows only an estimate band', /Estimated condition/.test(det) && !/\d+ \/ 1000/.test(det), det.replace(/\s+/g, ' ').slice(0, 200));
  await shot(red, 'c40-red-report');
  await red.mouse.click(...pat(...UR)); await wait(red, 500);
  const own = await red.locator('.details').innerText();
  check('own engaged unit says so and offers retreat', /In combat/.test(own) && /Retreat/.test(own));
});

console.log(JSON.stringify({ failed: results.filter((r) => r[0] === 'FAIL').length, of: results.length, errors }, null, 1));
await browser.close();
process.exit(0);
