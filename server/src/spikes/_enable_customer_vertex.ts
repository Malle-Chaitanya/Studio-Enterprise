/**
 * Enable Vertex AI API + grant roles in customer project using DWD token.
 * Prerequisites for deploying RE in sonorous-lightning-t224x.
 *
 * Run: cd server && npx tsx src/spikes/_enable_customer_vertex.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const OUR_SA = 'studio-migration@studio-enterprise-migration.iam.gserviceaccount.com';

const miaToken = await getSaToken(GEMINI_ADMIN); // DWD token for mia
const saToken = await getSaToken(); // SA token for studio-enterprise-migration

// ── Step 1: Enable Vertex AI (aiplatform) API in customer project ─────────────
console.log('[1] Enabling Vertex AI API in customer project...');
const enableR = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${GCP_PROJECT_NUM}/services/aiplatform.googleapis.com:enable`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  }
);
const enableT = await enableR.text();
console.log(`  Enable status: ${enableR.status}`);
if (enableR.ok) {
  const ej = JSON.parse(enableT) as { name?: string; done?: boolean };
  console.log(`  Operation: ${ej.name ?? 'n/a'}, done: ${ej.done ?? false}`);
  if (!ej.done) {
    console.log('  Waiting 10s for API enable to propagate...');
    await new Promise(r => setTimeout(r, 10000));
  }
} else {
  console.log(`  Error: ${enableT.slice(0, 300)}`);
  if (enableT.includes('already enabled') || enableR.status === 200) {
    console.log('  API may already be enabled — continuing...');
  }
}

// ── Step 2: Check current API status ─────────────────────────────────────────
console.log('\n[2] Checking Vertex AI API status...');
const statusR = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${GCP_PROJECT_NUM}/services/aiplatform.googleapis.com`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
const statusJ = await statusR.json() as { state?: string; name?: string };
console.log(`  state: ${statusJ.state}`);

// ── Step 3: Grant roles/aiplatform.user to our SA on customer project ─────────
console.log('\n[3] Granting roles/aiplatform.user to our SA...');
const getPolicyR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT}:getIamPolicy`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  }
);
if (!getPolicyR.ok) {
  console.log(`  GET policy failed: ${getPolicyR.status} ${await getPolicyR.text().then(t => t.slice(0, 200))}`);
} else {
  const policy = await getPolicyR.json() as {
    version: number;
    bindings: Array<{ role: string; members: string[] }>;
    etag: string;
  };
  console.log(`  Current bindings: ${policy.bindings.length}`);

  const member = `serviceAccount:${OUR_SA}`;
  const ROLE = 'roles/aiplatform.user';
  const existing = policy.bindings.find(b => b.role === ROLE);

  if (existing?.members.includes(member)) {
    console.log(`  ✅ Already granted: ${member} → ${ROLE}`);
  } else {
    if (existing) {
      existing.members.push(member);
    } else {
      policy.bindings.push({ role: ROLE, members: [member] });
    }
    const setR = await fetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT}:setIamPolicy`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
      }
    );
    console.log(`  setIamPolicy: ${setR.status}`);
    if (setR.ok) {
      console.log(`  ✅ Granted ${member} → ${ROLE} on ${GCP_PROJECT}`);
    } else {
      console.log(`  Error: ${await setR.text().then(t => t.slice(0, 300))}`);
    }
  }
}

// ── Step 4: Grant Storage access for staging bucket ───────────────────────────
console.log('\n[4] Granting storage access for staging bucket...');
const bucketName = `${GCP_PROJECT}-adk-staging`;
// Create bucket first if needed
const createBucketR = await fetch(
  `https://storage.googleapis.com/storage/v1/b?project=${GCP_PROJECT}`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bucketName, location: 'US-CENTRAL1' }),
  }
);
const cbT = await createBucketR.text();
console.log(`  Create bucket status: ${createBucketR.status}`);
if (createBucketR.ok) {
  console.log(`  ✅ Bucket ${bucketName} created`);
} else if (cbT.includes('already') || createBucketR.status === 409) {
  console.log(`  Bucket ${bucketName} already exists`);
} else {
  console.log(`  Bucket error: ${cbT.slice(0, 200)}`);
}

// Grant storage admin to our SA on this bucket
const iamBucketR = await fetch(
  `https://storage.googleapis.com/storage/v1/b/${bucketName}/iam`,
  {
    method: 'PUT',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bindings: [
        { role: 'roles/storage.objectAdmin', members: [`serviceAccount:${OUR_SA}`] },
        { role: 'roles/storage.admin', members: [`serviceAccount:${OUR_SA}`] },
      ],
    }),
  }
);
console.log(`  Bucket IAM status: ${iamBucketR.status}`);
if (iamBucketR.ok) console.log(`  ✅ SA has storage access on ${bucketName}`);
else console.log(`  Error: ${await iamBucketR.text().then(t => t.slice(0, 200))}`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('Setup complete. Now run:');
console.log('  npx tsx src/spikes/_test_same_project_re.ts');
console.log('to deploy a RE in the customer project and test same-project behavior.');
console.log('══════════════════════════════════════════════════════════');
