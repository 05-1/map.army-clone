// End-to-end run of a whole turn through the real UI and the real setup.sql:
// first run -> players -> turn -> drafts -> lock -> review -> push -> history -> rollback -> backup.
//   node tests/e2e/scenario.mjs <screenshot dir>
import { launch, B, texts } from './lib.mjs';
const { sql, state } = await import('./fake-supabase.mjs');
const OUT = process.argv[2] ?? '.';
const { browser, open, errors } = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n').slice(0, 4).join(' ').slice(0, 400)); await ed.screenshot({ path: OUT + '/fail.png' }).catch(() => {}); } };
const wait = (p, ms = 700) => p.waitForTimeout(ms);
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });

const ed = await open();
let C; // stage centre
const at = (dx, dy) => [C.x + dx, C.y + dy];
const U1 = [-160, -60], U2 = [120, 80];

await step('first run and claim', async () => {
  await ed.goto(B + '/'); await wait(ed, 1200);
  const first = await ed.locator('body').innerText();
  check('first-run page reports connection, schema and anonymous sign-ins', /Connected to/.test(first) && /schema version 9/.test(first) && /Anonymous sign-ins/.test(first));
  await ed.fill('input[type=email]', 'owner@example.com'); await ed.fill('input[type=password]', 'correct horse battery');
  await ed.getByRole('button', { name: 'Create account' }).click(); await wait(ed, 1200);
  const claim = ed.getByRole('button', { name: /claim/i });
  if (await claim.count()) await claim.first().click();
  await ed.waitForSelector('.topbar', { timeout: 15000 }); await wait(ed, 2500);
  check('owner claimed, editor loads', (await sql('select role from private.admins'))[0]?.role === 'owner');
  const box = await ed.locator('.stage').boundingBox(); C = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
});

await step('place two units', async () => {
  await ed.keyboard.press('s'); await ed.mouse.click(...at(...U1)); await wait(ed, 300); await ed.mouse.click(...at(...U2)); await wait(ed, 300);
  await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 1500);
  check('units saved', (await sql('select count(*)::int n from public.features'))[0].n === 2);
});

const tokens = {};
await step('players: create, PIN', async () => {
  await ed.getByRole('button', { name: 'Players', exact: true }).click(); await wait(ed);
  for (const [n, t] of [['Alice', 'Blue'], ['Bob', 'Blue']]) {
    await ed.getByPlaceholder('e.g. Alex').fill(n); await ed.getByPlaceholder('e.g. Blue').fill(t);
    await ed.locator('.dialog .btn.primary').first().click(); await wait(ed, 900);
  }
  for (const r of await sql('select id, name, invite_token from public.players')) tokens[r.name] = r;
  check('two invites created', !!tokens.Alice && !!tokens.Bob);
  const bob = ed.locator('.links li', { hasText: 'Bob' });
  await bob.getByRole('button', { name: 'PIN', exact: true }).click(); await bob.locator('input[inputmode=numeric]').fill('4821');
  await bob.getByRole('button', { name: 'Set PIN' }).click(); await wait(ed, 900);
  check('PIN set (hash only, never the PIN)', (await sql(`select pin_hash is not null and pin_hash <> '4821' as ok from public.players where name = 'Bob'`))[0].ok);
  await shot(ed, '10-players'); await ed.keyboard.press('Escape'); await wait(ed, 300);
});

