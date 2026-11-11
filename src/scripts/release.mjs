// Builds the static site and publishes it into the repository root, which GitHub Pages serves
// ("Deploy from branch: main / root").
//   npm run release
// Steps: typecheck, vite build into src/dist, add setup.sql / README / keep-alive workflow / .nojekyll,
// run the safety checks on dist, then replace the site files in the repository root.
// The root config.js holds the live Supabase settings and is never overwritten (only created if missing).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ROOT = '..';
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('npx tsc');
run('npx vite build');                      // empties dist/ first

cpSync('supabase/setup.sql', `${DIST}/setup.sql`);
cpSync('README.md', `${DIST}/README.md`);
mkdirSync(`${DIST}/.github/workflows`, { recursive: true });
cpSync('deploy/keepalive.yml', `${DIST}/.github/workflows/keepalive.yml`);
writeFileSync(`${DIST}/.nojekyll`, '');     // tells GitHub Pages to serve the folder as is

// Nothing in the site itself may depend on hidden or underscore-prefixed files surviving an upload.
const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === join(DIST, '.github') || p === join(DIST, '.nojekyll')) continue;
    if (/^[._]/.test(name)) bad.push(p);
    if (statSync(p).isDirectory()) walk(p);
  }
};
walk(DIST);
if (bad.length) {
  console.error(`\nThese files would be dropped by GitHub Pages without .nojekyll:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
if (!existsSync(`${DIST}/config.js`)) {
  console.error(`${DIST}/config.js is missing`);
  process.exit(1);
}
run(`node scripts/check-bundle.mjs ${DIST}`);

// Publish: old hashed bundles go, everything else is overwritten in place.
rmSync(join(ROOT, 'assets'), { recursive: true, force: true });
for (const name of readdirSync(DIST)) {
  const target = join(ROOT, name);
  if (name === 'config.js' && existsSync(target)) continue;
  cpSync(join(DIST, name), target, { recursive: true });
}
console.log('\nSite published to the repository root. Commit and push; Pages redeploys from main.');
