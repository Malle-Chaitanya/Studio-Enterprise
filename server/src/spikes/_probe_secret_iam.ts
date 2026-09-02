/** Does our SA merely FAIL to read the project IAM policy, or is the grant truly absent? */
import { getSaToken } from '../auth/google.js';

const PROJECT = process.argv[2] ?? 'studio-enterprise-migration';

const t = await getSaToken();
const res = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`,
  { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{}' },
);
console.log('getIamPolicy status:', res.status);
const body = await res.text();
if (!res.ok) {
  console.log('CANNOT READ POLICY ->', body.slice(0, 300));
  console.log('\n=> preflight would report "engine cannot read secret" REGARDLESS of the truth.');
} else {
  const p = JSON.parse(body) as { bindings?: Array<{ role: string; members?: string[] }> };
  const b = (p.bindings ?? []).filter((x) => x.role === 'roles/secretmanager.secretAccessor');
  console.log('secretAccessor bindings:', JSON.stringify(b, null, 1));
}
