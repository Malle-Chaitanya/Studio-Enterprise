/** Test what the picker's project dropdown will show: list projects from the
 *  latest session's OAuth token (same call /api/destination/projects makes). */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { listProjects } from './services/destination.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) { console.log('no session'); process.exit(0); }
  console.log('gEmail:', s.gEmail, ' gToken present:', Boolean(s.gToken));
  const projects = await listProjects(s.gToken);
  console.log(`\nlistProjects → ${projects.length} project(s):`);
  for (const p of projects) console.log(`  - ${p.projectNumber}  ${p.projectId}  "${p.displayName}"`);
  if (!projects.length) console.log('  (empty → dropdown would be empty → need manual project-id entry)');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
