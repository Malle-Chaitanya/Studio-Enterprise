/**
 * Fix cross-project RE invocation:
 * 1. Grant valid customer service agents aiplatform.user on our project
 * 2. Test RE with correct ADK input format
 * 3. Check what error details come back
 *
 * Usage: cd server && npx tsx src/spikes/_fix_re_access.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT   = 'studio-enterprise-migration';
const SA_PROJ_NUM  = '231705905417';
const GCP_PROJ_NUM = '521161651560';
const RE_ID        = '3647336805298077696';
const RE_PATH      = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;
const GEMINI_ADMIN = 'mia@cloudfuze.com';

const saTokenOwn = await getSaToken();

// ── Fix 1: Grant valid service agents ─────────────────────────────────────────
console.log('=== Fix 1: Grant customer service agents → aiplatform.user ===');
// Only valid candidates (gcp-sa-aiplatform-re for customer project doesn't exist
// because the customer project has never used Vertex AI RE)
const candidates = [
  `service-${GCP_PROJ_NUM}@gcp-sa-discoveryengine.iam.gserviceaccount.com`,
  `service-${GCP_PROJ_NUM}@gcp-sa-aiplatform.iam.gserviceaccount.com`,
];

const getIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: '{}',
});
if (!getIam.ok) { console.error('getIamPolicy failed:', await getIam.text()); process.exit(1); }

const policy = await getIam.json() as { bindings?: { role: string; members: string[] }[] };
policy.bindings = policy.bindings ?? [];

for (const agent of candidates) {
  const role = 'roles/aiplatform.user';
  const member = `serviceAccount:${agent}`;
  const binding = policy.bindings.find(b => b.role === role);
  if (binding?.members.includes(member)) {
    console.log(`  Already: ${agent}`);
  } else {
    if (binding) binding.members.push(member);
    else policy.bindings.push({ role, members: [member] });
    console.log(`  Adding:  ${agent}`);
  }
}

const setIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ policy }),
});
console.log(`  setIamPolicy: ${setIam.status} ${setIam.ok ? '✓' : await setIam.text()}\n`);

// ── Fix 2: Test RE with multiple input formats ────────────────────────────────
console.log('=== Fix 2: Test RE invocation formats ===');
const formats = [
  { label: 'ADK query', body: { input: { query: 'what is the leave policy?' } } },
  { label: 'message key', body: { input: { message: 'hello' } } },
  { label: 'plain string', body: { input: 'hello' } },
  { label: 'user_message', body: { input: { user_message: 'hello' } } },
];

for (const { label, body } of formats) {
  const res = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  console.log(`[${label}] ${res.status}: ${text.slice(0, 200)}\n`);
}

// ── Fix 3: Try v1 endpoint ────────────────────────────────────────────────────
console.log('=== Fix 3: Try v1 endpoint ===');
const v1Res = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1/${RE_PATH}:streamQuery`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { query: 'hello' } }),
  },
);
console.log(`v1 status: ${v1Res.status}: ${(await v1Res.text()).slice(0, 200)}\n`);

// ── Check RE details ──────────────────────────────────────────────────────────
console.log('=== RE Details ===');
const reGet = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`,
  { headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
const reJson = await reGet.json() as Record<string, unknown>;
console.log(`State: ${JSON.stringify(reJson['state'] ?? reJson['lifecycleState'] ?? 'unknown')}`);
console.log(`Display: ${reJson['displayName']}`);
console.log(`Created: ${reJson['createTime']}`);
