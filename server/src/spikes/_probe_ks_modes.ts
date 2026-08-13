/** What kinds/modes do knowledge sources actually declare, across both environments? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

await connectMongo();
const s = await getDb().collection('migrationSessions').findOne<any>({ tenantId: { $exists: true } });
const envs: string[] = (s.environments ?? []).map((e: any) => e.url);
const kindCount = new Map<string, number>();
const modeByKind = new Map<string, Map<string, number>>();
const samples: string[] = [];

for (const env of envs) {
  let tok: string;
  try { tok = await clientCredsToken(s.tenantId, env); } catch (e) { console.log(`${env}: token failed`); continue; }
  const r = await fetch(`${env}/api/data/v9.2/botcomponents?$select=name,data&$filter=componenttype eq 16&$top=500`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  });
  if (!r.ok) { console.log(`${env}: HTTP ${r.status}`); continue; }
  const rows = ((await r.json()) as any).value ?? [];
  console.log(`${env}: ${rows.length} knowledge source component(s)`);
  for (const row of rows) {
    const d = String(row.data ?? '');
    const kind = /source:\s*[\s\S]*?kind:\s*(\w+)/.exec(d)?.[1] ?? '(none)';
    const mode = /mode:\s*(\w+)/.exec(d)?.[1] ?? '(no mode)';
    kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
    if (!modeByKind.has(kind)) modeByKind.set(kind, new Map());
    const m = modeByKind.get(kind)!;
    m.set(mode, (m.get(mode) ?? 0) + 1);
    if (/SharePoint|OneDrive/i.test(kind) && samples.length < 4) samples.push(`--- ${row.name}\n${d.replace(/\r/g, '').slice(0, 500)}`);
  }
}
console.log('\nKIND -> MODE distribution');
for (const [k, n] of [...kindCount].sort((a, b) => b[1] - a[1])) {
  const modes = [...(modeByKind.get(k) ?? [])].map(([m, c]) => `${m}=${c}`).join(', ');
  console.log(`  ${k}: ${n}   modes: ${modes}`);
}
console.log('\nSHAREPOINT SAMPLES');
for (const x of samples) console.log(x);
process.exit(0);
