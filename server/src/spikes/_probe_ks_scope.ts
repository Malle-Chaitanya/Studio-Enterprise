/** Is the Confluence SPACE recorded anywhere in the agent's own components? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENV = 'https://org32322095.crm.dynamics.com';
const BOT = 'bdf9b817-9b90-f111-b8da-0022480b1f83'; // AA
await connectMongo();
const s = await getDb().collection('migrationSessions').findOne<any>({ tenantId: { $exists: true } });
const tok = await clientCredsToken(s.tenantId, ENV);

const r = await fetch(
  `${ENV}/api/data/v9.2/botcomponents?$select=name,componenttype,schemaname,data&$filter=_parentbotid_value eq ${BOT}&$top=200`,
  { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } },
);
const rows = ((await r.json()) as any).value ?? [];
console.log(`components: ${rows.length}`);
const NEEDLES = ['O1TAfpFAnMDYe8I4tLvGu', 'spaceKey', 'space', 'cf2020', 'atlassian', 'dDyVv'];
for (const row of rows) {
  const blob = `${row.data ?? ''}`;
  const hits = NEEDLES.filter((n) => blob.toLowerCase().includes(n.toLowerCase()));
  if (!hits.length) continue;
  console.log(`\n### ${row.name} (type ${row.componenttype}) hits=${hits.join(',')}`);
  for (const n of hits) {
    const i = blob.toLowerCase().indexOf(n.toLowerCase());
    console.log(`   …${blob.slice(Math.max(0, i - 220), i + 260).replace(/\r/g, '')}…`);
  }
}
process.exit(0);
