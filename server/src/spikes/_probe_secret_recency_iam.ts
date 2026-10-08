/** Which secrets this run created in the destination, and whether the agent's runtime
 *  identity can read them. A container that cannot READ the key fails exactly like a bad
 *  key — the agent says "authentication error" either way, so separate the two here. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = process.env.PROJECT || 'agentmigrations';
const token = await getSaToken();

const pr = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const projNum = pr.ok ? (JSON.parse(await pr.text()) as { projectNumber?: string }).projectNumber : '?';
console.log(`${PROJECT} projectNumber=${projNum}`);

const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?pageSize=200`, {
  headers: { Authorization: `Bearer ${token}` },
});
const secrets = ((JSON.parse(await r.text()) as { secrets?: { name: string; createTime?: string }[] }).secrets ?? [])
  .map((s) => ({ id: s.name.split('/').pop()!, createTime: s.createTime ?? '' }))
  .sort((a, b) => b.createTime.localeCompare(a.createTime));
console.log(`\n8 most recently CREATED secrets:`);
secrets.slice(0, 8).forEach((s) => console.log(`  ${s.createTime.slice(0, 19)}  ${s.id}`));

const google = secrets.filter((s) => /google-service-account-service-account-json/.test(s.id));
console.log(`\ngoogle_service_account group secrets (what Gmail reads):`);
for (const s of google) {
  const ir = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${s.id}:getIamPolicy`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const it = await ir.text();
  const bindings = ir.ok ? ((JSON.parse(it) as { bindings?: { role: string; members: string[] }[] }).bindings ?? []) : [];
  console.log(`\n  ${s.id}  (created ${s.createTime.slice(0, 19)})`);
  if (!ir.ok) { console.log(`    getIamPolicy HTTP ${ir.status} ${it.replace(/\s+/g, ' ').slice(0, 140)}`); continue; }
  if (!bindings.length) console.log('    no direct bindings — only project-level roles apply');
  for (const b of bindings) console.log(`    ${b.role}: ${b.members.join(', ')}`);
}
process.exit(0);
