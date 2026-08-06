/** List page titles in the given space keys, to craft grounded test questions.
 *  npx tsx src/spikes/_diag_cf_titles.ts ITINFRA SALES */
import 'dotenv/config';
const BASE = process.env.CONFLUENCE_BASE_URL!, EMAIL = process.env.CONFLUENCE_EMAIL!, TOKEN = process.env.CONFLUENCE_TOKEN!;
const auth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`, 'utf-8').toString('base64');
for (const key of process.argv.slice(2)) {
  const r = await fetch(`${BASE}/wiki/rest/api/content?spaceKey=${key}&limit=50&expand=version`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const j = await r.json() as { results?: Array<{ title: string; type: string }> };
  console.log(`\n[${key}] ${(j.results ?? []).length} items`);
  for (const p of j.results ?? []) console.log(`  - ${p.title}`);
}
