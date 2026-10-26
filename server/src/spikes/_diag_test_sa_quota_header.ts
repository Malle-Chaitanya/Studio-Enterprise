import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';
import * as google from '../auth/google.js';

const SESSION_ID = process.argv[2];
await connectMongo();
const session = await getSession(SESSION_ID);
if (!session) {
  console.log('No session found.');
  process.exit(1);
}

const projectNumber = '633741737684'; // agents-migration
const saToken = await google.getSaToken(session.gEmail); // DWD impersonation, same as resolveDestination uses

console.log('--- A) Same call as discoverEngines makes today (SA token, no quota-project header) ---');
const resA = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${projectNumber}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
console.log('status:', resA.status, resA.ok ? JSON.stringify(await resA.json()).slice(0, 200) : (await resA.text()).slice(0, 250));

console.log('\n--- B) Same call, WITH X-Goog-User-Project set to the TARGET project ---');
const resB = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${projectNumber}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': projectNumber } },
);
console.log('status:', resB.status, resB.ok ? JSON.stringify(await resB.json()).slice(0, 300) : (await resB.text()).slice(0, 250));

process.exit(0);
