/**
 * Is the token the migrated HubSpot tool reads the one the customer just saved?
 *
 * METADATA ONLY — lists version numbers, state and createTime. Never :access, so no
 * secret value is ever read, printed or logged.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

await connectMongo();
const db = getDb();
const creds = await db
  .collection<{ appUserId: string; connectorId: string; project: string; secretIds?: Record<string, string>; validation?: { code?: string }; updatedAt?: Date }>('connectorCredentials')
  .find({ connectorId: /hubspot/i })
  .toArray();

const saToken = await getSaToken();

for (const c of creds) {
  console.log(`\n${c.connectorId}  (appUserId=${c.appUserId}, project=${c.project})`);
  console.log(`  validation=${c.validation?.code ?? '(none)'}  savedAt=${c.updatedAt?.toISOString() ?? '?'}`);
  for (const [field, secretId] of Object.entries(c.secretIds ?? {})) {
    const url = `https://secretmanager.googleapis.com/v1/projects/${c.project}/secrets/${secretId}/versions`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    if (!res.ok) {
      console.log(`  ${field} -> ${secretId}: HTTP ${res.status}`);
      continue;
    }
    const body = (await res.json()) as { versions?: { name: string; state: string; createTime: string }[] };
    const vs = (body.versions ?? []).map((v) => `v${v.name.split('/').pop()} ${v.state} ${v.createTime}`);
    console.log(`  ${field} -> ${secretId}: ${vs.join(' | ') || '(no versions)'}`);
  }
}
process.exit(0);
