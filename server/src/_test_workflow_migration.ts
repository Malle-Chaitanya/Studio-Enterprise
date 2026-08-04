/**
 * End-to-end workflow migration test.
 * Fetches real PA flows from Dataverse, maps to Cloud Workflow YAML, deploys to GCP.
 *
 * Run: npx tsx src/_test_workflow_migration.ts
 */

import { extractFlow } from './services/flowExtractor.js';
import { mapFlow } from './services/flowMapper.js';
import { generateYaml } from './services/hermasClient.js';

const MS_TENANT   = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT   = '68beff40-49fb-4e36-82fe-317bc839a344';
const MS_SECRET   = process.env['MS_CLIENT_SECRET']!;
const DV_URL      = 'https://orga243378d.crm.dynamics.com';
const GCP_PROJECT = 'studio-enterprise-migration';
const GCP_REGION  = 'us-central1';
const SA_KEY_FILE = process.env['GOOGLE_SA_KEY_FILE']!;

// Real user flows from filefuze Copilot Studio environment
const TEST_FLOWS = [
  { id: '8c93b37c-3a12-5e90-8176-e665fdc7f6ef', name: 'SharePoint to Teams notification',       expectedTrigger: 'Webhook' },
  { id: '08b219cb-7e1b-04ae-5b20-41d883d08951', name: '5. File notification',                   expectedTrigger: 'Webhook' },
  { id: 'b0808476-47ee-ac4d-eed1-53b984146aae', name: 'New email alert',                        expectedTrigger: 'Webhook' },
  { id: '9d607533-fe84-f111-ab0f-0022480a981d', name: 'New email arrives -> Send email',        expectedTrigger: 'Webhook' },
  { id: '5af4b5a4-c964-f111-a826-6045bd08b5e6', name: 'API TEST',                               expectedTrigger: 'HttpRequest' },
  { id: '7fa1bbc0-de59-f111-bec7-6045bd08b5e6', name: 'Sample Flow',                            expectedTrigger: 'Recurrence' },
  { id: '57670ead-9e18-f111-8341-6045bd08b5e6', name: 'Send Teams message weekly',              expectedTrigger: 'Recurrence' },
  { id: 'c5b872ae-61f9-b914-9082-d815f3693596', name: 'New file in SharePoint -> Teams',        expectedTrigger: 'Webhook' },
];

// ── MS token ──────────────────────────────────────────────────────────────────

async function getMsToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     MS_CLIENT,
    client_secret: MS_SECRET,
    scope:         `${DV_URL}/.default`,
  });
  const res  = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    { method: 'POST', body },
  );
  const json = await res.json() as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(`MS token failed: ${json.error_description}`);
  return json.access_token;
}

// ── GCP SA token ──────────────────────────────────────────────────────────────

