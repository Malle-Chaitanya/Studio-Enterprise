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

const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
  headers: { Authorization: `Bearer ${session.gToken}` },
});
const json = (await res.json()) as { projects?: Array<{ projectId?: string; projectNumber?: string; lifecycleState?: string }> };
const active = (json.projects ?? []).filter((p) => p.lifecycleState === 'ACTIVE');

for (const p of active) {
  const ref = p.projectId || p.projectNumber;
  const listRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${p.projectNumber}/locations/global/collections/default_collection/engines`,
    { headers: { Authorization: `Bearer ${session.gToken}` } },
  );
  const bodyText = listRes.ok ? '(ok)' : await listRes.text();
  console.log(ref, '| projectNumber:', p.projectNumber, '| status:', listRes.status, listRes.ok ? '' : '| ' + bodyText.slice(0, 200));
}
process.exit(0);
