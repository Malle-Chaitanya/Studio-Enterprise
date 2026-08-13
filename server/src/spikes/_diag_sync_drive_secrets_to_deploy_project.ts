/** Root cause was confirmed: Drive secrets exist in 72860638029 but not in
 *  231705905417, where "AA" actually deployed (a stale per-environment destination
 *  override). The user wants THIS project (231705905417) to be the one that works,
 *  so: copy the two secret values across, grant the Reasoning Engine service agent
 *  read access on them in that project, then re-query the live agent to prove Drive
 *  actually fetches.
 *  npx tsx src/spikes/_diag_sync_drive_secrets_to_deploy_project.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret, upsertSecret, grantSecretAccessToServiceAgent } from '../services/secretManager.js';

const SOURCE_PROJECT = '72860638029';
const TARGET_PROJECT = '231705905417';
const RE_SERVICE_AGENT = `service-${TARGET_PROJECT}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;

async function main() {
  await connectMongo();
  const rec = await getDb().collection('connectorCredentials').findOne({ connectorId: 'shared_googledrive' });
  if (!rec) { console.log('NO connectorCredentials RECORD FOUND'); process.exit(1); }
  const secretIds = rec.secretIds as Record<string, string>;

  const saToken = await getSaToken('zara@storefuze.com');

  console.log('--- copying secret values ---');
  for (const [field, secretId] of Object.entries(secretIds)) {
    const got = await getEntraSecret(saToken, `projects/${SOURCE_PROJECT}/secrets/${secretId}/versions/latest`);
    if (!got.ok || !got.plaintext) {
      console.log(`  ${field}: FAILED TO READ FROM SOURCE — ${got.error}`);
      continue;
    }
    await upsertSecret(saToken, TARGET_PROJECT, secretId, got.plaintext);
    console.log(`  ${field}: copied (${got.plaintext.length} chars) -> ${TARGET_PROJECT}`);
  }

  console.log('\n--- granting Reasoning Engine service agent access ---');
  const grant = await grantSecretAccessToServiceAgent(saToken, TARGET_PROJECT, Object.values(secretIds), RE_SERVICE_AGENT);
  console.log(JSON.stringify(grant, null, 2));

  console.log('\nDone. Existing deployed agents read secrets fresh on every tool call (no redeploy needed) — ready to re-query.');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
