/**
 * Check studioenterprisemigrations project — Mia's GCP project in cloudfuze.com org.
 * We want to deploy RE here (same org as Agentspace) to fix cross-org invocation issues.
 *
 * Run: cd server && npx tsx src/spikes/_check_mia_project.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const MIA_PROJECT = 'studioenterprisemigrations';
const GEMINI_ADMIN = 'mia@cloudfuze.com';

// Use DWD token for mia (she should have IAM access in her project)
const miaToken = await getSaToken(GEMINI_ADMIN);
// Also try SA token in case SA was granted access
const saToken = await getSaToken();

console.log('─── Testing mia DWD token access to studioenterprisemigrations ───');

// 1. Check IAM policy
console.log('\n[1] IAM policy...');
const iamR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${MIA_PROJECT}:getIamPolicy`,
  { method: 'POST', headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' }, body: '{}' }
);
const iamT = await iamR.text();
console.log(`  IAM status: ${iamR.status}`);
if (iamR.ok) {
  const iam = JSON.parse(iamT) as { bindings: Array<{ role: string; members: string[] }> };
  console.log(`  Bindings count: ${iam.bindings?.length}`);
  // Show SA-related bindings
  for (const b of iam.bindings ?? []) {
    const hasMia = b.members.some(m => m.includes('mia'));
    const hasSA = b.members.some(m => m.includes('studio-migration') || m.includes('studio-enterprise'));
    if (hasMia || hasSA) console.log(`  ${b.role}: ${b.members.filter(m => hasMia || hasSA).join(', ')}`);
  }
} else {
  console.log(`  Error: ${iamT.slice(0, 200)}`);
}

// 2. Check Vertex AI API status via mia token
console.log('\n[2] Vertex AI API status (mia token)...');
const vertexR = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${MIA_PROJECT}/services/aiplatform.googleapis.com`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
const vertexJ = await vertexR.json() as { state?: string; name?: string };
console.log(`  status: ${vertexR.status}, state: ${vertexJ.state}`);

// 3. Check using SA token
console.log('\n[3] SA token access...');
const saR = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${MIA_PROJECT}/services/aiplatform.googleapis.com`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
console.log(`  SA token status: ${saR.status}`);
if (saR.ok) {
  const saJ = await saR.json() as { state?: string };
  console.log(`  Vertex AI state: ${saJ.state}`);
}

// 4. Try to list REs in this project (mia token)
console.log('\n[4] List REs in studioenterprisemigrations (mia token)...');
const reR = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${MIA_PROJECT}/locations/us-central1/reasoningEngines`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
const reT = await reR.text();
console.log(`  status: ${reR.status}`);
if (reR.ok) {
  const reJ = JSON.parse(reT) as { reasoningEngines?: Array<{ name: string; displayName: string }> };
  console.log(`  Existing REs: ${reJ.reasoningEngines?.length ?? 0}`);
  for (const re of reJ.reasoningEngines ?? []) {
    console.log(`  ${re.name.split('/').pop()} — ${re.displayName}`);
  }
} else {
  console.log(`  Error: ${reT.slice(0, 300)}`);
}

// 5. Check existing service accounts in this project (mia token)
console.log('\n[5] Service accounts in studioenterprisemigrations...');
const saListR = await fetch(
  `https://iam.googleapis.com/v1/projects/${MIA_PROJECT}/serviceAccounts`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
const saListT = await saListR.text();
console.log(`  status: ${saListR.status}`);
if (saListR.ok) {
  const saListJ = JSON.parse(saListT) as { accounts?: Array<{ email: string; displayName?: string }> };
  console.log(`  ${saListJ.accounts?.length ?? 0} service accounts:`);
  for (const sa of saListJ.accounts ?? []) {
    console.log(`  ${sa.email} — ${sa.displayName ?? ''}`);
  }
} else {
  console.log(`  ${saListT.slice(0, 200)}`);
}

// 6. Check storage buckets
console.log('\n[6] Storage buckets in studioenterprisemigrations...');
const buckR = await fetch(
  `https://storage.googleapis.com/storage/v1/b?project=${MIA_PROJECT}`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
console.log(`  status: ${buckR.status}`);
if (buckR.ok) {
  const buckJ = await buckR.json() as { items?: Array<{ name: string }> };
  console.log(`  ${buckJ.items?.length ?? 0} buckets:`);
  for (const b of buckJ.items ?? []) console.log(`  gs://${b.name}`);
} else {
  console.log(`  ${await buckR.text().then(t => t.slice(0, 200))}`);
}

// 7. Get project number for studioenterprisemigrations
console.log('\n[7] Project details...');
const projR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${MIA_PROJECT}`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
const projJ = await projR.json() as { projectNumber?: string; name?: string; projectId?: string; lifecycleState?: string };
console.log(`  status: ${projR.status}`);
if (projR.ok) {
  console.log(`  projectId: ${projJ.projectId}`);
  console.log(`  projectNumber: ${projJ.projectNumber}`);
  console.log(`  name: ${projJ.name}`);
  console.log(`  state: ${projJ.lifecycleState}`);
}