async function getGcpToken(): Promise<string> {
  const { readFileSync } = await import('fs');
  const { createSign }   = await import('crypto');

  const key     = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as {
    client_email: string; private_key: string;
  };
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    sub: key.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const sig = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(key.private_key, 'base64url');

  const jwt = `${header}.${payload}.${sig}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await res.json() as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(`GCP token failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

// ── GCP Workflow deploy + test ────────────────────────────────────────────────

async function deployAndTest(
  gcpToken: string,
  workflowName: string,
  yaml: string,
): Promise<{ deployed: boolean; executed: boolean; state: string; error: string | null }> {
  const base = `https://workflows.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}`;

  // Try create, if 409 already exists do PUT update
  let opRes = await fetch(`${base}/workflows?workflowId=${workflowName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceContents: yaml }),
  });

  if (opRes.status === 409) {
    opRes = await fetch(`${base}/workflows/${workflowName}?updateMask=sourceContents`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceContents: yaml }),
    });
  }

  if (!opRes.ok) {
    const err = await opRes.text();
    return { deployed: false, executed: false, state: 'DEPLOY_FAILED', error: err };
  }

  const op = await opRes.json() as { name: string };

  // Poll operation
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const pollRes = await fetch(`https://workflows.googleapis.com/v1/${op.name}`, {
      headers: { Authorization: `Bearer ${gcpToken}` },
    });
    const poll = await pollRes.json() as { done?: boolean; error?: { message: string }; response?: { state: string } };
    if (poll.done) {
      if (poll.error) return { deployed: false, executed: false, state: 'DEPLOY_FAILED', error: poll.error.message };
      break;
    }
  }

  // Run test execution with real org_url so Entra token step can attempt auth
  // (will fail at MS level with invalid creds but proves YAML executes correctly)
  const execRes = await fetch(
    `https://workflowexecutions.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}/workflows/${workflowName}/executions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argument: JSON.stringify({
          tenant_id: MS_TENANT,
          client_id: MS_CLIENT,
          client_secret: MS_SECRET,
          org_url: 'org32322095.crm.dynamics.com',
          create_contact_body: { firstname: 'CloudFuze', lastname: 'Test' },
          entity_name: 'contacts',
          entity_id: '00000000-0000-0000-0000-000000000001',
          event_type: 'created',
          subjectFilter: 'urgent',
          subject_filter: 'urgent',
          from_filter: '',
          fromFilter: '',
          folderPath: '/root/Documents',
          folder_path: '/root/Documents',
        }),
      }),
    },
  );

  if (!execRes.ok) {
    return { deployed: true, executed: false, state: 'EXEC_CREATE_FAILED', error: await execRes.text() };
  }

  const exec = await execRes.json() as { name: string };

  // Poll execution
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const statusRes = await fetch(
      `https://workflowexecutions.googleapis.com/v1/${exec.name}`,
      { headers: { Authorization: `Bearer ${gcpToken}` } },
    );
    const status = await statusRes.json() as { state: string; error?: { payload: string } };
    if (status.state !== 'ACTIVE' && status.state !== 'QUEUED') {
      return {
        deployed: true,
        executed: true,
        state: status.state,
        error: status.error?.payload ?? null,
      };
    }
  }

  return { deployed: true, executed: true, state: 'TIMEOUT', error: 'Execution did not complete in 60s' };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Auth/API errors in test mode — don't fix-loop, they need real creds not YAML fixes.
