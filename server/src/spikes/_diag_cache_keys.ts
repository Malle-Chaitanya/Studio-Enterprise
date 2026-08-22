/** The EXACT envUrl/sourceId keys in agentIRCache, and what the session's plan selected.
 *  A trailing slash or a different environment id makes getCachedIR miss silently, which the
 *  surface screen renders as "no agent uses this" rather than "I could not look".
 *  cd server && npx tsx src/spikes/_diag_cache_keys.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | Record<string, unknown> | null;
const appUserId = String(s?.appUserId ?? '');

console.log('=== agentIRCache keys ===');
for (const r of await db.collection('agentIRCache').find({ appUserId }).limit(20).toArray()) {
  console.log(`  env=${JSON.stringify(r.envUrl)}  sourceId=${r.sourceId}  name=${(r.ir as { name?: string })?.name}`);
}

console.log('\n=== session.plan (what the wizard selected) ===');
const plan = s?.plan as { environments?: Array<{ url?: string; botIds?: string[] }> } | undefined;
if (!plan) console.log('  (no plan on session)');
else console.log(JSON.stringify(plan, null, 2).slice(0, 900));

console.log('\n=== session.environments ===');
const envs = s?.environments as Array<{ url?: string; name?: string }> | undefined;
for (const e of (envs ?? []).slice(0, 8)) console.log(`  ${JSON.stringify(e.url)}  ${e.name ?? ''}`);
process.exit(0);
