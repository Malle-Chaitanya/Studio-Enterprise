import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';
import { listProjects } from '../services/destination.js';
import { getSaToken } from '../auth/google.js';

const SESSION_ID = process.argv[2];
await connectMongo();
const session = await getSession(SESSION_ID);
if (!session?.gToken) {
  console.log('No session/gToken found.');
  process.exit(1);
}

let saToken: string | undefined;
try {
  saToken = await getSaToken(session.gEmail);
  console.log('SA token minted OK (impersonating', session.gEmail + ')');
} catch (err) {
  console.log('SA token mint FAILED:', (err as Error).message);
}

console.log('\nCalling the REAL listProjects(userToken, saToken) with the fix applied...');
const projects = await listProjects(session.gToken, saToken);
console.log(`Total projects returned: ${projects.length}`);
for (const p of projects) {
  console.log(` - ${p.projectId} | hasGeminiApp: ${p.hasGeminiApp}`);
}
process.exit(0);
