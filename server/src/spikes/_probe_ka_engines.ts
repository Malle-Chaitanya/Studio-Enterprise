/** Any half-created Knowledge Assistant left in the destination project? */
import { getSaToken } from '../auth/google.js';
const P = 'agentmigrations', L = 'us-central1';
const t = await getSaToken();
const r = await fetch(`https://${L}-aiplatform.googleapis.com/v1beta1/projects/${P}/locations/${L}/reasoningEngines`,
  { headers: { Authorization: `Bearer ${t}` } });
const j = await r.json() as { reasoningEngines?: Array<{ name: string; displayName?: string; createTime?: string; updateTime?: string }> };
const all = j.reasoningEngines ?? [];
console.log('total engines:', all.length);
for (const e of all) {
  if (!/knowledge|workmate/i.test(e.displayName ?? '')) continue;
  console.log(`  ${e.displayName}  created=${e.createTime}  updated=${e.updateTime}`);
  console.log(`    ${e.name.split('/').pop()}`);
}
