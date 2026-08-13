/** Can we recover the real Confluence space WITHOUT asking the customer? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENV = 'https://org32322095.crm.dynamics.com';
const SUFFIX = 'O1TAfpFAnMDYe8I4tLvGu';
const SKILLCFG = 'MigrationKnowledgeSource_O1TAfpFAnMDYe8I4tLvGu';

await connectMongo();
const s = await getDb().collection('migrationSessions').findOne<any>({ tenantId: { $exists: true } });
if (!s?.tenantId) { console.log('no tenantId in any session'); process.exit(0); }
const tok = await clientCredsToken(s.tenantId, ENV);

async function q(url: string, label: string) {
  const r = await fetch(`${ENV}/api/data/v9.2/${url}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  });
  const t = await r.text();
  console.log(`\n--- ${label}: HTTP ${r.status}`);
  console.log(t.slice(0, 1500));
}

// 1. Connection references — do they name the Confluence site/space?
await q(`connectionreferences?$select=connectionreferencedisplayname,connectionreferencelogicalname,connectorid,connectionid&$top=25`, 'connectionreferences');

// 2. Does any botcomponent mention the skillConfig id (beyond the source itself)?
await q(`botcomponents?$select=name,componenttype,schemaname&$filter=contains(schemaname,'${SUFFIX}')&$top=10`, 'botcomponents by suffix');

// 3. The knowledge source component's FULL data — anything beyond the name?
await q(`botcomponents?$select=name,componenttype,schemaname,data&$filter=contains(schemaname,'MigrationKnowledgeSource')&$top=3`, 'the KS component data');
process.exit(0);