function isExpectedAuthError(error: string | null): boolean {
  if (!error) return false;
  return error.includes('InvalidAuthenticationToken') ||
    error.includes('AuthorizationFailed') ||
    error.includes('InvalidClientSecret') ||
    error.includes('AADSTS') ||
    error.includes("'bytes'") ||           // Cloud Workflows bytes type — API format mismatch
    error.includes('BadRequest');          // Teams/Graph API call format wrong
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Getting MS token...');
  const msToken  = await getMsToken();
  console.log('Getting GCP token...');
  const gcpToken = await getGcpToken();

  const results: Array<{
    name: string; trigger: string; confidence: number;
    warnings: string[]; deployed: boolean; executed: boolean; gcpState: string;
    gcpError: string | null; workflowUrl: string;
  }> = [];

  for (const { id, name, expectedTrigger } of TEST_FLOWS) {
    console.log(`\n=== ${name} (expected: ${expectedTrigger}) ===`);

    try {
      // 1. Extract FlowIR from Dataverse
      const ir = await extractFlow(DV_URL, msToken, id);
      console.log(`  trigger=${ir.trigger.type} confidence=${ir.confidence.score} strategy=${ir.confidence.strategy}`);
      console.log(`  actions=${ir.actions.length} connectors=${ir.connectors.map(c => c.apiName).join(', ')}`);

      // 2. Map to YAML — fall back to Hermas if unsupported
      const mapped = mapFlow(ir, {});
      let yaml = mapped.yaml;
      let usedHermas = false;

      if (mapped.unsupported) {
        console.log(`  rule-based UNSUPPORTED (${mapped.unsupportedReason}) → sending to Hermas...`);
        try {
          yaml = await generateYaml(ir, {});
          usedHermas = true;
          console.log(`  Hermas YAML generated (${yaml.length} chars)`);
        } catch (hermasErr) {
          console.log(`  Hermas failed: ${(hermasErr as Error).message}`);
          results.push({
            name, trigger: ir.trigger.type, confidence: 0,
            warnings: [String(hermasErr)], deployed: false, executed: false,
            gcpState: 'HERMAS_FAILED', gcpError: String(hermasErr), workflowUrl: '',
          });
          continue;
        }
      } else {
        console.log(`  YAML generated (${yaml.length} chars), confidence=${mapped.confidence}`);
        if (mapped.warnings.length) console.log(`  warnings: ${mapped.warnings.join('; ')}`);
        if (mapped.schedulerConfig) console.log(`  Cloud Scheduler: ${mapped.schedulerConfig.schedule}`);
        if (mapped.pubSubConfig) console.log(`  Pub/Sub topic: ${mapped.pubSubConfig.topicName}`);
      }

      // 3. Deploy + test in GCP — with agentic fix loop (max 3 retries via Hermas)
      // GCP workflow IDs must start with a letter
      const rawName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/-$/, '');
      const workflowName = (/^[a-z]/.test(rawName) ? rawName : `flow-${rawName}`).substring(0, 63);
      console.log(`  Deploying as: ${workflowName}${usedHermas ? ' (via Hermas)' : ''}`);

      let result = await deployAndTest(gcpToken, workflowName, yaml);
      console.log(`  deployed=${result.deployed} executed=${result.executed} state=${result.state}`);
      if (result.error) console.log(`  error=${result.error.substring(0, 200)}`);

      // ── Agentic fix loop (item #6) ─────────────────────────────────────────
      // If deploy failed or execution failed for YAML reasons, send error to
      // Hermas to fix and retry. Max 3 attempts. Auth errors are expected in
      // test mode (fake creds) — don't retry those.
      const MAX_FIX_ATTEMPTS = 3;
      let fixAttempt = 0;
      while (
        usedHermas &&
        (result.state === 'DEPLOY_FAILED' || result.state === 'FAILED') &&
        !isExpectedAuthError(result.error) &&
        fixAttempt < MAX_FIX_ATTEMPTS
      ) {
        fixAttempt++;
        console.log(`  [fix loop attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS}] sending error to Hermas...`);
        try {
          yaml = await generateYaml(ir, {}, {
            errorContext: result.error ?? 'Unknown deployment error',
            previousYaml: yaml,
            attempt: fixAttempt,
          });
          console.log(`  Hermas fix YAML (${yaml.length} chars) — redeploying...`);
          result = await deployAndTest(gcpToken, workflowName, yaml);
          console.log(`  [fix ${fixAttempt}] deployed=${result.deployed} state=${result.state}`);
          if (result.error) console.log(`  [fix ${fixAttempt}] error=${result.error.substring(0, 200)}`);
        } catch (fixErr) {
          console.log(`  [fix ${fixAttempt}] Hermas error: ${(fixErr as Error).message}`);
          break;
        }
      }

      const workflowUrl = `https://console.cloud.google.com/workflows/detail/${GCP_REGION}/${workflowName}/executions?project=${GCP_PROJECT}`;
      results.push({
        name, trigger: ir.trigger.type,
        confidence: usedHermas ? -1 : mapped.confidence,
        warnings: usedHermas ? ['via Hermas'] : mapped.warnings,
        ...result, gcpState: result.state,
        gcpError: result.error, workflowUrl,
      });

    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}`);
      results.push({
        name, trigger: expectedTrigger, confidence: 0,
        warnings: [(err as Error).message], deployed: false, executed: false,
        gcpState: 'ERROR', gcpError: (err as Error).message, workflowUrl: '',
      });
    }
  }

  console.log('\n\n=== RESULTS ===');
  for (const r of results) {
    const status = r.gcpState === 'SUCCEEDED' ? 'PASS' : r.gcpState === 'UNSUPPORTED' ? 'SKIP' : 'FAIL';
    console.log(`[${status}] ${r.name}`);
    console.log(`       trigger=${r.trigger} confidence=${r.confidence} gcpState=${r.gcpState}`);
    if (r.workflowUrl) console.log(`       ${r.workflowUrl}`);
    if (r.gcpError) console.log(`       error=${r.gcpError.substring(0, 150)}`);
  }
}

main().catch(console.error);
