/**
 * Refreshes agentIRCache for WorkMate WITHOUT running a real migration/deploy — the same
 * extraction + mapping work Phase 1 does, just not inside a full run. Needed because
 * POST /api/migrate/plan only builds a scope preview and never calls extraction; the
 * Connectors page reads agentIRCache, which is ONLY populated by an actual migration run
 * (Phase 1 inside /api/migrate/stream) — so a stale cache from before Meeting Scheduler
 * Agent existed can't be refreshed by navigating the wizard alone.
 *
 * Read + one Mongo write to agentIRCache. Does not touch Gemini, does not deploy anything.
 *
 * Run: cd server && npx tsx src/spikes/_diag_refresh_workmate_cache.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { DEFAULT_APP_USER_ID } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { mapAgent } from '../services/mapper.js';
import { cacheAgentIR } from '../db/repos/agentIR.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId || !s.environments?.length) throw new Error('no session with tenantId + environments found');
  const appUserId = s.appUserId ?? DEFAULT_APP_USER_ID;

  for (const env of s.environments) {
    let bots;
    try {
      const token = await clientCredsToken(s.tenantId, env.url);
      bots = await listBots(env.url, token);
    } catch {
      continue;
    }
    const match = bots.find((b) => b.name === 'WorkMate');
    if (!match) continue;

    console.log(`found WorkMate in env "${env.name}" — extracting fresh...`);
    const token = await clientCredsToken(s.tenantId, env.url);
    const ir = await extractAgent(env.url, token, match);
    console.log(`extracted: ${ir.topics.length} topics, ${ir.agentTools?.length ?? 0} agentTools`);
    console.log(`  Meeting Scheduler Agent present: ${ir.topics.some((t) => t.name === 'Meeting Scheduler Agent')}`);
    console.log(`  calendar tool present: ${ir.agentTools?.some((t) => t.operationId === 'V4CalendarPostItem')}`);

    const mapped = await mapAgent(ir);
    await cacheAgentIR(appUserId, env.url, ir, mapped);
    console.log(`\ncached under appUserId="${appUserId}" envUrl="${env.url}" sourceId="${ir.sourceId}"`);
    console.log('Refresh the Connectors page now — the calendar choice should appear.');
    process.exit(0);
  }
  console.error('WorkMate not found.');
  process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
