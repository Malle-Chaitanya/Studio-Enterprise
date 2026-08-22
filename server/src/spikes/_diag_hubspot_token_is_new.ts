/** Is the supplied token different from the one already stored for HubSpot?
 *  Compares SHA-256 digests only — neither value is printed or logged. */
import { createHash } from 'node:crypto';
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const supplied = process.env.HUBSPOT_TOKEN;
if (!supplied) throw new Error('set HUBSPOT_TOKEN');
const sha = (v: string) => createHash('sha256').update(v.trim()).digest('hex').slice(0, 12);

await connectMongo();
const rows = (await getDb().collection('connectorCredentials').find({ connectorId: /hubspot/i }).toArray()) as Array<Record<string, any>>;
const saToken = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
console.log(`supplied token digest: ${sha(supplied)}\n`);
for (const row of rows) {
  for (const [field, secretId] of Object.entries((row.secretIds ?? {}) as Record<string, string>)) {
    const project = String(row.project ?? '231705905417');
    const got = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`, { optional: true });
    const digest = got.ok && got.plaintext ? sha(got.plaintext) : '(unreadable)';
    const same = got.ok && got.plaintext ? sha(got.plaintext) === sha(supplied) : false;
    console.log(`${String(row.connectorId).padEnd(30)} ${field.padEnd(18)} stored=${digest} ${same ? '<-- SAME as supplied' : ''}`);
  }
}
process.exit(0);
