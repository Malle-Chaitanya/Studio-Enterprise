import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { listProjects, type ProjectRef } from '../services/destination.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, listLicensedPrincipals } from '../services/gemini.js';
import { refreshGoogleToken } from '../auth/google.js';
import { mapPoolCollect } from '../concurrency.js';

async function main() {
  const t0 = Date.now();
  await connectMongo();
  const s = await getDb().collection('migrationSessions').findOne({ _id: '5G6iqeurIWn-GC78-z6XzXKbUiQ' as never }) as Session | null;
  console.log('session gRefreshToken present?', !!s?.gRefreshToken, 'gToken present?', !!s?.gToken);

  const userToken = s?.gRefreshToken ? (await refreshGoogleToken(s.gRefreshToken)) ?? s?.gToken : s?.gToken;
  console.log('userToken resolved?', !!userToken, `(+${Date.now() - t0}ms)`);

  const projects = await listProjects(userToken);
  console.log(`listProjects -> ${projects.length} projects (+${Date.now() - t0}ms)`);
  console.log(projects.map((p) => ({ id: p.projectId, hasGeminiApp: p.hasGeminiApp })));

  console.log('\n--- enriching with license counts (the new step) ---');
  const withLicenses: ProjectRef[] = await mapPoolCollect(projects, 8, async (p) => {
    if (!p.hasGeminiApp) return p;
    const t1 = Date.now();
    try {
      const saToken = await getSaToken(s?.gEmail);
      const dest = await resolveDestination(p.projectNumber || p.projectId, saToken);
      const licensed = await listLicensedPrincipals(dest, saToken);
      console.log(`  ${p.projectId}: licensed=${licensed ? licensed.size : 'null'} (+${Date.now() - t1}ms)`);
      return licensed ? { ...p, licensedUserCount: licensed.size } : p;
    } catch (err) {
      console.log(`  ${p.projectId}: THREW ${(err as Error).message} (+${Date.now() - t1}ms)`);
      return p;
    }
  });
  console.log(`\nTOTAL: ${Date.now() - t0}ms`);
  console.log(withLicenses.map((p) => ({ id: p.projectId, hasGeminiApp: p.hasGeminiApp, licensedUserCount: p.licensedUserCount })));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
