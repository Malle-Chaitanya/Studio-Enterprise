import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';
import { discoverGeminiProject } from '../auth/google.js';

const SESSION_ID = process.argv[2];
await connectMongo();
const session = await getSession(SESSION_ID);
if (!session?.gToken) {
  console.log('No session/gToken found.');
  process.exit(1);
}

console.log('Calling the REAL discoverGeminiProject() with the fix applied...');
const project = await discoverGeminiProject(session.gToken);
console.log('Result:', project || '(empty -- still not found)');
process.exit(0);
