/**
 * What session/plan/staged state survives right now?
 *
 * `migrationSessions` has a Mongo TTL, so a session-derived path reports "nothing configured"
 * some hours after the browser was last used, while `stagedAgents` and `connectorCredentials`
 * survive. That difference decides whether an end-to-end run can be driven from here at all,
 * or whether it needs someone to walk the UI to the Migrate step first.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
for (const c of ['migrationSessions', 'stagedAgents', 'migrationRuns', 'migrationResults', 'agentIRCache']) {
  const n = await db.collection(c).countDocuments();
  console.log(`${c.padEnd(20)} ${n}`);
}
const sessions = await db.collection('migrationSessions').find({}).toArray();
console.log(`\nsessions (${sessions.length}):`);
for (const s of sessions as Array<Record<string, unknown>>) {
  const plan = s.plan as { units?: unknown[]; totalAgents?: number } | undefined;
  console.log(
    `  appUserId=${String(s.appUserId)} tenant=${String(s.tenantId ?? '-').slice(0, 12)} ` +
      `plan=${plan ? `${plan.units?.length ?? 0} unit(s)/${plan.totalAgents ?? 0} agents` : 'NONE'} ` +
      // Presence only — never the token itself.
      `msToken=${s.msToken || s.msAccessToken ? 'present' : 'absent'} envs=${(s.environments as unknown[] | undefined)?.length ?? 0}`,
  );
}
const staged = await db.collection('stagedAgents').find({}).limit(5).toArray();
console.log(`\nstaged sample:`);
for (const r of staged as Array<Record<string, unknown>>) {
  console.log(`  ${String(r.displayName ?? r.name ?? '?').slice(0, 40).padEnd(42)} appUserId=${String(r.appUserId)} runId=${String(r.runId ?? '-')}`);
}
process.exit(0);
