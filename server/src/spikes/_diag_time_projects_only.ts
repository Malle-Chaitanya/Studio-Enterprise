import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { listProjects } from '../services/destination.js';
import { refreshGoogleToken } from '../auth/google.js';

async function main() {
  const t0 = Date.now();
  await connectMongo();
  const s = await getDb().collection('migrationSessions').findOne({ _id: '5G6iqeurIWn-GC78-z6XzXKbUiQ' as never }) as Session | null;
  const userToken = s?.gRefreshToken ? (await refreshGoogleToken(s.gRefreshToken)) ?? s?.gToken : s?.gToken;
  const projects = await listProjects(userToken);
  console.log(`listProjects alone -> ${projects.length} projects in ${Date.now() - t0}ms (this is now the FULL /projects response time)`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