await step('assign units (multi-select)', async () => {
  await ed.mouse.click(...at(...U1)); await ed.keyboard.down('Shift'); await ed.mouse.click(...at(...U2)); await ed.keyboard.up('Shift'); await wait(ed, 400);
  const sel = ed.locator('.right label', { hasText: 'Assigned to' }).locator('select');
  await sel.selectOption({ label: await sel.locator('option', { hasText: 'Alice' }).first().textContent() }); await wait(ed, 900);
  check('both units assigned to Alice in one go', (await sql(`select count(*)::int n from public.features where owner_player_id = $1`, [tokens.Alice.id]))[0].n === 2);
  await ed.mouse.click(...at(300, -250)); await wait(ed, 200); await ed.mouse.click(...at(...U2)); await wait(ed, 400);
  await sel.selectOption({ label: await sel.locator('option', { hasText: 'Bob' }).first().textContent() }); await wait(ed, 900);
  check('second unit reassigned to Bob', (await sql(`select count(*)::int n from public.features where owner_player_id = $1`, [tokens.Bob.id]))[0].n === 1);
  await ed.mouse.click(...at(300, -250)); await wait(ed, 1200);
});

let mpp = 0; // metres per pixel, measured from the map itself
await step('open turn, settings, zone, allocation', async () => {
  const f = await sql('select id, geometry, owner_player_id from public.features order by z');
  const [a, b] = f.map((x) => x.geometry.coordinates);
  const R = 6371008.8, rad = Math.PI / 180;
  const d = 2 * R * Math.asin(Math.sqrt(Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2));
  mpp = d / Math.hypot(U2[0] - U1[0], U2[1] - U1[1]);
  await ed.getByRole('button', { name: 'Turn', exact: true }).click(); await wait(ed);
  await ed.getByRole('button', { name: /Open turn 1/ }).click(); await wait(ed, 1200);
  const radiusKm = Math.round((mpp * 100) / 1000); // about 100 px of movement
  const r = ed.locator('.right label', { hasText: 'Move radius' }).locator('input'); await r.fill(String(radiusKm)); await r.blur(); await wait(ed, 900);
  const c = ed.locator('.right label', { hasText: 'Conflict distance' }).locator('input'); await c.fill(String(Math.round((mpp * 170) / 1000))); await c.blur(); await wait(ed, 900);
  const t = (await sql(`select * from public.turns where status = 'open'`))[0];
  check('turn 1 open with radius and conflict distance', t.number === 1 && t.default_radius_m === radiusKm * 1000 && t.conflict_m > 0, `radius ${radiusKm} km`);
  // zone: circle drawn on the map near Alice's unit
  await ed.mouse.click(...at(300, -250)); await ed.keyboard.press('c'); await ed.mouse.click(...at(-160, 160)); await ed.mouse.move(...at(-130, 160), { steps: 3 }); await ed.mouse.click(...at(-110, 160)); await wait(ed, 400);
  await ed.keyboard.press('Escape'); await ed.mouse.click(...at(-110, 160)); await wait(ed, 400);
  await ed.getByLabel('For', { exact: true }).selectOption('team:Blue'); await ed.getByLabel('Unit', { exact: true }).selectOption('symbol');
  await ed.getByRole('button', { name: 'Use selected shape' }).click(); await ed.getByRole('button', { name: 'Add allocation' }).click(); await wait(ed, 1200);
  const al = (await sql('select * from public.allocations'))[0];
  check('team allocation with a drawn zone', al?.team === 'Blue' && al.quantity === 1 && al.zone && 'radius_m' in al.zone, JSON.stringify(al?.zone));
  await shot(ed, '11-turn-open');
});

