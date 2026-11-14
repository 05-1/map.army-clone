// End-to-end run of air combat through the real UI and the real setup.sql:
// owner builds an airbase template, missiles, an airframe and a squadron -> the player loads missiles,
// plans a strike and buys a replacement -> owner previews and pushes -> reports on both sides.
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
const UB = [-200, 60], UR = [-80, 60];
const dlg = () => ed.locator('.dialog');
const field = (label) => dlg().locator('label.field', { hasText: label }).locator('input, select, textarea').first();

await step('owner places a base and a tank, makes them airbase-capable', async () => {
  await ed.goto(B + '/'); await wait(ed, 1200);
  await ed.fill('input[type=email]', 'owner@example.com'); await ed.fill('input[type=password]', 'correct horse battery');
  await ed.getByRole('button', { name: 'Create account' }).click(); await wait(ed, 1200);
  const claim = ed.getByRole('button', { name: /claim/i });
  if (await claim.count()) await claim.first().click();
  await ed.waitForSelector('.topbar', { timeout: 15000 }); await wait(ed, 2500);
  const box = await ed.locator('.stage').boundingBox(); C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await ed.keyboard.press('s'); await ed.mouse.click(...at(...UB)); await wait(ed, 250); await ed.mouse.click(...at(...UR)); await wait(ed, 250);
  await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 1500);
  await ed.getByRole('button', { name: 'Combat', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Settings' }).click(); await wait(ed, 300);
  await field('Intel range').fill('9000');
  await dlg().getByRole('button', { name: /Save from turn/ }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Unit templates' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: 'New template' }).click();
  await field('Name').fill('Base'); await field('Max strength').fill('1000'); await field('Armor').fill('5');
  await field('Airbase: squadrons it can hold').fill('2');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 900);
  const t = (await sql('select name, air_capacity from public.unit_templates'))[0];
  check('template is an airbase for 2 squadrons', t?.air_capacity === 2, JSON.stringify(t));
  await ed.keyboard.press('Escape'); await wait(ed, 400);
});

await step('Air window: missile families, an AGM tier, an airframe', async () => {
  await ed.getByRole('button', { name: 'Air', exact: true }).click(); await wait(ed, 900);
  await dlg().getByRole('tab', { name: 'Missiles' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: /Add IR, ARH, HARM and AGM/ }).click(); await wait(ed, 1200);
  await dlg().locator('.setgrp', { hasText: 'AGM' }).getByRole('button', { name: '+ tier' }).click(); await wait(ed, 300);
  await field('Name').fill('Maverick'); await field('Damage per hit').fill('20'); await field('AP (vs ground armor)').fill('5');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 1200);
  const w = (await sql(`select w.name, w.tier, w.damage, t.category from public.air_weapons w left join public.tech_items t on t.id = w.tech_item_id`))[0];
  check('missile tier saved with its tech-tree node', w?.name === 'Maverick' && w.tier === 1 && w.category === 'weapon', JSON.stringify(w));
  await shot(ed, 'a10-missiles');
  await dlg().getByRole('tab', { name: 'Airframes' }).click(); await wait(ed, 300);
  await dlg().getByRole('button', { name: 'New airframe' }).click();
  await field('Name').fill('F-16'); await field('Combat radius, empty').fill('20000'); await field('SP per replacement aircraft').fill('5');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 1200);
  check('airframe saved', (await sql(`select count(*)::int n from public.airframes where name = 'F-16'`))[0].n === 1);
  await shot(ed, 'a11-airframe');
  await ed.keyboard.press('Escape'); await wait(ed, 400);
});

await step('players, assignment, turn, squadron for Blue', async () => {
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
  await field('Aircraft').fill('10'); await field('Full strength').fill('12');
  await dlg().getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 1200);
  const q = (await sql(`select q.name, q.aircraft, p.name player from public.squadrons q join public.players p on p.id = q.owner_player_id`))[0];
  check('squadron based at Blue\'s airbase', q?.name === 'Vipers' && q.aircraft === 10 && q.player === 'Blue', JSON.stringify(q));
  await shot(ed, 'a12-squadron');
  await ed.keyboard.press('Escape'); await wait(ed, 400);
});

