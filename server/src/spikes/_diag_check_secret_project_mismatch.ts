/** The Drive tool's live query failed with "auth failed: HTTP Error 404: Not Found".
 *  Theory: credentials were saved to Secret Manager under session.geminiProject
 *  (72860638029), but the deployed Reasoning Engine actually lives in project
 *  231705905417 (the stale per-environment destination override) — so the secret
 *  literally does not exist in the project the container reads from. Confirm by
 *  checking the secret's real location and existence in both projects.
 *  npx tsx src/spikes/_diag_check_secret_project_mismatch.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

async function secretExists(saToken: string, project: string, secretId: string): Promise<{ exists: boolean; status: number }> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  return { exists: res.ok, status: res.status };
}

async function main() {
  await connectMongo();
  const rec = await getDb().collection('connectorCredentials').findOne({ connectorId: 'shared_googledrive' });
  if (!rec) { console.log('NO connectorCredentials RECORD FOUND for shared_googledrive'); process.exit(1); }
  console.log(JSON.stringify({ storedProject: rec.project, secretIds: rec.secretIds }, null, 2));

  // The save/read-back path always impersonates the customer's own admin
  // (getSaToken(session.gEmail)), not the bare SA identity — the bare SA may lack
  // Secret Manager IAM on the customer's own project even when the secret exists.
  const saToken = await getSaToken('zara@storefuze.com');
  for (const [field, secretId] of Object.entries(rec.secretIds as Record<string, string>)) {
    for (const project of ['72860638029', '231705905417']) {
      const r = await secretExists(saToken, project, secretId as string);
      console.log(`  ${field} in project ${project}: ${r.exists ? 'EXISTS' : `MISSING (${r.status})`}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
