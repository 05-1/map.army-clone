// End-to-end run of the tech tree through the real UI and the real setup.sql:
// owner builds a tree, sets points, tags a unit -> player researches and buys -> push charges and pays.
//   node tests/e2e/tech.mjs <screenshot dir>
import { launch, B } from './lib.mjs';
const { sql } = await import('./fake-supabase.mjs');
const OUT = process.argv[2] ?? '.';
const { browser, open, errors } = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const wait = (p, ms = 700) => p.waitForTimeout(ms);
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
let failed = false;
const step = async (name, fn) => { if (failed) return; try { await fn(); } catch (e) { failed = true; check(name, false, String(e.message).split('\n').slice(0, 4).join(' ').slice(0, 400)); await ed.screenshot({ path: OUT + '/fail-editor.png' }).catch(() => {}); await alice?.screenshot({ path: OUT + '/fail-player.png' }).catch(() => {}); } };

const ed = await open();
let alice = null;
let C;
const at = (dx, dy) => [C.x + dx, C.y + dy];
const U1 = [-120, 0];
const pid = async () => (await sql(`select id from public.players where name = 'Alice'`))[0].id;
const me = async () => (await sql(`select spawn_points, research_points, tech_unlocked from public.players where name = 'Alice'`))[0];
const draft = async () => (await sql(`select changes from public.drafts d join public.turns t on t.id = d.turn_id where t.status = 'open'`))[0]?.changes ?? [];

await step('owner claims, places a unit, creates Alice', async () => {
  await ed.goto(B + '/'); await wait(ed, 1200);
  await ed.fill('input[type=email]', 'owner@example.com'); await ed.fill('input[type=password]', 'correct horse battery');
  await ed.getByRole('button', { name: 'Create account' }).click(); await wait(ed, 1200);
  const claim = ed.getByRole('button', { name: /claim/i });
  if (await claim.count()) await claim.first().click();
  await ed.waitForSelector('.topbar', { timeout: 15000 }); await wait(ed, 2500);
  const box = await ed.locator('.stage').boundingBox(); C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await ed.keyboard.press('s'); await ed.mouse.click(...at(...U1)); await wait(ed, 300);
  await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 1500);
  await ed.getByRole('button', { name: 'Players', exact: true }).click(); await wait(ed);
  await ed.getByPlaceholder('e.g. Alex').fill('Alice'); await ed.getByPlaceholder('e.g. Blue').fill('Blue');
  await ed.locator('.dialog .btn.primary').first().click(); await wait(ed, 900);
  await ed.keyboard.press('Escape'); await wait(ed, 300);
  check('unit and player exist', (await sql('select count(*)::int n from public.features'))[0].n === 1 && !!(await pid()));
});

