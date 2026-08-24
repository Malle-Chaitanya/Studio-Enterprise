import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { withSaTokens } from '../auth/google.js';
import { resolveDestination, listLicensedPrincipals } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').findOne({ _id: '5G6iqeurIWn-GC78-z6XzXKbUiQ' as never }) as Session | null;
  console.log('session:', { gEmail: s?.gEmail, geminiProject: s?.geminiProject, tenantId: s?.tenantId });
  if (!s?.geminiProject) { console.log('no geminiProject on session'); process.exit(0); }

  console.log('\n--- replaying exactly what google-users does ---');
  try {
    const licensed = await withSaTokens(s.gEmail, async (saToken) => {
      const dest = await resolveDestination(s.geminiProject!, saToken);
      console.log('resolved dest:', dest);
      return listLicensedPrincipals(dest, saToken);
    });
    console.log('licensed result:', licensed ? [...licensed] : licensed);
  } catch (e) {
    console.log('THREW:', (e as Error).message);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
