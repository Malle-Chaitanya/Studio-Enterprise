/**
 * Does per-customer capture actually work end to end — live fetch, cache, fallback?
 * Read-only against Power Apps; writes only the index cache in our own Mongo.
 * npx tsx src/spikes/_test_capture_op_index.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { captureOpIndex, resolveOpIndex } from '../connectors/captureOpIndex.js';

await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string; environments?: Array<{ name: string; id: string; accessible?: boolean }> } | null;
const env = (row?.environments ?? []).find((e) => e.accessible);
const ctx = { tenantId: row!.tenantId!, environmentId: env!.id, scope: `ms-${row!.tenantId}` };
console.log(`env ${env!.name} (${env!.id})  scope ${ctx.scope}\n`);

// A connector we hold a fixture for, one we do NOT, and one that is not installed here.
for (const cid of ['shared_confluence', 'shared_bitbucket', 'shared_notaconnector']) {
  const t0 = Date.now();
  const live = await captureOpIndex(cid, ctx);
  console.log(`${cid.padEnd(24)} live capture: ${live ? `${live.operationCount} ops (${live.displayName})` : 'not available'}  ${Date.now() - t0}ms`);
  const t1 = Date.now();
  const resolved = await resolveOpIndex(cid, ctx);
  console.log(`${''.padEnd(24)} resolve:      ${resolved ? `${resolved.operationCount} ops` : 'undefined'}  ${Date.now() - t1}ms (cached hit should be fast)`);
}
const cached = await getDb().collection('connectorOpIndexes').find({ scope: ctx.scope }).toArray();
console.log(`\ncached rows for this customer: ${cached.map((c) => `${c.connectorId}=${c.index?.operationCount}`).join(', ')}`);
// Fallback path: no context at all must still answer from the committed fixture.
const offline = await resolveOpIndex('shared_confluence', undefined);
console.log(`offline fallback (no ctx):    ${offline ? `${offline.operationCount} ops from fixture` : 'undefined'}`);
process.exit(0);