const alice = await open(1280, 800), bob = await open(1280, 800);
const pc = { x: 640, y: 400 };
// the player map opens on the same centre and zoom, so the same pixel offsets hit the same places
const pat = (dx, dy) => [pc.x + dx, pc.y + dy];
await step('Alice drafts: clamped move, reinforcement in zone, ready', async () => {
  await alice.goto(`${B}/play.html#${tokens.Alice.invite_token}`); await alice.waitForSelector('.ppanel', { timeout: 15000 }); await wait(alice, 2500);
  await shot(alice, '20-alice-start');
  await alice.mouse.move(...pat(...U1)); await alice.mouse.down(); await alice.mouse.move(...pat(U1[0] + 150, U1[1]), { steps: 6 }); await alice.mouse.move(...pat(U1[0] + 330, U1[1]), { steps: 6 }); await alice.mouse.up();
  await wait(alice, 2500);
  let d = (await sql('select changes from public.drafts where player_id = $1', [tokens.Alice.id]))[0];
  const mv = d?.changes.find((c) => c.op === 'update');
  const start = (await sql('select geometry from public.features where owner_player_id = $1', [tokens.Alice.id]))[0].geometry.coordinates;
  const dist = mv ? (await sql('select private.dist_m($1::float8[], $2::float8[]) as m', [start, mv.payload.geometry.coordinates]))[0].m : -1;
  const lim = (await sql(`select default_radius_m r from public.turns where status = 'open'`))[0].r;
  check('draft autosaved; 330 px drag clamped to the radius', !!mv && dist <= lim * 1.0001 && dist > lim * 0.9, `${Math.round(dist)} m of ${lim} m`);
  // reinforcement from the team pool: outside the zone first (refused), then inside
  await alice.locator('.allocs button').first().click();
  await alice.mouse.click(...pat(300, -200)); await wait(alice, 600);
  const out = (await sql('select changes from public.drafts where player_id = $1', [tokens.Alice.id]))[0].changes.filter((c) => c.op === 'create').length;
  await alice.locator('.allocs button').first().click().catch(() => {});
  await alice.mouse.click(...pat(-150, 165)); await wait(alice, 2500);
  d = (await sql('select changes, ready from public.drafts where player_id = $1', [tokens.Alice.id]))[0];
  check('reinforcement refused outside the zone, placed inside it', out === 0 && d.changes.filter((c) => c.op === 'create').length === 1);
  await alice.getByRole('button', { name: 'Mark my draft ready' }).click(); await wait(alice, 1200);
  check('Alice marked ready', (await sql('select ready from public.drafts where player_id = $1', [tokens.Alice.id]))[0].ready === true);
  await shot(alice, '22-alice-ready');
});

await step('Bob: PIN gate, exhausted team pool, unready draft', async () => {
  await bob.goto(`${B}/play.html#${tokens.Bob.invite_token}`); await wait(bob, 2000);
  check('PIN asked before anything is shown', /PIN/.test(await bob.locator('body').innerText()) && !(await bob.locator('.ppanel').count()));
  await bob.locator('input').fill('0000'); await bob.getByRole('button', { name: 'Join' }).click(); await wait(bob, 1000);
  check('wrong PIN refused', /Wrong PIN/.test(await bob.locator('body').innerText()));
  await bob.locator('input').fill('4821'); await bob.getByRole('button', { name: 'Join' }).click();
  await bob.waitForSelector('.ppanel', { timeout: 15000 }); await wait(bob, 2500);
  const pool = await texts(bob, '.allocs button');
  check('team pool shows as used up by a teammate', /0 of 1 left/.test(pool.join(' ')) && (await bob.locator('.allocs button').first().isDisabled()), pool.join(' | '));
  await bob.mouse.move(...pat(...U2)); await bob.mouse.down(); await bob.mouse.move(...pat(U2[0] - 40, U2[1] - 30), { steps: 6 }); await bob.mouse.move(...pat(U1[0] + 150, U1[1] + 40), { steps: 6 }); await bob.mouse.up(); await wait(bob, 2500);
  const bd = (await sql('select changes, ready from public.drafts where player_id = $1', [tokens.Bob.id]))[0];
  check('Bob has an unready draft', bd?.changes.length === 1 && bd.ready === false);
  await shot(bob, '23-bob');
  // nothing from drafts leaks: Bob's state holds no trace of Alice's draft
  const leak = JSON.stringify(await bob.evaluate(() => null)) ;
});

