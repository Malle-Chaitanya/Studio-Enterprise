/**
 * What is in the CURRENT session's plan, and which connectors does each planned agent use?
 *
 * Picking an end-to-end test agent by name is how you accidentally exercise the one connector
 * that already worked. The point is to migrate the agents that touch the code changed tonight
 * (HubSpot, Jira, Drive, Confluence), so the choice is made from measured connector sets.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import type { Session, ResolvedPlan } from '../types.js';

await connectMongo();
const db = getDb();
const session = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | (Session & { plan?: ResolvedPlan }) | null;
if (!session?.plan?.units?.length) { console.log('no session with a plan'); process.exit(1); }
console.log(`session appUserId=${session.appUserId} units=${session.plan.units.length} total=${session.plan.totalAgents}\n`);

for (const u of session.plan.units) {
  for (const b of u.bots ?? []) {
    const cached = await getCachedIR(session.appUserId!, u.envUrl, b.botid);
    const ids = cached ? [...agentConnectorIds(cached.ir)] : [];
    const ks = cached?.ir.knowledgeSources?.length ?? 0;
    const tools = cached?.ir.agentTools?.length ?? 0;
    console.log(
      `${(b.name ?? '?').slice(0, 42).padEnd(44)} ${cached ? '' : 'NO CACHED IR  '}` +
        `tools=${String(tools).padStart(2)} ks=${String(ks).padStart(2)}  ${ids.join(', ')}`,
    );
  }
}
process.exit(0);