let mpp = 0;
await step('owner builds the tree in the Tech dialog', async () => {
  // metres per pixel at this zoom: place a second unit 200 px away, measure, delete it
  await ed.keyboard.press('s'); await ed.mouse.click(...at(80, 0)); await wait(ed, 300); await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 1500);
  const [a, b] = (await sql('select geometry from public.features order by z')).map((x) => x.geometry.coordinates);
  mpp = (await sql('select private.dist_m($1::float8[], $2::float8[]) as m', [a, b]))[0].m / 200;
  await ed.mouse.click(...at(80, 0)); await ed.keyboard.press('Delete'); await wait(ed, 1500);

  await ed.getByRole('button', { name: 'Tech', exact: true }).click(); await wait(ed);
  const dlg = ed.locator('.dialog');
  const field = (label) => dlg.locator('label.field', { hasText: label }).locator('input, select, textarea').first();
  const box = (name) => dlg.locator('.techcard', { hasText: name });
  const save = async () => { await dlg.getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 900); };
  // Depot: free, buyable anywhere, spawn point with a ~60 px radius, pays 5 spawn per turn.
  await dlg.getByRole('button', { name: 'New item' }).click(); await wait(ed, 900);
  await field('Name').fill('Depot');
  await field('Spawn cost per unit').fill('20');
  await field('Where players may place it').selectOption('anywhere');
  await field('Spawn points per turn').fill('5');
  await field('Is a spawn point').fill(String(((mpp * 60) / 1000).toFixed(3)));
  await save();
  // Tank: grown to the right of Depot (so it requires Depot), 10 research, 15 spawn, only near a spawn point.
  await dlg.locator('.flowgrow', { hasText: '→' }).click(); await wait(ed, 900);
  await field('Name').fill('Tank'); await field('Research cost').fill('10'); await field('Spawn cost per unit').fill('15');
  await field('Where players may place it').selectOption('spawn');
  await field('Move range per turn').fill('35');
  await save();
  check('move range per type is set in the tree', (await sql(`select move_range_m from public.tech_items where name = 'Tank'`))[0]?.move_range_m === 35000);
  // Radar: research only, grown below Depot, then linked to Tank by dragging its dot onto Tank.
  await box('Depot').click(); await wait(ed, 300);
  await dlg.locator('.flowgrow', { hasText: '↓' }).click(); await wait(ed, 900);
  await field('Name').fill('Radar'); await dlg.locator('label.check', { hasText: 'Players can buy it' }).locator('input').uncheck();
  await save();
  let items = await sql('select id, name, research_cost, spawn_cost, prereqs, spawn_radius_m, placement, income_spawn, pos_x, pos_y, buyable from public.tech_items order by created_at');
  const id = Object.fromEntries(items.map((x) => [x.name, x.id]));
  check('items grown right and down from Depot require it, and sit where the arrows put them',
    items.length === 3 && items[1].prereqs[0] === id.Depot && items[2].prereqs[0] === id.Depot && items[1].pos_x > items[0].pos_x && items[2].pos_y > items[0].pos_y && !items[2].buyable,
    JSON.stringify(items.map((x) => [x.name, x.pos_x, x.pos_y])));
  const dot = box('Radar').locator('.flowdot.right'); await box('Radar').hover();
  const d = await dot.boundingBox(); const t = await box('Tank').boundingBox();
  await ed.mouse.move(d.x + 6, d.y + 6); await ed.mouse.down(); await ed.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 }); await ed.mouse.up(); await wait(ed, 1200);
  let tank = (await sql('select prereqs from public.tech_items where id = $1', [id.Tank]))[0];
  check('dragging a dot onto a box links them', tank.prereqs.includes(id.Radar) && tank.prereqs.length === 2);
  await box('Tank').click(); await wait(ed, 300);
  await dlg.locator('.flowcut[title*="Radar"]').click(); await wait(ed, 1200);
  tank = (await sql('select prereqs, pos_x, pos_y from public.tech_items where id = $1', [id.Tank]))[0];
  check('a link is removed with its ✕', tank.prereqs.length === 1);
  const tb = await box('Tank').boundingBox();
  await ed.mouse.move(tb.x + 60, tb.y + 12); await ed.mouse.down(); await ed.mouse.move(tb.x + 60, tb.y + 112, { steps: 8 }); await ed.mouse.up(); await wait(ed, 1200);
  const moved = (await sql('select pos_x, pos_y from public.tech_items where id = $1', [id.Tank]))[0];
  check('boxes are dragged anywhere and stay there', moved.pos_x === tank.pos_x && moved.pos_y - tank.pos_y >= 90, JSON.stringify([tank, moved]));
  check('arrows drawn for each prerequisite', (await dlg.locator('.techlines path[marker-end]').count()) === 2);
  // A production building, and a unit grown from it that is made there.
  await dlg.getByRole('button', { name: 'New building' }).click(); await wait(ed, 900);
  await field('Name').fill('Barracks'); await field('Spawn cost per unit').fill('40'); await save();
  await dlg.locator('.flowgrow', { hasText: '→' }).click(); await wait(ed, 900);
  await field('Name').fill('Rifles'); await save();
  const bld = (await sql(`select name, category, can_move, spawn_radius_m, spawn_from, placement from public.tech_items where name in ('Barracks', 'Rifles') order by name`));
  check('players build buildings that stay put; units grown from one are made there',
    bld[0].category === 'building' && bld[0].can_move === false && bld[0].spawn_radius_m > 0 && bld[1].spawn_from.length === 1 && bld[1].placement === 'spawn', JSON.stringify(bld));
  await shot(ed, 't10-tree-editor');

  await dlg.getByRole('tab', { name: 'Player points' }).click(); await wait(ed, 500);
  await dlg.getByLabel('Alice spawn points').fill('50'); await dlg.getByLabel('Alice spawn points').blur(); await wait(ed, 900);
  await dlg.getByLabel('Alice research points').fill('10'); await dlg.getByLabel('Alice research points').blur(); await wait(ed, 900);
  await shot(ed, 't11-points');
  const p = await me();
  check('points set from the dialog', p.spawn_points === 50 && p.research_points === 10);

  await dlg.getByRole('tab', { name: 'Spawn zones' }).click(); await wait(ed, 1500);
  await dlg.getByLabel('Country').fill('France'); await dlg.getByRole('button', { name: 'Add country' }).click(); await wait(ed, 1500);
  let z = await sql(`select name, zone->>'type' t, player_id, team from public.spawn_zones`);
  check('a country becomes a spawn zone', z.length === 1 && z[0].name === 'France' && z[0].t === 'MultiPolygon', JSON.stringify(z));
  await dlg.getByRole('button', { name: 'Draw a zone on the map' }).click(); await wait(ed, 500);
  check('drawing closes the window and picks the polygon tool', !(await ed.locator('.dialog').count()));
  for (const [x, y] of [[200, -200], [320, -200], [320, -80], [200, -80]]) { await ed.mouse.click(...at(x, y)); await wait(ed, 120); }
  await ed.mouse.dblclick(...at(200, -80)); await wait(ed, 1200);
  check('the Tech window comes back on Spawn zones with the shape selected', /Selected on the map: drawn area/.test(await ed.locator('.dialog').innerText().catch(() => '')));
  await ed.locator('.dialog').getByRole('button', { name: 'Use selected shape' }).click(); await wait(ed, 1200);
  z = await sql(`select zone->>'type' t from public.spawn_zones order by created_at`);
  check('drawn zone saved', z.length === 2 && z[1].t === 'Polygon');
  await shot(ed, 't12-zones');
  await ed.keyboard.press('Escape'); await wait(ed, 300);
  await ed.mouse.click(...at(300, -250)); await wait(ed, 300);
});

