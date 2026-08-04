import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session/project');
  const project = s.geminiProject;
  const saToken = await getSaToken(s.gEmail);
  const base = `${HOST}/projects/${project}/locations/global/collections/default_collection`;

  const engRes = await fetch(`${base}/engines/agentspace-engine`, { headers: { Authorization: `Bearer ${saToken}` } });
  const eng = (await engRes.json()) as { dataStoreIds?: string[]; displayName?: string };
  console.log('Engine dataStoreIds:', JSON.stringify(eng.dataStoreIds ?? [], null, 2));

  const dsRes = await fetch(`${base}/dataStores?pageSize=100`, { headers: { Authorization: `Bearer ${saToken}` } });
  const ds = (await dsRes.json()) as { dataStores?: { name?: string; displayName?: string; solutionTypes?: string[] }[] };
  console.log('\nAll data stores in project/collection:');
  for (const d of ds.dataStores ?? []) {
    console.log(`  - ${d.displayName}  (${d.name})`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
