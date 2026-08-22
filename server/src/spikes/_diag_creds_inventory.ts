/**
 * Which connectors can be PROVEN tonight, and which are blocked on a credential?
 *
 * The distinction decides the whole plan: a connector with a stored credential can have its
 * tools called against the real vendor and marked `verified`; one without can only ever be
 * reasoned about, and a `verified: true` on it would be a lie. Measured, not assumed.
 *
 *   cd server && npx tsx src/spikes/_diag_creds_inventory.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

await connectMongo();
const db = getDb();
const recs = (await db.collection('connectorCredentials').find({}).toArray()) as Array<{
  connectorId?: string; project?: string; secretIds?: Record<string, string>; validation?: unknown;
}>;
const saToken = await getSaToken();

console.log(`${recs.length} credential record(s)\n`);
for (const r of recs.sort((a, b) => (a.connectorId ?? '').localeCompare(b.connectorId ?? ''))) {
  const def = REGISTRY_BY_ID.get(r.connectorId ?? '');
  const fields = Object.keys(r.secretIds ?? {});
  const readable: string[] = [];
  const failed: string[] = [];
  for (const [field, secretId] of Object.entries(r.secretIds ?? {})) {
    // Read, but never print the plaintext — the point is whether it RESOLVES, not what it is.
    const got = await getEntraSecret(saToken, `projects/${r.project ?? 'studio-enterprise-migration'}/secrets/${secretId}/versions/latest`);
    (got.ok && got.plaintext ? readable : failed).push(field);
  }
  const status = failed.length ? `UNREADABLE: ${failed.join(', ')}` : 'all fields readable';
  console.log(`${(r.connectorId ?? '?').padEnd(28)} ${(def?.name ?? '').padEnd(34)} ${String(fields.length).padStart(2)} field(s)  ${status}`);
}

console.log('\nTier-1 connectors WITHOUT any credential record:');
const have = new Set(recs.map((r) => r.connectorId));
for (const id of [
  'shared_teams', 'shared_googlechat', 'shared_outlook', 'shared_office365',
  'shared_googledrive', 'shared_confluence', 'shared_jira',
  'shared_sharepointonline', 'shared_onedrive',
  'shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcrm',
]) {
  if (!have.has(id)) console.log(`  ${id.padEnd(28)} ${REGISTRY_BY_ID.get(id)?.name ?? ''}`);
}
process.exit(0);