await step('owner tags the unit as a Depot and assigns it', async () => {
  await ed.mouse.click(...at(...U1)); await wait(ed, 400);
  const assign = ed.locator('.right label', { hasText: 'Assigned to' }).locator('select');
  await assign.selectOption({ label: await assign.locator('option', { hasText: 'Alice' }).first().textContent() }); await wait(ed, 900);
  const tech = ed.locator('.right label', { hasText: 'Tech type' }).locator('select');
  await tech.selectOption({ label: await tech.locator('option', { hasText: 'Depot' }).first().textContent() }); await wait(ed, 1800);
  const f = (await sql(`select props, owner_player_id from public.features where kind = 'symbol'`))[0];
  check('unit tagged and assigned', !!f.props.tech && f.owner_player_id === (await pid()), JSON.stringify(await sql('select kind, props, owner_player_id from public.features')));
  await shot(ed, 't13-tagged');
  await ed.mouse.click(...at(300, -250)); await wait(ed, 300);
  await ed.getByRole('button', { name: 'Turn', exact: true }).click(); await wait(ed);
  await ed.getByRole('button', { name: /Open turn 1/ }).click(); await wait(ed, 1200);
});

const pc = { x: 640, y: 400 };
const pat = (dx, dy) => [pc.x + dx, pc.y + dy];
await step('Alice researches Tank and buys one the same turn, plus a Depot', async () => {
  alice = await open(1280, 800);
  const tok = (await sql(`select invite_token from public.players where name = 'Alice'`))[0].invite_token;
  await alice.goto(`${B}/play.html#${tok}`); await alice.waitForSelector('.ppanel', { timeout: 15000 }); await wait(alice, 2500);
  const panel = await alice.locator('.ppanel').innerText();
  check('player sees points and income', /Spawn\s*50/.test(panel) && /Research\s*10/.test(panel) && /\+5 spawn/.test(panel), panel.replace(/\s+/g, ' ').slice(0, 200));
  check('Tank is not buyable before research', !(await alice.locator('.allocs button', { hasText: 'Tank' }).count()));
  await alice.getByRole('button', { name: /Tech tree/ }).click(); await wait(alice, 800);
  await shot(alice, 't20-player-tree');
  await alice.locator('.techcard', { hasText: 'Tank' }).getByRole('button', { name: /Research/ }).click(); await wait(alice, 400);
  await alice.locator('.techcard', { hasText: 'Tank' }).getByRole('button', { name: 'Buy and place' }).click(); await wait(alice, 400);
  await alice.mouse.click(...pat(U1[0] + 20, U1[1] + 15)); await wait(alice, 600);
  await alice.keyboard.press('Escape');
  await alice.locator('.allocs button', { hasText: 'Depot' }).click();
  await alice.mouse.click(...pat(150, 120)); await wait(alice, 2500);
  const d = await draft();
  check('draft holds the research, the tank and the depot', d.filter((c) => c.op === 'research').length === 1 && d.filter((c) => c.op === 'create' && c.payload.purchase_id).length === 2, JSON.stringify(d.map((c) => c.op)));
  const panel2 = await alice.locator('.ppanel').innerText();
  check('points left shown after the draft', /Spawn\s*15/.test(panel2) && /Research\s*0/.test(panel2));
  await shot(alice, 't21-player-draft');
  await alice.getByRole('button', { name: /Mark my draft ready/ }).click(); await wait(alice, 1200);
});

