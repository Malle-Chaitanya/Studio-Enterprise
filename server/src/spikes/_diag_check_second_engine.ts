import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'geminienterprise_1787125371767';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const agentsRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/231705905417/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log('Agents on second engine:', agentsRes.status, (await agentsRes.text()).slice(0, 300));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
