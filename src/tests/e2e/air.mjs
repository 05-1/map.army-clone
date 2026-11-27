// End-to-end run of air combat (v2: squadrons on the map) through the real UI and the real setup.sql:
// owner sets up an airbase template with a radar, real-world missiles and an airframe preset, a squadron ->
// the player loads missiles while landed, flies the squadron next to an enemy unit and declares a salvo ->
// owner previews and pushes -> the squadron is airborne with missiles spent, the enemy's radar now shows it.
//   node tests/e2e/air.mjs <screenshot dir>
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
// Close together at zoom +4: about 150 km apart.
const UB = [-200, 60], UR = [-80, 60];
const dlg = () => ed.locator('.dialog');
const field = (label) => dlg().locator('label.field', { hasText: label }).locator('input, select, textarea').first();

await step('owner zooms in, sets the start view, places a base and an enemy unit', async () => {
  await ed.goto(B + '/'); await wait(ed, 1200);
  await ed.fill('input[type=email]', 'owner@example.com'); await ed.fill('input[type=password]', 'correct horse battery');
  await ed.getByRole('button', { name: 'Create account' }).click(); await wait(ed, 1200);
  const claim = ed.getByRole('button', { name: /claim/i });
  if (await claim.count()) await claim.first().click();
  await ed.waitForSelector('.topbar', { timeout: 15000 }); await wait(ed, 2500);
  for (let i = 0; i < 4; i++) { await ed.locator('.maplibregl-ctrl-zoom-in').first().click(); await wait(ed, 400); }
  await wait(ed, 800);
  await ed.getByRole('button', { name: /Set start view/ }).click(); await wait(ed, 800);
  const box = await ed.locator('.stage').boundingBox(); C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await ed.keyboard.press('s'); await ed.mouse.click(...at(...UB)); await wait(ed, 250); await ed.mouse.click(...at(...UR)); await wait(ed, 250);
  await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 1500);
  check('two units on the map', (await sql('select count(*)::int n from public.features'))[0].n === 2);
});

