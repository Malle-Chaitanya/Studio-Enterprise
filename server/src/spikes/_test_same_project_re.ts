/**
 * Test deploying a RE in the SAME project as Agentspace (sonorous-lightning-t224x).
 * Hypothesis: same-project RE might use a different invocation path that supports
 * class_method='query', or Agentspace handles same-project RE differently.
 *
 * Run: cd server && npx tsx src/spikes/_test_same_project_re.ts
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const execFileAsync = promisify(execFile);

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const LOCATION = 'us-central1';
const BUCKET = `gs://${GCP_PROJECT}-adk-staging`;
// Data store is in studio-enterprise-migration — full resource path
const DATA_STORE = 'projects/studio-enterprise-migration/locations/global/collections/default_collection/dataStores/cf-knowledge-eng-hr';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);

// ── Step 1: Check if SA can access Vertex AI in the customer project ──────────
console.log('[1] Checking SA access to Vertex AI in customer project...');
const r = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
console.log(`  RE list status: ${r.status}`);
if (!r.ok) {
  const t = await r.text();
  console.log(`  Error: ${t.slice(0, 300)}`);
  if (r.status === 403) {
    console.log('\n  ❌ SA does not have aiplatform.user in customer project.');
    console.log('  Options:');
    console.log('  1. Customer admin grants roles/aiplatform.user to studio-migration@ on their project');
    console.log('  2. Use DWD token (mia@cloudfuze.com) for Vertex AI — see below');
  }
} else {
  const j = await r.json() as { reasoningEngines?: Array<{ name: string; displayName: string }> };
  const engines = j.reasoningEngines ?? [];
  console.log(`  ✅ SA has access! Found ${engines.length} existing REs:`);
  for (const e of engines) {
    console.log(`    ${e.name.split('/').pop()} — ${e.displayName}`);
  }
}

// ── Step 2: If SA has access, deploy a same-project RE ────────────────────────
if (r.ok) {
  console.log('\n[2] SA has access — deploying same-project RE...');
  const scriptPath = new URL('../../scripts/adk_deploy.py', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const spec = {
    name: 'confluence_knowledge_same_project',
    displayName: 'Confluence Knowledge Agent (same-project)',
    description: 'Same-project RE test — Confluence ENG+HR grounding',
    model: 'gemini-2.5-flash',
    instruction: 'You are a helpful assistant. Use the knowledge tool to find accurate answers. Always cite your sources.',
    groundingDataStores: [DATA_STORE],
  };

  try {
    const { stdout, stderr } = await execFileAsync('python', [
      scriptPath,
      '--project', GCP_PROJECT,
      '--location', LOCATION,
      '--staging-bucket', BUCKET,
      '--spec', JSON.stringify(spec),
    ], { timeout: 12 * 60 * 1000 });
    if (stderr) console.log(`  deploy stderr: ${stderr.slice(0, 200)}`);
    const lines = stdout.trim().split('\n');
    const last = lines[lines.length - 1];
    console.log(`  deploy stdout: ${last}`);
    const out = JSON.parse(last) as { reasoningEngine?: string; error?: string };
    if (out.error) {
      console.error(`  DEPLOY ERROR: ${out.error}`);
      process.exit(1);
    }
    const reId = out.reasoningEngine!.split('/').pop()!;
    const RE_PATH = `projects/${GCP_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${reId}`;
    console.log(`  ✅ Same-project RE deployed: ${out.reasoningEngine}`);

    // Wait 5 min for container
    console.log('\n[3] Waiting 5 minutes for container...');
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));

    // Test query
    console.log('\n[4] Testing class_method=query...');
    const qr = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'query', input: { user_id: 'sp-test', message: 'What is the sick leave policy?' } }),
    });
    const qt = await qr.text();
    console.log(`  query status: ${qr.status}`);
    console.log(`  ${qt.slice(0, 400)}`);

    if (qr.ok) {
      console.log('\n✅✅✅ SAME-PROJECT RE SUPPORTS query! Register as Agentspace agent and test!');
      // Register as Agentspace agent
      const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
      const agentBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;
      const ar = await fetch(agentBase, {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Confluence Knowledge (same-project)',
          description: 'Same-project RE — should support query',
          adkAgentDefinition: { provisionedReasoningEngine: { reasoningEngine: `projects/${GCP_PROJECT}/locations/${LOCATION}/reasoningEngines/${reId}` } },
        }),
      });
      const aj = await ar.json() as Record<string, unknown>;
      console.log(`  Agent registered: ${aj['state']}, ID: ${String(aj['name']).split('/').pop()}`);
    }
  } catch (e) { console.error(`  Deploy exception: ${e}`); }
} else {
  console.log('\n[2] SKIPPED — SA lacks access to customer project. Try DWD approach:');
  console.log('  Modify adk_deploy.py to accept --access-token argument instead of SA key file');
  console.log('  Pass the DWD token (mia@cloudfuze.com) as GOOGLE_OAUTH_ACCESS_TOKEN env var');
  console.log('  This allows vertexai.init() to auth via user token instead of SA key');
}
