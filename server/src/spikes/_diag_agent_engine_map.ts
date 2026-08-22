/**
 * Which Reasoning Engine is behind each agent in the gallery?
 *
 * Needed because every deploy creates a NEW agent rather than replacing the previous one, so
 * a gallery ends up with several identically-named agents and only one of them holds the
 * current code. Deployed tool behaviour is frozen in the engine at deploy time, so an old
 * agent keeps failing exactly as it did when it was built — which reads to a user as "the
 * feature is broken" when the fix shipped an hour ago.
 *
 *   cd server && npx tsx src/spikes/_diag_agent_engine_map.ts [nameFilter]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';

const FILTER = (process.argv[2] || '').toLowerCase();
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await getSaToken();
const dest = await resolveDestination(s as Session, token);
const base = assistantBase(dest);

const res = await fetch(`${base}/agents?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
const j = (await res.json()) as { agents?: Array<Record<string, unknown>> };

const rows: Array<{ id: string; name: string; engine: string; created: string }> = [];
for (const a of j.agents ?? []) {
  const display = String(a.displayName ?? '');
  if (FILTER && !display.toLowerCase().includes(FILTER)) continue;
  const managed = (a.adkAgentDefinition ?? {}) as { provisionedReasoningEngine?: { reasoningEngine?: string } };
  const engine = managed.provisionedReasoningEngine?.reasoningEngine ?? '(none — not an ADK agent)';
  rows.push({
    id: String(a.name).split('/').pop() ?? '',
    name: display,
    engine: engine.split('/').pop() ?? engine,
    created: String(a.createTime ?? ''),
  });
}
rows.sort((x, y) => x.name.localeCompare(y.name) || y.created.localeCompare(x.created));
for (const r of rows) {
  console.log(`${r.name}\n   agent  ${r.id}\n   engine ${r.engine}\n   created ${r.created}`);
}
console.log(`\n${rows.length} agent(s). NEWEST created time per name is the current one.`);
process.exit(0);
