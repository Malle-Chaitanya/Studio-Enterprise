import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';

const SESSION_ID = process.argv[2];
await connectMongo();
const session = await getSession(SESSION_ID);
if (!session?.gToken) {
  console.log('No session/gToken found.');
  process.exit(1);
}

// Target: agentmigrations, a project we KNOW has a real Gemini Enterprise engine
// (used successfully all night via the service account).
const projectNumber = '505103737920';

console.log('--- A) Same call as discoverGeminiProject makes today (no quota-project header) ---');
const resA = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${projectNumber}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${session.gToken}` } },
);
console.log('status:', resA.status, resA.ok ? '(ok)' : (await resA.text()).slice(0, 200));

console.log('\n--- B) Same call, but WITH X-Goog-User-Project set to the TARGET project itself ---');
const resB = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${projectNumber}/locations/global/collections/default_collection/engines`,
  { headers: { Authorization: `Bearer ${session.gToken}`, 'X-Goog-User-Project': projectNumber } },
);
console.log('status:', resB.status, resB.ok ? '(ok) -- ' + JSON.stringify(await resB.json()).slice(0, 300) : (await resB.text()).slice(0, 300));

process.exit(0);
