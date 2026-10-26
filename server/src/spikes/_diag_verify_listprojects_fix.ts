import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';
import { listProjects } from '../services/destination.js';

const SESSION_ID = process.argv[2];
await connectMongo();
const session = await getSession(SESSION_ID);
if (!session?.gToken) {
  console.log('No session/gToken found.');
  process.exit(1);
}

console.log('Calling the REAL listProjects() with the fix applied...');
const projects = await listProjects(session.gToken);
console.log(`Total projects returned: ${projects.length}`);
for (const p of projects) {
  console.log(` - ${p.projectId} | hasGeminiApp: ${p.hasGeminiApp}`);
}
process.exit(0);