await step('Combat: an airbase template with a 50 km radar', async () => {
  await ed.getByRole('button', { name: 'Combat', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Settings' }).click(); await wait(ed, 300);
  await field('Intel range').fill('9000');
  await dlg().getByRole('button', { name: /Save from turn/ }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Unit templates' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: 'New template' }).click();
  await field('Name').fill('Base'); await field('Max strength').fill('20000'); await field('Armor').fill('5');
  await field('Airbase: squadrons it can hold').fill('2');
  await field('Radar / early warning range').fill('50');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 900);
  const t = (await sql('select name, air_capacity, sensor_m from public.unit_templates'))[0];
  check('template: airbase for 2 squadrons with a 50 km radar', t?.air_capacity === 2 && t.sensor_m === 50000, JSON.stringify(t));
  await ed.keyboard.press('Escape'); await wait(ed, 400);
});

await step('Air window: roles, real-world missiles in their own tree, an airframe preset', async () => {
  await ed.getByRole('button', { name: 'Air', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Roles' }).click(); await wait(ed, 300);
  check('four standard roles', /Fighter[\s\S]*Multirole[\s\S]*Bomber[\s\S]*Tanker/.test(await dlg().innerText()));
  await dlg().getByRole('tab', { name: 'Missiles' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: /Add IR, ARH, HARM and AGM/ }).click(); await wait(ed, 1200);
  await dlg().getByRole('button', { name: /Add real-world missiles/ }).click(); await wait(ed, 4000);
  const w = await sql(`select w.name, t.tree from public.air_weapons w join public.tech_items t on t.id = w.tech_item_id order by w.name`);
  check('ten missiles, each a node in the missile tree', w.length === 10 && w.every((x) => x.tree === 'missiles'), w.map((x) => x.name).join(', '));
  await shot(ed, 'a10-missiles');
  await dlg().getByRole('tab', { name: 'Airframes' }).click(); await wait(ed, 300);
  await dlg().getByLabel('Start from a real aircraft').selectOption({ label: 'F-16C Block 50 (Multirole)' }); await wait(ed, 300);
  check('preset fills real figures', (await field('Speed: max move per turn').inputValue()) === '4200' && (await field('Combat radius, empty').inputValue()) === '900');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 1200);
  const af = (await sql(`select name, speed_m, cardinality(families) n from public.airframes`))[0];
  check('airframe saved with its role and all four families', af?.name === 'F-16C Block 50' && af.n === 4, JSON.stringify(af));
  await shot(ed, 'a11-airframe');
  await ed.keyboard.press('Escape'); await wait(ed, 400);
});

await step('players, assignment, turn, a squadron for Blue at its base', async () => {
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
  await ed.keyboard.press('Escape'); await wait(ed, 300);
  await ed.getByRole('button', { name: 'Air', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('button', { name: 'New squadron' }).click(); await wait(ed, 300);
  await field('Name').fill('Vipers');
  await field('Player').selectOption({ label: 'Blue' });
  const base = field('Base');
  await base.selectOption({ label: await base.locator('option', { hasText: 'Blue' }).first().textContent() });
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 1200);
  const q = (await sql(`select f.props ->> 'name' n, q.aircraft, q.state, p.name player from public.air_units q join public.features f on f.id = q.feature_id join public.players p on p.id = f.owner_player_id`))[0];
  check('squadron is a unit on the map, landed at Blue\'s airbase', q?.n === 'Vipers' && q.aircraft === 12 && q.state === 'landed' && q.player === 'Blue', JSON.stringify(q));
  await shot(ed, 'a12-squadron');
  await ed.keyboard.press('Escape'); await wait(ed, 400);
});

const pc = { x: 640, y: 400 };
const pat = (dx, dy) => [pc.x + dx, pc.y + dy];
const tok = async (name) => (await sql(`select invite_token from public.players where name = $1`, [name]))[0].invite_token;
const vipers = async () => (await sql(`select q.*, f.geometry from public.air_units q join public.features f on f.id = q.feature_id`))[0];
await step('Blue loads missiles while landed, flies next to the enemy and declares a salvo', async () => {
  blue = await open(1280, 800);
  await blue.goto(`${B}/play.html#${await tok('Blue')}`); await blue.waitForSelector('.ppanel', { timeout: 15000 }); await wait(blue, 2500);
  await blue.locator('.ppanel').getByRole('button', { name: /Vipers/ }).click(); await wait(blue, 500);
  const det = await blue.locator('.details').innerText();
  check('details: aircraft, landed, reach', /12 \/ 12 F-16C/.test(det) && /Landed at/.test(det) && /4,200 km a turn/.test(det), det.replace(/\s+/g, ' ').slice(0, 300));
  await blue.locator('.details').getByRole('button', { name: 'Change loadout' }).click(); await wait(blue, 400);
  const lo = await blue.locator('.dialog').innerText();
  check('loadout hides accuracy and damage; only researched tier 1 can be loaded', /AGM-65 Maverick/.test(lo) && !/accuracy|damage per hit|\bAP\b/i.test(lo) && /research it/i.test(lo), (lo.match(/.{0,40}(accuracy|damage per hit|\bAP\b).{0,40}/i) ?? [''])[0]);
  await blue.getByRole('button', { name: 'One more AGM-65 Maverick' }).click(); await blue.getByRole('button', { name: 'One more AGM-65 Maverick' }).click();
  await shot(blue, 'a20-loadout');
  await blue.getByRole('button', { name: 'Save loadout' }).click(); await wait(blue, 1500);
  const q = await vipers();
  check('loadout saved and the squadron rearmed', q.loadout[0]?.count === 2 && Object.values(q.ammo)[0] === 24, JSON.stringify(q.ammo));
  // Fly: drag the squadron off its base to just short of the enemy unit.
  await blue.mouse.move(...pat(...UB)); await blue.mouse.down(); await blue.mouse.move(...pat(UR[0] - 15, UR[1]), { steps: 12 }); await blue.mouse.up(); await wait(blue, 800);
  await blue.locator('.details').getByRole('button', { name: 'Add a target' }).click(); await wait(blue, 200);
  await blue.mouse.click(...pat(...UR)); await wait(blue, 2500);
  const d = (await sql(`select changes from public.drafts`))[0]?.changes ?? [];
  const c = d.find((x) => x.op === 'update' && x.payload.air_attacks);
  check('move and salvo in the saved draft (all 24 Mavericks)', !!c?.payload.geometry && c.payload.air_attacks[0].weapons[0].count === 24, JSON.stringify(d).slice(0, 300) + ' ' + (await blue.locator('.toast').allTextContents()).join(' '));
  const det2 = await blue.locator('.details').innerText();
  check('details list the attack with its salvo', /Attacks this turn/.test(det2) && /AGM-65 Maverick/.test(det2), det2.replace(/\s+/g, ' ').slice(0, 400));
  await blue.locator('.details').getByRole('button', { name: /One fewer AGM-65 Maverick/ }).click(); await wait(blue, 2000);
  const d2 = (await sql(`select changes from public.drafts`))[0]?.changes ?? [];
  check('salvo trimmed to 23', d2.find((x) => x.payload?.air_attacks)?.payload.air_attacks[0].weapons[0].count === 23);
  await shot(blue, 'a21-strike');
  await blue.getByRole('button', { name: /Mark my draft ready/ }).click(); await wait(blue, 1200);
});

await step('owner previews the air phase shot by shot and pushes', async () => {
  await ed.reload(); await ed.waitForSelector('.topbar'); await wait(ed, 2500);
  await ed.getByRole('button', { name: /^Turn/ }).click(); await wait(ed);
  await ed.getByRole('button', { name: 'Lock for review' }).click(); await wait(ed, 1200);
  await ed.getByRole('button', { name: 'Resolve combat (preview)' }).click(); await wait(ed, 2000);
  const all = await ed.locator('body').innerText();
  check('air section with the strike package', /Strike by Vipers/.test(all), all.replace(/\s+/g, ' ').slice(0, 200));
  await ed.getByRole('button', { name: 'Show shots' }).first().click(); await wait(ed, 300);
  check('per-shot hit chance and roll shown', /=\s*\d+%/.test(await ed.locator('body').innerText()));
  await shot(ed, 'a30-preview');
  await ed.getByRole('button', { name: 'Push turn' }).click(); await wait(ed, 3500);
  const q = await vipers();
  check('squadron airborne where it was flown, missiles spent', q.state === 'airborne' && Object.values(q.ammo)[0] < 24, JSON.stringify({ state: q.state, ammo: q.ammo }));
  const st = (await sql(`select s.strength from public.unit_state s join public.features f on f.id = s.feature_id join public.players p on p.id = f.owner_player_id where p.name = 'Red'`))[0];
  check('strike damaged the Red unit', st && st.strength < 20000, JSON.stringify(st));
});

await step('Red now sees the squadron on its radar (type and band only); Blue reads its report', async () => {
  red = await open(1280, 800);
  await red.goto(`${B}/play.html#${await tok('Red')}`); await red.waitForSelector('.ppanel', { timeout: 15000 }); await wait(red, 2500);
  await red.mouse.click(...pat(UR[0] - 15, UR[1])); await wait(red, 600);
  const det = await red.locator('.details').innerText();
  check('enemy squadron on the radar: type and band, no numbers', /Enemy squadron on your radar/.test(det) && /F-16C/.test(det) && !/\d+ \/ 12/.test(det), det.replace(/\s+/g, ' ').slice(0, 300));
  await shot(red, 'a41-red-radar');
  await blue.reload(); await blue.waitForSelector('.ppanel', { timeout: 15000 }); await wait(blue, 2500);
  const panel = await blue.locator('.ppanel').innerText();
  check('Blue report has the strike result', /Vipers → /.test(panel) && /hit/.test(panel), panel.replace(/\s+/g, ' ').slice(-400));
  await blue.locator('.ppanel').getByRole('button', { name: /Vipers/ }).click(); await wait(blue, 500);
  check('airborne squadron: missiles left, no loadout changes in the air', /Missiles left/.test(await blue.locator('.details').innerText()));
  await shot(blue, 'a40-blue-report');
});

console.log(JSON.stringify({ failed: results.filter((r) => r[0] === 'FAIL').length, of: results.length, errors }, null, 1));
await browser.close();
process.exit(0);