await step('owner reviews costs and pushes', async () => {
  await ed.reload(); await ed.waitForSelector('.topbar'); await wait(ed, 2500);
  await ed.getByRole('button', { name: /^Turn/ }).click(); await wait(ed);
  await ed.getByRole('button', { name: 'Lock for review' }).click(); await wait(ed, 1200);
  await ed.locator('.subs li button', { hasText: 'Alice' }).first().click(); await wait(ed, 600);
  const review = await ed.locator('.subs li.on').innerText();
  check('review lists research and purchases with costs', /Research Tank/.test(review) && /Buy Tank/.test(review) && /Buy Depot/.test(review) && /Spawn\s*35\s*of 50/.test(review), review.replace(/\s+/g, ' ').slice(0, 300));
  await shot(ed, 't30-review');
  const li = (t) => ed.locator('.subs li.on .changes li', { hasText: t }).locator('input[type=checkbox]');
  await li('Research Tank').click(); await wait(ed, 1200);
  const rej = (await sql(`select rejected from public.drafts`))[0].rejected.length;
  check('rejecting the research also rejects the tank bought from it', rej === 2);
  await li('Buy Tank').click(); await wait(ed, 1200);
  check('accepting the tank accepts its research again', (await sql(`select rejected from public.drafts`))[0].rejected.length === 0);
  await ed.getByRole('button', { name: 'Push turn' }).click(); await wait(ed, 2500);
  const p = await me();
  const tank = (await sql(`select id from public.tech_items where name = 'Tank'`))[0].id;
  // 50 - 20 (depot) - 15 (tank) + 2 depots x 5 income = 25; 10 - 10 research; Tank unlocked.
  check('push charged costs, paid income from both depots, unlocked Tank', p.spawn_points === 25 && p.research_points === 0 && p.tech_unlocked.includes(tank), JSON.stringify(p));
});

await step('Alice buys a Tank, only near a depot', async () => {
  await alice.reload(); await alice.waitForSelector('.ppanel', { timeout: 15000 }); await wait(alice, 2500);
  await alice.locator('.allocs button', { hasText: 'Tank' }).click(); await wait(alice, 300);
  await shot(alice, 't40-spawn-areas');
  await alice.mouse.click(...pat(-300, -250)); await wait(alice, 600);
  const toast = await alice.locator('.toast').innerText().catch(() => '');
  check('far from any depot is refused with a reason', /near a spawn point/.test(toast), toast);
  await alice.mouse.click(...pat(U1[0] + 20, U1[1] + 20)); await wait(alice, 2500);
  const d = await draft();
  check('tank next to the tagged depot is in the draft', d.filter((c) => c.op === 'create' && c.payload.purchase_id).length === 1);
  check('country zone reaches the player', (await sql(`select count(*)::int n from public.spawn_zones`))[0].n === 2);
  await shot(alice, 't41-tank');
});

console.log(JSON.stringify({ failed: results.filter((r) => r[0] === 'FAIL').length, of: results.length, errors }, null, 1));
await browser.close();
process.exit(0);
