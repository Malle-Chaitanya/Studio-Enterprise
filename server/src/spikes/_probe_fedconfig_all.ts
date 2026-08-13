/** federatedknowledgeconfigurations across every reachable env. Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').findOne<any>({ tenantId: { $exists: true } });
for (const e of s.environments ?? []) {
  let tok: string;
  try { tok = await clientCredsToken(s.tenantId, e.url); } catch { console.log(`${e.name}: token failed`); continue; }
  const r = await fetch(`${e.url}/api/data/v9.2/federatedknowledgeconfigurations?$top=20`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  });
  const t = await r.text();
  const n = (() => { try { return (JSON.parse(t).value ?? []).length; } catch { return -1; } })();
  console.log(`\n=== ${e.name} (${e.url}) HTTP ${r.status} rows=${n}`);
  if (n > 0) console.log(t.slice(0, 1200));
  else if (r.status !== 200) console.log(t.slice(0, 200));
}
process.exit(0);
