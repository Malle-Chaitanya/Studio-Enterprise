/**
 * Setup studioenterprisemigrations for RE deployment:
 * 1. Grant our SA aiplatform.user (mia is owner → can grant)
 * 2. Create staging bucket
 * 3. Deploy RE using our SA in mia's project (same org as Agentspace)
 * 4. Test class_method=query — same-org RE should work!
 * 5. Register as Agentspace agent
 *
 * Run: cd server && npx tsx src/spikes/_setup_mia_project_re.ts
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIA_PROJECT = 'studioenterprisemigrations';
const MIA_PROJECT_NUM = '397459811728';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const OUR_SA = 'studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com';
const LOCATION = 'us-central1';
const BUCKET = `gs://${MIA_PROJECT}-adk-staging`;
const AGENTSPACE_PROJECT = 'sonorous-lightning-t224x';

// Data store is in SA project — full resource path
const DATA_STORE = 'projects/studio-enterprise-migration/locations/global/collections/default_collection/dataStores/cf-knowledge-eng-hr';

const miaToken = await getSaToken(GEMINI_ADMIN); // mia is OWNER of studioenterprisemigrations

// ── Step 1: Grant aiplatform.user to our SA ──────────────────────────────────
console.log('[1] Granting roles/aiplatform.user to our SA on studioenterprisemigrations...');
const getPolicyR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${MIA_PROJECT}:getIamPolicy`,
  { method: 'POST', headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' }, body: '{}' }
);
const policy = await getPolicyR.json() as {
  version: number;
  bindings: Array<{ role: string; members: string[] }>;
  etag: string;
};
console.log(`  Current bindings: ${policy.bindings.length}`);

const member = `serviceAccount:${OUR_SA}`;
const ROLES_TO_GRANT = ['roles/aiplatform.user', 'roles/aiplatform.serviceAgent'];
for (const ROLE of ROLES_TO_GRANT) {
  const existing = policy.bindings.find(b => b.role === ROLE);
  if (existing?.members.includes(member)) {
    console.log(`  ✅ Already has: ${ROLE}`);
  } else if (existing) {
    existing.members.push(member);
    console.log(`  Adding to existing: ${ROLE}`);
  } else {
    policy.bindings.push({ role: ROLE, members: [member] });
    console.log(`  Adding new: ${ROLE}`);
  }
}

const setR = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${MIA_PROJECT}:setIamPolicy`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  }
);
console.log(`  setIamPolicy: ${setR.status}`);
if (!setR.ok) {
  console.error(`  Error: ${await setR.text().then(t => t.slice(0, 300))}`);
  process.exit(1);
}
console.log(`  ✅ SA granted aiplatform.user + aiplatform.serviceAgent`);
await new Promise(r => setTimeout(r, 3000)); // IAM propagation

// ── Step 2: Create staging bucket ────────────────────────────────────────────
console.log('\n[2] Creating staging bucket...');
const buckR = await fetch(
  `https://storage.googleapis.com/storage/v1/b?project=${MIA_PROJECT}`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${MIA_PROJECT}-adk-staging`, location: 'US-CENTRAL1' }),
  }
);
const buckT = await buckR.text();
if (buckR.ok) {
  console.log(`  ✅ Bucket created: ${BUCKET}`);
} else if (buckT.includes('already') || buckR.status === 409) {
  console.log(`  ✅ Bucket already exists: ${BUCKET}`);
} else {
  console.log(`  Error creating bucket: ${buckR.status} ${buckT.slice(0, 200)}`);
  // Try to continue anyway
}

// ── Step 3: Enable Agent Engine API (aiplatform) if needed ───────────────────
console.log('\n[3] Enabling aiplatform API (already enabled, double-check)...');
const apiR = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${MIA_PROJECT_NUM}/services/aiplatform.googleapis.com`,
  { headers: { Authorization: `Bearer ${miaToken}` } }
);
const apiJ = await apiR.json() as { state?: string };
console.log(`  Vertex AI API state: ${apiJ.state}`);
// Also enable reasoningengines if needed
const reApiR = await fetch(
  `https://serviceusage.googleapis.com/v1beta1/projects/${MIA_PROJECT_NUM}/services/aiplatform.googleapis.com:enable`,
  { method: 'POST', headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' }, body: '{}' }
);
console.log(`  Enable API: ${reApiR.status}`);

// ── Step 4: Deploy RE in mia's project using our SA ──────────────────────────
console.log('\n[4] Deploying RE in studioenterprisemigrations (5-10 min)...');
const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'adk_deploy.py');
const spec = {
  name: 'confluence_knowledge_mia_project',
  displayName: 'Confluence Knowledge Agent (mia-project)',
  description: 'Same-org RE in studioenterprisemigrations — testing query support',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant. Use the knowledge tool to find accurate answers from Confluence. Always cite sources.',
  groundingDataStores: [DATA_STORE],
};

try {
  const { stdout, stderr } = await execFileAsync('python', [
    scriptPath,
    '--project', MIA_PROJECT,
    '--location', LOCATION,
    '--staging-bucket', BUCKET,
    '--spec', JSON.stringify(spec),
  ], { timeout: 15 * 60 * 1000 });

  if (stderr) console.log(`  stderr: ${stderr.slice(0, 300)}`);
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  console.log(`  stdout: ${last}`);

  const out = JSON.parse(last) as { reasoningEngine?: string; error?: string };
  if (out.error) {
    console.error(`\n❌ Deploy failed: ${out.error}`);
    process.exit(1);
  }

  const reFullName = out.reasoningEngine!;
  const reId = reFullName.split('/').pop()!;
  const RE_PATH = `projects/${MIA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${reId}`;
  console.log(`\n✅ RE deployed in mia's project: ${reFullName}`);

  const saToken = await getSaToken();

  // ── Step 5: Warm up ──────────────────────────────────────────────────────
  console.log('\n[5] Warming up RE (up to 3 min)...');
  let warmed = false;
  for (let i = 0; i < 6; i++) {
    console.log(`  Attempt ${i + 1}/6 (using mia DWD token)...`);
    // Use mia's token since she owns the project
    const wr = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'warmup', message: 'ping' } }),
      }
    );
    if (wr.ok) { warmed = true; console.log(`  ✅ Warm! (${wr.status})`); break; }
    const wt = await wr.text();
    console.log(`  ${wr.status}: ${wt.slice(0, 100)} — waiting 30s`);
    await new Promise(r => setTimeout(r, 30000));
  }

  if (!warmed) { console.log('  RE not warm after 3 min'); process.exit(1); }

  // ── Step 6: Test class_method=query ──────────────────────────────────────
  console.log('\n[6] Testing class_method=query (the KEY test)...');
  const qr = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_method: 'query',
        input: { user_id: 'query-test', message: 'What is the sick leave policy?' },
      }),
    }
  );
  const qt = await qr.text();
  console.log(`  query status: ${qr.status}`);

  if (qr.ok) {
    console.log('\n✅✅✅ class_method=query WORKS in mia\'s project!');
    const answer = qt.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter(Boolean)
      .flatMap(j => ((j!['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>> ?? []).map(p => p['text'] as string))
      .filter(Boolean).join('').slice(0, 300);
    console.log(`  Answer: ${answer}`);

    // Register as Agentspace agent
    console.log('\n[7] Registering as Agentspace agent...');
    const agentspaceDest = await resolveDestination(AGENTSPACE_PROJECT, miaToken);
    const agentBase = `https://discoveryengine.googleapis.com/v1alpha/projects/${agentspaceDest.project}/locations/global/collections/default_collection/engines/${agentspaceDest.engine}/assistants/${agentspaceDest.assistant}/agents`;
    const ar = await fetch(agentBase, {
      method: 'POST',
      headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Confluence Knowledge Agent',
        description: 'Confluence ENG+HR knowledge base — migrated by CloudFuze Studio Migrate',
        starterPrompts: [
          { text: 'What is the sick leave policy?' },
          { text: 'What is the vacation policy?' },
          { text: 'How do I request time off?' },
        ],
        adkAgentDefinition: {
          provisionedReasoningEngine: { reasoningEngine: reFullName },
        },
      }),
    });
    const aj = await ar.json() as Record<string, unknown>;
    const agentId = String(aj['name']).split('/').pop();
    console.log(`  Agent: state=${aj['state']}, id=${agentId}`);

    if (aj['state'] === 'ENABLED') {
      // Share with all users
      await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
      });
      console.log('\n🎉 SUCCESS! Test in business.gemini.google → "Confluence Knowledge Agent"');
    }
  } else {
    console.log(`  Error: ${qt.slice(0, 400)}`);
    const isMethodErr = qt.includes('InvocationMethodNotFoundError') || qt.includes('query') && qt.includes('not found');
    if (isMethodErr) {
      console.log('\n❌ Same-org RE still has the query/stream_query mismatch.');
      console.log('   The platform bug is NOT fixed by same-project/same-org RE.');
    }
    console.log(`\n   RE available at: ${reFullName}`);
    console.log('   Can still use stream_query directly — just Agentspace UI broken.');
  }

} catch (e) {
  console.error(`\n❌ Exception: ${e}`);
}
