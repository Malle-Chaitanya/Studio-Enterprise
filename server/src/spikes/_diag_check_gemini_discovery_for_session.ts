import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.log('usage: npx tsx src/spikes/_diag_check_gemini_discovery_for_session.ts <sessionId>');
  process.exit(1);
}

await connectMongo();
const session = await getSession(SESSION_ID);
if (!session) {
  console.log('No session found with that id.');
  process.exit(1);
}
console.log('gEmail:', session.gEmail);
console.log('geminiProject (stored):', session.geminiProject || '(empty)');
console.log('saOk (stored):', session.saOk);
console.log('saReason (stored):', session.saReason || '(none)');
console.log('has gToken:', !!session.gToken);

if (!session.gToken) {
  console.log('\nNo gToken stored on this session -- cannot replay discovery.');
  process.exit(0);
}

console.log('\n--- Replaying the exact Cloud Resource Manager call discoverGeminiProject makes ---');
const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
  headers: { Authorization: `Bearer ${session.gToken}` },
});
console.log('HTTP status:', res.status, res.statusText);
if (!res.ok) {
  const text = await res.text();
  console.log('Response body (error detail from Google):', text);
  process.exit(0);
}
const json = (await res.json()) as { projects?: Array<{ projectId?: string; projectNumber?: string; lifecycleState?: string }> };
const projects = json.projects ?? [];
console.log('Total projects visible to this token:', projects.length);
const active = projects.filter((p) => p.lifecycleState === 'ACTIVE');
console.log('ACTIVE projects:', active.length);
for (const p of active) console.log(' -', p.projectId || p.projectNumber, '(', p.lifecycleState, ')');

process.exit(0);
