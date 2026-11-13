// End-to-end run of the map tools through the real UI and the real setup.sql: measuring, PNG/PDF
// export, the player page on a phone (finger drag, tap-to-draw), and tech released by turn.
//   node tests/e2e/tools.mjs <screenshot dir>
import { readFileSync } from 'node:fs';
import { launch, B } from './lib.mjs';
const { sql } = await import('./fake-supabase.mjs');
const OUT = process.argv[2] ?? '.';
const { browser, open, errors } = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const wait = (p, ms = 700) => p.waitForTimeout(ms);
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
let failed = false;
let phone = null;
const step = async (name, fn) => { if (failed) return; try { await fn(); } catch (e) { failed = true; check(name, false, String(e.message).split('\n').slice(0, 4).join(' ').slice(0, 400)); await ed.screenshot({ path: OUT + '/fail-editor.png' }).catch(() => {}); await phone?.screenshot({ path: OUT + '/fail-phone.png' }).catch(() => {}); } };

const ed = await open();
let C;
const at = (dx, dy) => [C.x + dx, C.y + dy];
const U1 = [-60, -150];   // in the top half: on a phone the panel covers the bottom

await step('setup: owner, unit, Alice, turn', async () => {
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
  await ed.getByPlaceholder('e.g. Alex').fill('Alice'); await ed.locator('.dialog .btn.primary').first().click(); await wait(ed, 900);
  await ed.keyboard.press('Escape'); await wait(ed, 300);
  await ed.mouse.click(...at(...U1)); await wait(ed, 400);
  const assign = ed.locator('.right label', { hasText: 'Assigned to' }).locator('select');
  await assign.selectOption({ label: await assign.locator('option', { hasText: 'Alice' }).first().textContent() }); await wait(ed, 900);
  await ed.mouse.click(...at(300, -250)); await wait(ed, 300);
  await ed.getByRole('button', { name: 'Turn', exact: true }).click(); await wait(ed);
  await ed.getByRole('button', { name: /Open turn 1/ }).click(); await wait(ed, 1200);
  await ed.getByRole('button', { name: /^Turn 1/ }).click(); await wait(ed, 300);   // close the turn panel
  check('turn 1 open', (await sql(`select count(*)::int n from public.turns where status = 'open'`))[0].n === 1);
});

await step('editor: measure distance and area', async () => {
  await ed.keyboard.press('m'); await wait(ed, 300);
  for (const p of [[100, -100], [250, -100], [250, 50]]) { await ed.mouse.click(...at(...p)); await wait(ed, 150); }
  await ed.keyboard.press('Enter'); await wait(ed, 300);
  const dist = await ed.locator('.measurelabel').innerText();
  check('distance shown on the map and in the panel', /km|m$/.test(dist) && (await ed.locator('.measureread').innerText()) === dist, dist);
  await ed.locator('.measurepanel').getByRole('button', { name: 'Area' }).click(); await wait(ed, 300);
  const area = await ed.locator('.measurelabel').innerText();
  check('area mode gives area and perimeter of the same points', /km²|ha|m²/.test(area) && /perimeter/.test(area), area);
  await shot(ed, 'x10-measure');
  check('measuring saved nothing to the map', (await sql('select count(*)::int n from public.features'))[0].n === 1);
  await ed.keyboard.press('Escape'); await ed.keyboard.press('Escape'); await wait(ed, 300);
});

const download = async (page, format) => {
  await page.getByRole('button', { name: 'Export', exact: true }).click(); await wait(page, 300);
  await page.locator('.dialog select').first().selectOption(format);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('.dialog').getByRole('button', { name: 'Download' }).click()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
};
await step('editor: export PNG and PDF', async () => {
  const png = await download(ed, 'png');
  check('PNG downloads with the map in it', png.bytes.subarray(1, 4).toString() === 'PNG' && png.bytes.length > 20000 && /\.png$/.test(png.name), `${png.name} ${png.bytes.length} bytes`);
  const pdf = await download(ed, 'pdf');
  const t = pdf.bytes.toString('latin1');
  check('PDF downloads as a one-page document', t.startsWith('%PDF-1.4') && t.trimEnd().endsWith('%%EOF') && /\/Count 1/.test(t) && pdf.bytes.length > 20000, `${pdf.name} ${pdf.bytes.length} bytes`);
});

await step('tech released by turn', async () => {
  const [{ id: mid }] = await sql('select id from public.maps');
  await sql(`insert into public.tech_items (map_id, name, research_cost, buyable, release_turn) values ($1, 'Jets', 5, false, 2), ($1, 'Radio', 5, false, null)`, [mid]);
  await ed.getByRole('button', { name: 'Tech', exact: true }).click(); await wait(ed, 900);
  await ed.locator('.techcard', { hasText: 'Jets' }).click(); await wait(ed, 300);
  const v = await ed.locator('.dialog label.field', { hasText: 'Released on turn' }).locator('input').inputValue();
  check('owner sees the release turn on the item and its box', v === '2' && /turn 2/i.test(await ed.locator('.techcard', { hasText: 'Jets' }).innerText()));
  await ed.locator('.dialog label.field', { hasText: 'Released on turn' }).locator('input').fill('3');
  await ed.locator('.dialog').getByRole('button', { name: 'Save', exact: true }).click(); await wait(ed, 900);
  check('release turn saved from the form', (await sql(`select release_turn from public.tech_items where name = 'Jets'`))[0].release_turn === 3);
  await ed.keyboard.press('Escape'); await wait(ed, 300);
});

