/**
 * Look up a GCP project's display name + ID from its number, using the current
 * service account (Cloud Resource Manager). READ-ONLY.
 *
 *   npx tsx src/_diag_projname.ts <projectNumber>   e.g. 860501065102
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const PROJECT = process.argv[2];

async function main() {
  if (!PROJECT) throw new Error('usage: npx tsx src/_diag_projname.ts <projectNumber>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);

  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) {
    console.log(`lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    if (res.status === 403) console.log('→ SA lacks resourcemanager.projects.get on this project (name lookup only; migration is unaffected).');
    process.exit(1);
  }
  const p = (await res.json()) as { displayName?: string; projectId?: string; state?: string; name?: string };
  console.log(`\nProject number: ${PROJECT}`);
  console.log(`Display name:   ${p.displayName ?? '(none)'}`);
  console.log(`Project ID:     ${p.projectId ?? '(none)'}`);
  console.log(`State:          ${p.state ?? '(none)'}`);
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
