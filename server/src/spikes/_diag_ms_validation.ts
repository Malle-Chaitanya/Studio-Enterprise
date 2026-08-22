/**
 * Why does saving Microsoft credentials log "stored but did not validate"?
 *
 * The card now shows "Saved, but not working" on that result, so the exact code and detail
 * matter — it is what the customer reads. Runs the SAME validator the save route runs,
 * against the SAME stored values.
 *
 *   cd server && npx tsx src/spikes/_diag_ms_validation.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { validateConnectorCredentials } from '../services/connectorValidator.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { appUserId?: string; geminiProject?: string } | null;
const appUserId = s?.appUserId ?? '';
const project = s?.geminiProject ?? '';
const saToken = await getSaToken();

const rec = (await listConnectorCredentials(appUserId)).find((c) => c.connectorId === 'shared_teams');
if (!rec) { console.log('no shared_teams credential recorded'); process.exit(0); }

const values: Record<string, string> = {};
for (const [field, secretId] of Object.entries(rec.secretIds ?? {})) {
  const got = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`);
  // Never print the value — only whether it resolved and how long it is.
  console.log(`  ${field.padEnd(15)} ${got.ok && got.plaintext ? `resolved (${got.plaintext.length} chars)` : 'UNREADABLE'}`);
  if (got.ok && got.plaintext) values[field] = got.plaintext;
}

const v = await validateConnectorCredentials('shared_teams', values);
console.log(`\ncode   : ${v.code}`);
console.log(`detail : ${v.detail ?? '-'}`);
if (v.grantedPermissions) console.log(`consented: ${v.grantedPermissions.join(', ')}`);
process.exit(0);