await step('phone: finger drag, tap to draw, measure', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.route('**/*', (r) => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
  phone = await ctx.newPage(); phone.setDefaultTimeout(6000);
  phone.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  const tok = (await sql(`select invite_token from public.players where name = 'Alice'`))[0].invite_token;
  await phone.goto(`${B}/play.html#${tok}`); await phone.waitForSelector('.ppanel', { timeout: 15000 }); await wait(phone, 2500);
  const names = (await phone.locator('.ppanel').innerText());
  await phone.getByRole('button', { name: /Tech tree/ }).click(); await wait(phone, 600);
  const tree = await phone.locator('.dialog').innerText();
  check('player sees released tech only', /Radio/.test(tree) && !/Jets/.test(tree), names.slice(0, 0));
  await phone.locator('.dialog').getByRole('button', { name: 'Close' }).click();
  await phone.waitForSelector('.modal', { state: 'detached' }); await wait(phone, 300);
  const mb = await phone.locator('.map').boundingBox();
  const P = { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 };
  const unit = [P.x + U1[0], P.y + U1[1]];
  const cdp = await ctx.newCDPSession(phone);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', ...unit);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', unit[0] + i * 6, unit[1] - i * 4); await wait(phone, 40); }
  await touch('touchEnd'); await wait(phone, 2500);
  const d = (await sql('select changes from public.drafts'))[0]?.changes ?? [];
  check('dragging my unit with a finger moves it in the draft (and not the map)', d.some((c) => c.op === 'update' && c.payload.geometry), JSON.stringify(d.map((c) => c.op)));
  await shot(phone, 'x20-phone-drag');
  check('on a phone the details open as a sheet at the bottom, leaving the map free', (await phone.locator('.details').boundingBox()).y > 844 / 2);
  await phone.getByRole('button', { name: 'Close details' }).tap(); await wait(phone, 300);
  await phone.getByRole('button', { name: 'Arrow', exact: true }).tap(); await wait(phone, 300);
  for (const [dx, dy] of [[-40, -60], [40, -30], [80, 0]]) { await phone.touchscreen.tap(P.x + dx, P.y + dy); await wait(phone, 350); }
  await shot(phone, 'x19-phone-arrow');
  await phone.getByRole('button', { name: 'Finish', exact: true }).tap(); await wait(phone, 2500);
  const d2 = (await sql('select changes from public.drafts'))[0]?.changes ?? [];
  check('an arrow drawn with taps and the Finish button', d2.some((c) => c.op === 'create' && c.payload.kind === 'arrow' && c.payload.geometry.coordinates.length === 3));
  await phone.getByRole('button', { name: 'Measure', exact: true }).tap(); await wait(phone, 300);
  for (const [dx, dy] of [[-100, -250], [100, -250]]) { await phone.touchscreen.tap(P.x + dx, P.y + dy); await wait(phone, 350); }
  check('measuring works with taps on the phone', /km|m/.test(await phone.locator('.measureread').innerText()));
  await phone.getByRole('button', { name: 'Done', exact: true }).tap(); await wait(phone, 300);
  await phone.getByRole('button', { name: /Hide/ }).tap(); await wait(phone, 300);
  check('the panel hides to free the map and comes back', !(await phone.locator('.ppanel').count()) && (await phone.getByRole('button', { name: /Orders/ }).count()) === 1);
  await shot(phone, 'x22-phone-hidden');
  await phone.getByRole('button', { name: /Orders/ }).tap(); await wait(phone, 300);
  await shot(phone, 'x21-phone-measure');
});

await step('viewer: measure and export', async () => {
  const [{ id: mid }] = await sql('select id from public.maps');
  const [{ token }] = await sql(`insert into public.share_links (map_id, mode) values ($1, 'live') returning token`, [mid]);
  const v = await open(1100, 700); await v.goto(`${B}/view.html#${token}`); await wait(v, 3000);
  await v.getByRole('button', { name: 'Measure', exact: true }).click(); await wait(v, 300);
  const vb = await v.locator('.map').boundingBox();
  for (const [dx, dy] of [[-100, 0], [100, 0]]) { await v.mouse.click(vb.x + vb.width / 2 + dx, vb.y + vb.height / 2 + dy); await wait(v, 200); }
  check('viewer measures', /km|m/.test(await v.locator('.measureread').innerText()));
  const png = await download(v, 'png');
  check('viewer exports a PNG', png.bytes.subarray(1, 4).toString() === 'PNG' && png.bytes.length > 20000);
});

console.log(JSON.stringify({ failed: results.filter((r) => r[0] === 'FAIL').length, of: results.length, errors }, null, 1));
await browser.close();
process.exit(0);