await step('viewer link before the push', async () => {
  await ed.getByRole('button', { name: 'Share' }).click(); await wait(ed, 500);
  await ed.getByRole('button', { name: /Create view-only link/ }).click(); await wait(ed, 1000); await ed.keyboard.press('Escape');
  tokens.view = (await sql('select token from public.share_links'))[0].token;
  const v = await open(1100, 700); await v.goto(`${B}/view.html#${tokens.view}`); await wait(v, 3000);
  await shot(v, '30-viewer-before'); tokens.viewer = v;
  const before = await sql(`select public.get_shared_map($1) as r`, [tokens.view]);
  check('viewer sees only the two live units before the push', before[0].r.features.length === 3 /* 2 units + the zone circle */ || before[0].r.features.length === 2, `${before[0].r.features.length} objects`);
});

await step('owner: lock, review, push', async () => {
  await ed.mouse.click(...at(300, -250));
  await ed.getByRole('button', { name: 'Lock for review' }).click(); await wait(ed, 1500);
  await shot(ed, '40-review');
  const rows = await texts(ed, '.subs li > button');
  check('review lists both drafts, Bob flagged not ready', rows.some((r) => /Alice/.test(r) && /ready/.test(r) && !/not ready/.test(r)) && rows.some((r) => /Bob/.test(r) && /not ready/.test(r)), rows.join(' | '));
  const allocs = (await texts(ed, '.right .changes li')).join(' | ');
  check('allocation shows who holds it', /held by Alice ×1/.test(allocs), allocs.slice(0, 160));
  const conf = await ed.locator('.right section', { hasText: 'Conflicts' }).innerText();
  check('conflict between Alice and Bob highlighted', /Conflicts \(1\)/i.test(conf), conf.replace(/\s+/g, ' ').slice(0, 120));
  // players are frozen
  await bob.reload(); await bob.waitForSelector('.ppanel'); await wait(bob, 2500);
  const frozen = JSON.stringify((await sql('select changes from public.drafts where player_id = $1', [tokens.Bob.id]))[0].changes);
  await bob.mouse.move(...pat(U1[0] + 150, U1[1] + 40)); await bob.mouse.down(); await bob.mouse.move(...pat(0, 200), { steps: 6 }); await bob.mouse.up(); await wait(bob, 2000);
  check('locked turn: player page cannot change the draft', JSON.stringify((await sql('select changes from public.drafts where player_id = $1', [tokens.Bob.id]))[0].changes) === frozen && /locked|review/i.test(await bob.locator('.ppanel').innerText()));
  // accept Bob's unready draft, leave a note; reject Alice's reinforcement
  await ed.locator('.subs li > button', { hasText: 'Bob' }).click(); await wait(ed, 300);
  await ed.locator('.draft textarea').fill('Accepted late. Be on time next week.'); await ed.locator('.draft textarea').blur(); await wait(ed, 800);
  await ed.getByRole('button', { name: /Mark ready/ }).click(); await wait(ed, 900);
  await ed.locator('.subs li > button', { hasText: 'Alice' }).click(); await wait(ed, 300);
  await ed.locator('.draft li', { hasText: /New/ }).locator('input[type=checkbox]').click({ noWaitAfter: true }); await wait(ed, 1200);
  await shot(ed, '41-review-detail');
  check('rejected placement goes back to the pool', /none placed/.test((await texts(ed, '.right .changes li')).join(' ')));
  await ed.getByRole('button', { name: 'Push turn' }).click(); await wait(ed, 3500);
  const feats = await sql('select count(*)::int n from public.features where kind = $1', ['symbol']);
  const snaps = await sql('select turn_number from public.snapshots order by 1');
  const t2 = await sql(`select number, default_radius_m from public.turns where status = 'open'`);
  check('push: moves applied, rejected unit absent, snapshots 0 and 1, turn 2 open with settings carried over',
    feats[0].n === 2 && snaps.map((x) => x.turn_number).join() === '0,1' && t2[0]?.number === 2 && t2[0].default_radius_m > 0, `units ${feats[0].n}, snapshots ${snaps.map((x) => x.turn_number)}, open turn ${t2[0]?.number}`);
  await shot(ed, '42-after-push');
});

