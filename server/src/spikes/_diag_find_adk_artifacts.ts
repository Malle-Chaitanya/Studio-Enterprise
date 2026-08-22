/** Where did today's two ADK deploys stage their pickled agent? ADK_STAGING_BUCKET holds no
 *  objects from today, so the SDK used something else. List every bucket in the project and
 *  the newest objects in any that look like Vertex staging — a single fixed object name
 *  written twice in the same minute is two deploys overwriting each other. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const auth = { Authorization: `Bearer ${token}` };

const br = await fetch('https://storage.googleapis.com/storage/v1/b?project=231705905417&maxResults=100', { headers: auth });
if (!br.ok) { console.log(`buckets -> ${br.status} ${(await br.text()).slice(0, 200)}`); process.exit(0); }
const buckets = ((await br.json()) as { items?: Array<{ name: string }> }).items ?? [];
console.log(`${buckets.length} bucket(s): ${buckets.map((b) => b.name).join(', ')}\n`);

for (const b of buckets) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${b.name}/o?maxResults=1000`, { headers: auth });
  if (!r.ok) { console.log(`  ${b.name}: list -> ${r.status}`); continue; }
  const items = ((await r.json()) as { items?: Array<Record<string, string>> }).items ?? [];
  const today = items.filter((o) => String(o.updated).startsWith('2026-08-21'));
  console.log(`${b.name}: ${items.length} object(s), ${today.length} written TODAY`);
  for (const o of today.sort((a, b2) => String(a.updated).localeCompare(String(b2.updated)))) {
    console.log(`    ${String(o.updated).slice(11, 19)}  gen=${o.generation}  ${(Number(o.size) / 1024).toFixed(0).padStart(7)}KB  ${o.name}`);
  }
}
process.exit(0);
