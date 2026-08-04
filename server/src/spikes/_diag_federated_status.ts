/**
 * Live test: call the FederatedKnowledgeStatus Dataverse custom function that
 * Copilot Studio's own UI calls to render the Knowledge Details screen — found
 * via a real browser network trace, not guessed. Custom API functions have
 * their own permission model separate from table-level Read privileges (which
 * we confirmed unstructuredfilesearchentity/record are excluded from) — so
 * this might not be blocked the same way. Testing directly rather than
 * theorizing.
 *
 *   npx tsx src/spikes/_diag_federated_status.ts <searchConfigurationId> [sessionId]
 *
 * Read-only against Dataverse.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SEARCH_CONFIG_ID = process.argv[2];
const SESSION_ID = process.argv[3];
if (!SEARCH_CONFIG_ID) throw new Error('usage: _diag_federated_status.ts <searchConfigurationId> [sessionId]');

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  for (const env of s.environments ?? []) {
    if (env.name !== 'CloudFuze Migration Test') continue;
    const token = await clientCredsToken(s.tenantId ?? '', env.url);

    const url = `${env.url}/api/data/v9.2/FederatedKnowledgeStatus(searchConfigurationId='${SEARCH_CONFIG_ID}')`;
    console.log('Calling:', url);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    console.log('status:', res.status);
    console.log(await res.text());
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
