/**
 * Diagnose: can our SA invoke the RE directly?
 * And grant Agentspace/DE service agent of sonorous-lightning-t224x
 * the ability to invoke our RE in studio-enterprise-migration.
 *
 * The "0ms" error in UI = Gemini Business can't call the RE cross-project.
 * Fix: grant roles/aiplatform.user on studio-enterprise-migration to the
 * customer project's DE service agent.
 *
 * Usage: cd server && npx tsx src/spikes/_diag_re_invoke.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const GCP_PROJ_NUM = '521161651560';  // sonorous-lightning-t224x project number
const RE_ID       = '3647336805298077696';
const RE_PATH     = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;
const GEMINI_ADMIN = 'mia@cloudfuze.com';

const saTokenOwn = await getSaToken();
const saTokenDwd = await getSaToken(GEMINI_ADMIN);

// ── Test 1: Direct RE invocation via SA token ─────────────────────────────────
console.log('=== Test 1: Direct RE query (SA token) ===');
const queryRes = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { message: 'hello' } }),
  },
);
console.log(`Status: ${queryRes.status}`);
const queryText = await queryRes.text();
console.log(`Response (first 300): ${queryText.slice(0, 300)}\n`);

// ── Test 2: Direct RE invocation via DWD (as mia) ────────────────────────────
console.log('=== Test 2: Direct RE query (DWD as mia) ===');
const queryRes2 = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenDwd}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { message: 'hello' } }),
  },
);
console.log(`Status: ${queryRes2.status}`);
const queryText2 = await queryRes2.text();
console.log(`Response (first 300): ${queryText2.slice(0, 300)}\n`);

// ── Grant: DE service agent of customer project → aiplatform.user on our project
console.log('=== Granting Agentspace service agents → aiplatform.user on our project ===');

// Possible service agents for sonorous-lightning-t224x that Agentspace uses
const candidates = [
  `service-${GCP_PROJ_NUM}@gcp-sa-discoveryengine.iam.gserviceaccount.com`,
  `service-${GCP_PROJ_NUM}@gcp-sa-aiplatform.iam.gserviceaccount.com`,
  `service-${GCP_PROJ_NUM}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`,
];
const role = 'roles/aiplatform.user';

const getIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: '{}',
});
if (!getIam.ok) {
  console.log(`getIamPolicy failed: ${getIam.status} ${(await getIam.text()).slice(0, 100)}`);
  process.exit(1);
}

const policy = await getIam.json() as { bindings?: { role: string; members: string[] }[] };
policy.bindings = policy.bindings ?? [];
let changed = false;
const binding = policy.bindings.find(b => b.role === role);

for (const agent of candidates) {
  const member = `serviceAccount:${agent}`;
  if (binding?.members.includes(member)) {
    console.log(`  Already granted: ${agent}`);
  } else {
    if (binding) binding.members.push(member);
    else policy.bindings.push({ role, members: [member] });
    console.log(`  Adding: ${agent}`);
    changed = true;
  }
}

if (changed) {
  const setIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  const setText = await setIam.text();
  console.log(`  setIamPolicy: ${setIam.status} ${setIam.ok ? '✓' : setText.slice(0, 200)}`);
} else {
  console.log('  All already granted.');
}

console.log('\nWait 60s for IAM propagation, then retry in business.gemini.google');
