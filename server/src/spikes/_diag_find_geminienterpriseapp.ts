import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { listEnginesResult, listProjects } from '../services/destination.js';
import { resolveDestination, listLicensedPrincipals } from '../services/gemini.js';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { refreshGoogleToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').findOne({ _id: '5G6iqeurIWn-GC78-z6XzXKbUiQ' as never }) as Session | null;
  const userToken = s?.gRefreshToken ? (await refreshGoogleToken(s.gRefreshToken)) ?? s?.gToken : s?.gToken;
  const projects = await listProjects(userToken);
  for (const p of projects.filter((x) => x.hasGeminiApp)) {
    const saToken = await getSaToken(s?.gEmail);
    const eng = await listEnginesResult(p.projectNumber || p.projectId, saToken);
    for (const e of eng.engines) {
      console.log(`project=${p.projectId} (${p.projectNumber}) engine=${e.id} displayName="${e.displayName}"`);
      if (/gemini\s*enterprise\s*app/i.test(e.displayName)) {
        const dest = await resolveDestination(p.projectNumber || p.projectId, saToken);
        const licensed = await listLicensedPrincipals(dest, saToken);
        console.log(`  >>> MATCH "GeminiEnterpriseApp" — project ${p.projectId} (${p.projectNumber}), licensed=${licensed ? licensed.size : 'null'}`);
      }
    }
  }
  console.log('\nsession.geminiProject (top badge, auto-discovered):', s?.geminiProject);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
