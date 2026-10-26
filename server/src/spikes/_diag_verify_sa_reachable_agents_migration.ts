import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';
import * as google from '../auth/google.js';
import { projectReachable, resolveDestination, engineReachable } from '../services/gemini.js';

const SESSION_ID = process.argv[2];
await connectMongo();
const session = await getSession(SESSION_ID);
if (!session) {
  console.log('No session found.');
  process.exit(1);
}

const project = 'agents-migration';
console.log('Testing project:', project, '| admin email:', session.gEmail);

console.log('\n--- 1) DIRECT IAM: can the service account itself reach this project? ---');
try {
  const direct = await google.getSaToken();
  const reachableDirect = await projectReachable(project, direct);
  console.log('projectReachable (direct IAM):', reachableDirect);
  if (reachableDirect) {
    const dest = await resolveDestination(project, direct);
    console.log('resolved destination:', dest);
    const engineOk = await engineReachable(dest, direct);
    console.log('engineReachable (direct IAM):', engineOk);
  }
} catch (err) {
  console.log('DIRECT IAM failed with error:', (err as Error).message);
}

console.log('\n--- 2) DWD: can the service account reach it by impersonating the admin? ---');
try {
  const saToken = await google.getSaToken(session.gEmail);
  const dest = await resolveDestination(project, saToken);
  console.log('resolved destination (DWD):', dest);
  const engineOk = await engineReachable(dest, saToken);
  console.log('engineReachable (DWD):', engineOk);
} catch (err) {
  console.log('DWD failed with error:', (err as Error).message);
}

process.exit(0);
