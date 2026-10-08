/** Which Gemini Enterprise engines exist in a project, with ids. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = process.env.PROJ || 'studio-enterprise-migration';
const token = await getSaToken();
const r = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines?pageSize=100`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const t = await r.text();
if (!r.ok) { console.log(`HTTP ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 300)}`); process.exit(1); }
for (const e of ((JSON.parse(t) as { engines?: any[] }).engines ?? [])) {
  console.log(`${String(e.name).split('/').pop().padEnd(42)} ${e.displayName ?? ''}  ${String(e.solutionType ?? '')}`);
}
process.exit(0);
