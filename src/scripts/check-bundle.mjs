// Fails the build if anything that must stay server-side ended up in the files we are about to publish.
// Everything in the release folder is public: the Supabase URL and the anon / publishable key are meant to be
// there (row level security does the protecting). A service-role or secret key never is.
//
//   node scripts/check-bundle.mjs [folder]   scan the built site (default: dist/)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SECRET_PREFIX = /sb_secret_[A-Za-z0-9_-]{8,}/g;
const OTHER = [
  [/SUPABASE_SERVICE_ROLE_KEY|service_role_key/gi, 'a service-role key variable name'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'a private key'],
];

/** Problems found in one piece of text. */
export function findSecrets(text) {
  const found = [];
  for (const token of text.match(JWT) ?? []) {
    let role = '';
    try {
      role = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role ?? '';
    } catch {
      continue; // not a real JWT
    }
    if (role !== 'anon') found.push(`a JWT with role "${role || 'unknown'}" (only the anon key may ship)`);
  }
  if (SECRET_PREFIX.test(text)) found.push('a Supabase secret key (sb_secret_…)');
  SECRET_PREFIX.lastIndex = 0;
  for (const [re, what] of OTHER) {
    if (re.test(text)) found.push(what);
    re.lastIndex = 0;
  }
  return found;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js|html|css|json|map|txt)$/.test(name)) yield p;
  }
}

function main() {
  const dir = process.argv[2] ?? 'dist';
  const problems = [];
  let n = 0;
  for (const file of files(dir)) {
    n++;
    for (const p of findSecrets(readFileSync(file, 'utf8'))) problems.push(`${file} contains ${p}`);
  }
  if (!n) problems.push(`${dir}/ is empty: run the build first`);
  else console.log(`check-bundle: scanned ${n} files in ${dir}/`);

  if (problems.length) {
    console.error(`\nRefusing to publish:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log('check-bundle: no server-side secrets found');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) main();