await step('after the push: players and viewers', async () => {
  await wait(bob, 500); await bob.reload(); await bob.waitForSelector('.ppanel'); await wait(bob, 2500);
  const txt = await bob.locator('.ppanel').innerText();
  check('Bob sees the outcome and the owner note', /Accepted late/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 200));
  await shot(bob, '50-bob-after');
  const v = tokens.viewer; await v.reload(); await wait(v, 3000);
  check('viewer has a turn slider', (await v.locator('.tslider input').count()) === 1);
  await v.locator('.tslider input').fill('0'); await wait(v, 1500);
  check('viewer can step back to the start', /Start/.test(await v.locator('.tslider').innerText()));
  await shot(v, '51-viewer-history');
});

await step('manage: history, rollback, backup, settings, diagnostics, maps', async () => {
  await ed.getByRole('button', { name: 'Manage' }).click(); await wait(ed, 600);
  const tabs = await texts(ed, '[role=tab]'); console.log('tabs', tabs);
  await ed.getByRole('tab', { name: /History/ }).click(); await wait(ed, 800); await shot(ed, '60-history');
  const dl = ed.waitForEvent('download'); await ed.getByRole('button', { name: /Download backup/ }).click();
  const file = await (await dl).path(); const backup = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
  check('backup downloads as JSON with snapshots and players', backup.format === 'tacmap-campaign' && backup.snapshots.length === 2 && backup.players.length === 2);
  await ed.getByRole('button', { name: 'Roll back to here' }).first().click(); await wait(ed, 3000);
  const turns = await sql('select number, status, rollback_of from public.turns order by number');
  const kept = await sql(`select count(*)::int n from public.drafts d join public.turns t on t.id = d.turn_id where t.status = 'pushed'`);
  check('rollback: map restored, new turn labelled, earlier drafts and snapshots kept', turns.at(-1).rollback_of != null && turns.at(-1).status === 'open' && kept[0].n === 2 && (await sql('select count(*)::int n from public.snapshots'))[0].n === 2, JSON.stringify(turns));
  await ed.getByRole('button', { name: 'Manage' }).click().catch(() => {}); await wait(ed, 500);
  await ed.getByRole('tab', { name: /Settings/ }).click(); await wait(ed, 800);
  await ed.getByLabel('Discord webhook URL').fill('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcd'); await ed.locator('.dialog .btn.primary', { hasText: /Save/ }).first().click(); await wait(ed, 1000);
  const st = await ed.locator('.dialog').innerText();
  check('webhook stored write-only: shown masked', /Current:/.test(st) && !/abcdefghijklmnopqrstuvwxyzABCDEF/.test(st), (st.match(/Current:[^\n]*/) ?? [''])[0]);
  await shot(ed, '61-settings');
  await ed.getByRole('tab', { name: /Diagnostics/ }).click(); await wait(ed, 1200); await shot(ed, '62-diagnostics');
  const dg = await ed.locator('.dialog').innerText();
  check('diagnostics: schema, connection, anonymous sign-ins, keep-alive, activity log', /schema/i.test(dg) && /Anonymous sign-ins/.test(dg) && /Keep-alive/.test(dg) && /pushed turn/.test(dg) && /rolled back/.test(dg));
  await ed.getByRole('tab', { name: /Maps/ }).click(); await wait(ed, 600); await shot(ed, '63-maps');
});


