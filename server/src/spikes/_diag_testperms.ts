/** Definitive check: does our SA token EFFECTIVELY have dialogflow.agents.create
 *  right now (after the grant)? testIamPermissions returns only the ones the
 *  caller actually holds. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT] = process.argv.slice(2);

async function main() {
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions: ['dialogflow.agents.create', 'dialogflow.agents.get', 'dialogflow.agents.list', 'discoveryengine.assistants.get', 'resourcemanager.projects.get'] }),
  });
  const j = (await r.json()) as { permissions?: string[]; error?: { message?: string } };
  console.log(`testIamPermissions -> ${r.status}`);
  if (j.error) { console.log('  error:', j.error.message); process.exit(0); }
  const has = new Set(j.permissions ?? []);
  for (const p of ['dialogflow.agents.create', 'dialogflow.agents.get', 'dialogflow.agents.list', 'discoveryengine.assistants.get', 'resourcemanager.projects.get']) {
    console.log(`  ${has.has(p) ? '✅ HAS' : '❌ MISSING'}  ${p}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