const pc = { x: 640, y: 400 };
const pat = (dx, dy) => [pc.x + dx, pc.y + dy];
const tok = async (name) => (await sql(`select invite_token from public.players where name = $1`, [name]))[0].invite_token;
await step('Blue loads missiles, plans a strike, buys a replacement', async () => {
  await sql(`update public.players set spawn_points = 20 where name = 'Blue'`);   // the Players window sets this; covered by the tech test
  blue = await open(1280, 800);
  await blue.goto(`${B}/play.html#${await tok('Blue')}`); await blue.waitForSelector('.ppanel', { timeout: 15000 }); await wait(blue, 2500);
  const card = blue.locator('.sqcard', { hasText: 'Vipers' });
  check('squadron card shows strength and type', /10 \/ 12 aircraft/.test(await card.innerText()) && /F-16/.test(await card.innerText()));
  await card.getByRole('button', { name: 'Loadout' }).click(); await wait(blue, 400);
  const lo = await blue.locator('.dialog').innerText();
  check('loadout window hides accuracy and damage', /Maverick/.test(lo) && !/accuracy|damage per hit|\bAP\b/i.test(lo), lo.replace(/\s+/g, ' ').slice(0, 200));
  await blue.getByRole('button', { name: 'One more Maverick' }).click(); await blue.getByRole('button', { name: 'One more Maverick' }).click();
  await shot(blue, 'a20-loadout');
  await blue.getByRole('button', { name: 'Save loadout' }).click(); await wait(blue, 1500);
  const l = (await sql(`select loadout from public.squadrons`))[0].loadout;
  check('loadout saved at once', l.length === 1 && l[0].count === 2, JSON.stringify(l));
  await card.getByRole('button', { name: 'Strike', exact: true }).click(); await wait(blue, 300);
  await blue.mouse.click(...pat(...UR)); await wait(blue, 500);
  await card.getByRole('button', { name: 'One more replacement for Vipers' }).click(); await wait(blue, 2500);
  const d = (await sql(`select changes from public.drafts`))[0]?.changes ?? [];
  check('strike and replacement in the saved draft', d.some((c) => c.op === 'mission' && c.payload.type === 'strike' && c.payload.target_unit) && d.some((c) => c.op === 'buy_aircraft' && c.payload.count === 1), JSON.stringify(d));
  const draftText = await blue.locator('.ppanel').innerText();
  check('draft lists the mission in words', /Strike .*Vipers/.test(draftText), draftText.replace(/\s+/g, ' ').slice(0, 400));
  await shot(blue, 'a21-strike');
  await blue.getByRole('button', { name: /Mark my draft ready/ }).click(); await wait(blue, 1200);
});

await step('owner previews the air phase and pushes', async () => {
  await ed.reload(); await ed.waitForSelector('.topbar'); await wait(ed, 2500);
  await ed.getByRole('button', { name: /^Turn/ }).click(); await wait(ed);
  await ed.getByRole('button', { name: 'Lock for review' }).click(); await wait(ed, 1200);
  await ed.getByRole('button', { name: 'Resolve combat (preview)' }).click(); await wait(ed, 2000);
  const prev = await ed.locator('.dialog, .right').first().innerText().catch(() => '');
  const all = await ed.locator('body').innerText();
  check('air section in the preview with the strike', /Strike by Vipers on/.test(all) && /Vipers/.test(all), (prev || all).replace(/\s+/g, ' ').slice(0, 300));
  const show = ed.getByRole('button', { name: 'Show shots' }).first();
  if (await show.count()) { await show.click(); await wait(ed, 300); }
  check('per-shot hit chance and roll shown', /=\s*\d+%/.test(await ed.locator('body').innerText()));
  await shot(ed, 'a30-preview');
  await ed.getByRole('button', { name: 'Push turn' }).click(); await wait(ed, 3500);
  const q = (await sql(`select aircraft from public.squadrons`))[0];
  check('replacement arrived at push', q.aircraft === 11, JSON.stringify(q));
  const st = (await sql(`select s.strength from public.unit_state s join public.features f on f.id = s.feature_id join public.players p on p.id = f.owner_player_id where p.name = 'Red'`))[0];
  check('strike damaged the Red unit', st && st.strength < 1000, JSON.stringify(st));
});

await step('Blue reads the air report; Red sees the airbase only as bands', async () => {
  await blue.reload(); await blue.waitForSelector('.ppanel', { timeout: 15000 }); await wait(blue, 2500);
  const panel = await blue.locator('.ppanel').innerText();
  check('Blue report has the strike result', /Vipers → /.test(panel) && /hits/.test(panel), panel.replace(/\s+/g, ' ').slice(-400));
  await shot(blue, 'a40-blue-report');
  red = await open(1280, 800);
  await red.goto(`${B}/play.html#${await tok('Red')}`); await red.waitForSelector('.ppanel', { timeout: 15000 }); await wait(red, 2500);
  await red.mouse.click(...pat(...UB)); await wait(red, 500);
  const det = await red.locator('.details').innerText();
  check('enemy airbase shows squadron bands, not numbers', /Airbase with 1 squadron/.test(det) && !/11 \/ 12/.test(det), det.replace(/\s+/g, ' ').slice(0, 200));
  await shot(red, 'a41-red-intel');
});

console.log(JSON.stringify({ failed: results.filter((r) => r[0] === 'FAIL').length, of: results.length, errors }, null, 1));
await browser.close();
process.exit(0);
