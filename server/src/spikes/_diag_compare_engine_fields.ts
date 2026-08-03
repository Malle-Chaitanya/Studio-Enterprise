import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function dump(label: string, project: string, engine: string, saToken: string) {
  const url = `${HOST}/projects/${project}/locations/global/collections/default_collection/engines/${engine}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = await res.json();
  console.log(`\n=== ${label} (${project}/${engine}) ===`);
  console.log(JSON.stringify(json, null, 2));
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;

  const businessToken = await getSaToken(s?.gEmail || undefined);
  await dump('BUSINESS (sonorous-lightning-t224x)', '521161651560', 'agentspace-engine', businessToken);

  const standardToken = await getSaToken();
  await dump('STANDARD (studio-enterprise-migration)', '231705905417', 'gemini-enterprise-17847887_1784788734248', standardToken);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
