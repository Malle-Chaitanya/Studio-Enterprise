/**
 * Follow-up to _diag_child_agent_tool_ownership.ts: the topic and tool components
 * showed no ownership field in their own raw data. Check whether the link lives in a
 * separate Dataverse relationship entity instead (the two candidates flagged in this
 * session's earlier research: botcomponent_botcomponent self-M:M, or
 * botcomponent_connectionreference).
 *
 * Run: cd server && npx tsx src/spikes/_diag_check_child_agent_relationship_tables.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const TOPIC_ID = '99f81ee6-016a-441b-bd17-c9629cc69210'; // Meeting Scheduler Agent topic

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session');

  for (const env of s.environments ?? []) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let bots: Awaited<ReturnType<typeof listBots>>;
    try {
      bots = await listBots(env.url, token);
    } catch {
      continue;
    }
    const bot = bots.find((b) => b.name === 'WorkMate');
    if (!bot) continue;

    for (const relEntity of ['botcomponent_botcomponent', 'botcomponentcollections', 'botcomponent_connectionreference']) {
      try {
        const url = `${env.url}/api/data/v9.2/${relEntity}?$top=3`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
        console.log(`${relEntity}: HTTP ${res.status}`);
        if (res.ok) console.log(JSON.stringify(await res.json(), null, 2).slice(0, 1000));
        else console.log((await res.text()).slice(0, 300));
      } catch (e) {
        console.log(`${relEntity}: FAILED ${(e as Error).message}`);
      }
      console.log('---');
    }

    // Ask the topic component itself for its declared navigation properties via $metadata-free
    // OData: request with annotations, which surfaces any populated lookup/relationship field.
    try {
      const url = `${env.url}/api/data/v9.2/botcomponents(${TOPIC_ID})`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: 'odata.include-annotations="*"',
        },
      });
      console.log('topic component, ALL fields + annotations:', res.status);
      const body = await res.text();
      console.log(body.slice(0, 3000));
    } catch (e) {
      console.log('FAILED', (e as Error).message);
    }
    process.exit(0);
  }
  console.error('WorkMate not found.');
  process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
