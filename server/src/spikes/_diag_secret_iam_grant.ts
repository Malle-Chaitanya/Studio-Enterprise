/**
 * Can the Reasoning Engine service agent actually READ the connector secrets?
 *
 * This is the single point where a migration "succeeds" and the agent still cannot use any
 * connector: the tools deploy, the credentials exist, and every call 403s at inference
 * because the RE service agent was never granted secretAccessor. The deploy only WARNS about
 * it, so it is invisible until a customer asks the agent a question and gets an apology.
 *
 * Reports, per connector secret, whether the binding is in place — and whether a
 * project-wide grant exists that would cover it anyway.
 *
 *   cd server && npx tsx src/spikes/_diag_secret_iam_grant.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { hasProjectWideSecretAccess } from '../services/connectorPreflight.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string; geminiProject?: string } | null;
const appUserId = s?.appUserId ?? '';
const project = s?.geminiProject ?? '';
const saToken = await getSaToken();

// Project number -> the RE service agent identity the deploy tries to grant.
const pr = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const projectNumber = ((await pr.json()) as { projectNumber?: string }).projectNumber;
const agent = `service-${projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
console.log(`project        : ${project} (${projectNumber})`);
console.log(`RE service agent: ${agent}\n`);

// A PROJECT-WIDE grant does not appear in any per-secret policy. Checking only per-secret
// (as this spike first did) reported every secret as MISS while the engine could in fact read
// them all — a confidently wrong answer that sends someone to fix what is not broken.
const projectWide = await hasProjectWideSecretAccess(saToken, project, `serviceAccount:${agent}`);
console.log(`project-wide secretAccessor: ${projectWide ? 'GRANTED (covers every secret below)' : 'not granted'}
`);

const saved = await listConnectorCredentials(appUserId);
const secretIds = [...new Set(saved.flatMap((c) => Object.values(c.secretIds ?? {})))];
console.log(`${secretIds.length} distinct connector secret(s)\n`);

let ok = 0;
const missing: string[] = [];
for (const secretId of secretIds) {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}:getIamPolicy`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  if (!res.ok) {
    console.log(`  ?    ${secretId}  (getIamPolicy ${res.status})`);
    continue;
  }
  const pol = (await res.json()) as { bindings?: Array<{ role: string; members?: string[] }> };
  const granted = (pol.bindings ?? []).some(
    (b) => b.role === 'roles/secretmanager.secretAccessor' && (b.members ?? []).includes(`serviceAccount:${agent}`),
  );
  const usable = granted || projectWide;
  if (usable) { ok++; } else { missing.push(secretId); }
  console.log(`  ${usable ? 'OK  ' : 'MISS'} ${secretId}${!granted && projectWide ? '  (via project-wide grant)' : ''}`);
}

console.log(`\n${ok}/${secretIds.length} secrets readable by the RE service agent`);
if (missing.length) {
  console.log('\nEvery deployed agent using one of these will 403 at inference. Either grant');
  console.log('per-secret, or once project-wide:');
  console.log(`  gcloud projects add-iam-policy-binding ${project} \\`);
  console.log(`    --member="serviceAccount:${agent}" \\`);
  console.log('    --role="roles/secretmanager.secretAccessor"');
}
process.exit(0);