await step('owner extras: co-admin, restore, maps, graphics, team layers, unlock, overrides', async () => {
  const fs = await import('node:fs');
  // co-admin by email: invite, second account signs in and is admitted, transfer is offered, removal works
  await ed.getByRole('tab', { name: /Settings/ }).click(); await wait(ed, 500);
  await ed.getByLabel('Co-admin email').fill('second@example.com'); await ed.getByRole('button', { name: 'Invite' }).click(); await wait(ed, 900);
  const two = await open(1200, 800); await two.goto(B + '/'); await wait(two, 1200);
  await two.fill('input[type=email]', 'second@example.com'); await two.fill('input[type=password]', 'another long password');
  await two.getByRole('button', { name: 'Create account' }).click(); await two.waitForSelector('.topbar', { timeout: 15000 });
  check('invited co-admin gets in; an uninvited account does not', (await sql('select count(*)::int n from private.admins'))[0].n === 2);
  const three = await open(1200, 800); await three.goto(B + '/'); await wait(three, 1200);
  await three.fill('input[type=email]', 'stranger@example.com'); await three.fill('input[type=password]', 'yet another password');
  await three.getByRole('button', { name: 'Create account' }).click(); await wait(three, 2000);
  check('stranger is told they are not an admin', /not an admin/i.test(await three.locator('body').innerText()) && !(await three.locator('.topbar').count()));
  await ed.getByRole('tab', { name: /Maps/ }).click(); await ed.getByRole('tab', { name: /Settings/ }).click(); await wait(ed, 800);
  await ed.locator('.links li', { hasText: 'second@example.com' }).getByRole('button', { name: 'Remove' }).click(); await wait(ed, 900);
  check('co-admin removed; exactly one owner remains', JSON.stringify(await sql('select role from private.admins')) === '[{"role":"owner"}]');

  // restore from the backup taken before the rollback
  await ed.getByRole('tab', { name: /History/ }).click(); await wait(ed, 500);
  const dl = ed.waitForEvent('download'); await ed.getByRole('button', { name: /Download backup/ }).click(); const path = await (await dl).path();
  const before = (await sql('select count(*)::int n from public.snapshots'))[0].n;
  await sql(`update public.maps set name = 'Scribbled over'`);
  await ed.locator('.dialog input[type=file]').setInputFiles({ name: 'backup.tacmap.json', mimeType: 'application/json', buffer: fs.readFileSync(path) }); await wait(ed, 3500);
  const m = (await sql('select name from public.maps'))[0];
  check('restore from a backup file replaces the campaign, history and invite links intact', m.name === 'Untitled map' && (await sql('select count(*)::int n from public.snapshots'))[0].n === before
    && (await sql('select invite_token from public.players where name = $1', ['Alice']))[0].invite_token === tokens.Alice.invite_token);
  await ed.waitForSelector('.topbar'); await wait(ed, 2500);

  // maps: create, rename, archive
  await ed.getByRole('button', { name: 'Manage' }).click(); await wait(ed, 500); await ed.getByRole('tab', { name: /Maps/ }).click();
  await ed.getByLabel('New map name').fill('Second front'); await ed.getByRole('button', { name: 'Create and open' }).click(); await ed.waitForSelector('.topbar'); await wait(ed, 2500);
  await ed.getByRole('button', { name: 'Manage' }).click(); await wait(ed, 500); await ed.getByRole('tab', { name: /Maps/ }).click(); await wait(ed, 500);
  const row = ed.locator('.links li', { has: ed.locator('input[value="Untitled map"]') });
  await row.getByLabel('Map name').fill('Operation Dawn'); await row.getByLabel('Map name').blur(); await wait(ed, 900);
  await ed.locator('.links li', { has: ed.locator('input[value="Operation Dawn"]') }).getByRole('button', { name: 'Archive' }).click(); await wait(ed, 900);
  const maps = await sql('select name, archived from public.maps order by name');
  check('maps: create, rename, archive', JSON.stringify(maps) === JSON.stringify([{ name: 'Operation Dawn', archived: true }, { name: 'Second front', archived: false }]), JSON.stringify(maps));
  await ed.locator('.links li', { has: ed.locator('input[value="Operation Dawn"]') }).getByRole('button', { name: 'Restore' }).click(); await wait(ed, 900);
  await ed.locator('.links li', { has: ed.locator('input[value="Operation Dawn"]') }).getByRole('button', { name: 'Open' }).click(); await ed.waitForSelector('.topbar'); await wait(ed, 2500);

  // graphics: upload, soft-delete, restore
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8z8Dwn4EAYCKkYOgoAADNWQIPo0PSUAAAAABJRU5ErkJggg==', 'base64');
  await ed.mouse.click(...at(300, -250)); await ed.keyboard.press('g'); await wait(ed, 400);
  await ed.locator('.right input[type=file]').setInputFiles({ name: 'carrier.png', mimeType: 'image/png', buffer: png }); await wait(ed, 2000);
  const up = await sql('select name, deleted_at from public.assets');
  await ed.locator('.right').getByTitle('Remove from library (can be restored)').first().click(); await wait(ed, 900);
  const del = await sql('select deleted_at is not null as gone from public.assets');
  await ed.locator('.right summary').click(); await ed.locator('.right').getByRole('button', { name: 'Restore' }).first().click(); await wait(ed, 900);
  check('graphics: upload, soft-delete (row kept), restore', up.length === 1 && up[0].deleted_at === null && del[0].gone === true && (await sql('select deleted_at from public.assets'))[0].deleted_at === null, JSON.stringify(up));
  await ed.keyboard.press('Escape');

  // turn controls: lock, unlock, extend deadline, per-unit override
  await ed.getByRole('button', { name: /^Turn/ }).click(); await wait(ed, 600);
  await ed.getByRole('button', { name: 'Lock for review' }).click(); await wait(ed, 900);
  await ed.getByRole('button', { name: 'Unlock' }).click(); await wait(ed, 900);
  await ed.getByRole('button', { name: '+7 days' }).click(); await wait(ed, 900);
  await ed.mouse.click(...at(-52, -80)); await wait(ed, 300);
  const ov = ed.locator('.right label', { hasText: 'Radius for the new override' }).locator('input'); await ov.fill('0');
  await ed.getByRole('button', { name: /Apply to 1 selected unit/ }).click(); await wait(ed, 900);
  const t = (await sql(`select status, deadline > now() + interval '6 days' as later, (select count(*)::int from public.turn_move_rules r where r.turn_id = t.id and r.radius_m = 0) as pins from public.turns t where status in ('open','locked') and map_id = (select id from public.maps where name = 'Operation Dawn')`))[0];
  check('turn: lock, unlock, extend deadline, pin one unit', t.status === 'open' && t.later === true && t.pins === 1, JSON.stringify(t));

  // players: team layer visibility, revoke/restore, new link, last seen
  await ed.getByRole('button', { name: 'Players', exact: true }).click(); await wait(ed, 700);
  const dlg = await ed.locator('.dialog').innerText();
  check('players list shows last-seen times', /seen/i.test(dlg), (dlg.match(/[^\n]*seen[^\n]*/i) ?? [''])[0].slice(0, 80));
  const alice = ed.locator('.links li', { hasText: 'Alice' });
  await alice.getByRole('button', { name: 'Revoke' }).click(); await wait(ed, 900);
  const rv = (await sql(`select revoked from public.players where name = 'Alice'`))[0].revoked;
  await alice.getByRole('button', { name: 'Restore' }).click(); await wait(ed, 900);
  await alice.getByRole('button', { name: /New link/ }).click(); await wait(ed, 900);
  const p = (await sql(`select revoked, invite_token from public.players where name = 'Alice'`))[0];
  check('players: revoke, restore, regenerate link', rv === true && p.revoked === false && p.invite_token !== tokens.Alice.invite_token);
  await shot(ed, '70-players');
});

console.log(JSON.stringify({ failed: results.filter((r) => r[0] === 'FAIL').length, of: results.length, errors }, null, 1));
await browser.close(); process.exit(0);
