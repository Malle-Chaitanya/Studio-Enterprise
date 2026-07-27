/**
 * Preflight a Gemini project before pointing the migrator at it: with the
 * current service account, list the engines (apps) in the project. Tells us in
 * one shot: (a) can the SA even access this project, (b) what engine ids exist,
 * (c) their type + attached data stores.
 *
 *   npx tsx src/_diag_project.ts <projectNumber>   e.g. 396677554383
 *
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const PROJECT = process.argv[2];

async function main() {
  if (!PROJECT) throw new Error('usage: npx tsx src/_diag_project.ts <projectNumber>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = s?.gEmail;
  console.log(`Project: ${PROJECT}`);
  console.log(`Service account impersonating: ${impersonate ?? '(default / none)'}\n`);

  let saToken: string;
  try {
    saToken = await getSaToken(impersonate || undefined);
  } catch (e) {
    console.log(`FAILED to mint SA token: ${(e as Error).message}`);
    process.exit(1);
  }

  const url = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/engines`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
    console.log(`list engines → ${res.status}`);
    console.log(`  ${body}\n`);
    if (res.status === 403) console.log('→ The service account/identity CANNOT access this project. Grant it IAM access (Discovery Engine Admin) in this project, or use a project its identity already owns.');
    if (res.status === 404) console.log('→ No default_collection/engines here — this project may not have Gemini Enterprise/Agentspace provisioned yet.');
    process.exit(1);
  }

  const engines = ((await res.json()) as { engines?: Record<string, unknown>[] }).engines ?? [];
  if (!engines.length) {
    console.log('✅ SA can access the project, but it has NO engines — create a Gemini Enterprise app (and assign seats) first.');
    process.exit(0);
  }
  console.log(`✅ SA can access the project. ${engines.length} engine(s):\n`);
  for (const e of engines) {
    const id = String(e.name).split('/').pop();
    console.log(`  - engine id: ${id}`);
    console.log(`    displayName: ${e.displayName}  solutionType: ${e.solutionType}`);
    console.log(`    dataStoreIds: ${JSON.stringify(e.dataStoreIds ?? [])}`);
    console.log(`    → to use: GEMINI_PROJECT_FALLBACK=${PROJECT}  GEMINI_ENGINE=${id}\n`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
