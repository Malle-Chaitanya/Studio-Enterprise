/**
 * Grant the Agentspace (Discovery Engine) service account from the CUSTOMER'S
 * Gemini project permission to invoke the Reasoning Engine in studio-enterprise-migration.
 *
 * Root cause of "Something went wrong (0ms)": Agentspace (Discovery Engine) in
 * sonorous-lightning-t224x (project# 521161651560) uses its service account
 *   service-521161651560@gcp-sa-discoveryengine.iam.gserviceaccount.com
 * to call the RE in studio-enterprise-migration. Without IAM, that call is
 * rejected at the network/auth layer BEFORE the RE runtime even starts —
 * hence 0ms failure and no RE logs.
 *
 * Fix: grant that SA roles/aiplatform.user on studio-enterprise-migration.
 *
 * Run: cd server && npx tsx src/spikes/_fix_agentspace_re_iam.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT = 'studio-enterprise-migration';
const SA_PROJECT_NUM = '231705905417';
const CUSTOMER_PROJECT_NUM = '521161651560'; // sonorous-lightning-t224x

// The Agentspace (Discovery Engine) SA that calls the RE cross-project
const AGENTSPACE_SA = `service-${CUSTOMER_PROJECT_NUM}@gcp-sa-discoveryengine.iam.gserviceaccount.com`;
const ROLE = 'roles/aiplatform.user';

const token = await getSaToken(); // studio-enterprise-migration SA — has rights to set IAM there

console.log(`Granting ${AGENTSPACE_SA}`);
console.log(`Role: ${ROLE} on project: ${SA_PROJECT}`);

// ── Step 1: Get current IAM policy ───────────────────────────────────────────
console.log('\n[1] Fetching current IAM policy...');
const getR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  }
);
if (!getR.ok) {
  console.error(`  GET policy failed: ${getR.status} ${await getR.text()}`);
  process.exit(1);
}
const policy = await getR.json() as {
  version: number;
  bindings: Array<{ role: string; members: string[] }>;
  etag: string;
};
console.log(`  Current bindings: ${policy.bindings.length}, etag: ${policy.etag}`);

// Check if already granted
const existing = policy.bindings.find(b => b.role === ROLE);
const member = `serviceAccount:${AGENTSPACE_SA}`;
if (existing?.members.includes(member)) {
  console.log(`  ✅ Already granted! ${member} → ${ROLE}`);
} else {
  console.log(`  Not yet granted. Adding...`);

  // ── Step 2: Add the binding ───────────────────────────────────────────────
  if (existing) {
    existing.members.push(member);
  } else {
    policy.bindings.push({ role: ROLE, members: [member] });
  }

  const setR = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy }),
    }
  );
  const setT = await setR.text();
  console.log(`\n[2] setIamPolicy: ${setR.status}`);
  if (!setR.ok) {
    console.error(`  Failed: ${setT.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`  ✅ Granted ${member} → ${ROLE} on ${SA_PROJECT}`);
}

// ── Step 3: Also try granting on just the RE itself (resource-level) ──────────
// Some RE implementations support resource-level IAM which is more granular.
// v1beta1 RE resource IAM:
const V8_RE_ID = '8175706230619111424';
const LOCATION = 'us-central1';
const reResourceUrl = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${SA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${V8_RE_ID}:getIamPolicy`;

console.log('\n[3] Checking RE resource-level IAM...');
const reIamR = await fetch(reResourceUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: '{}',
});
console.log(`  RE IAM GET status: ${reIamR.status}`);
if (reIamR.ok) {
  const rePolicy = await reIamR.json() as { bindings?: Array<{ role: string; members: string[] }> };
  console.log(`  RE resource bindings: ${JSON.stringify(rePolicy.bindings ?? [])}`);
} else {
  const t = await reIamR.text();
  console.log(`  RE IAM not supported or error: ${t.slice(0, 200)}`);
  console.log('  (Resource-level IAM may not be available for REs — project-level is the fallback)');
}

// ── Step 4: Instructions to test ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('IAM grant complete. Now test:');
console.log('  1. Go to business.gemini.google');
console.log('  2. Find "Confluence Knowledge Agent v8-reg"');
console.log('  3. Ask: "What is the sick leave policy?"');
console.log('  4. If it works → cross-project RE is fixed!');
console.log('  5. Run: npx tsx src/spikes/_check_re_logs.ts to confirm class_method in RE logs');
console.log('══════════════════════════════════════════════════════════');
