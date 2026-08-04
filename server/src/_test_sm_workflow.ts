/**
 * Secret Manager end-to-end test.
 *
 * 1. Gets GCP token via SA key
 * 2. Stores MS credentials in Secret Manager (studio-enterprise-migration project)
 * 3. Grants the Workflows SA secretAccessor on each secret
 * 4. Maps "Send Teams message weekly" with useSecretManager=true
 * 5. Deploys to GCP with the custom SA (so it can read secrets)
 * 6. Runs execution with ONLY { gcp_project } in args — no MS creds
 * 7. Polls and prints result
 *
 * Expected: Entra token step SUCCEEDS (reads real creds from SM).
 * Teams/Graph step may still fail (no delegated auth) — that is expected.
 *
 * Run: npx tsx src/_test_sm_workflow.ts
 */

import { extractFlow } from './services/flowExtractor.js';
import { mapFlow } from './services/flowMapper.js';
import { setupMsCredentials } from './services/secretManager.js';

const MS_TENANT     = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT     = '68beff40-49fb-4e36-82fe-317bc839a344';
const MS_SECRET     = process.env['MS_CLIENT_SECRET']!;
const DV_URL        = 'https://orga243378d.crm.dynamics.com';
const GCP_PROJECT   = 'studio-enterprise-migration';
const GCP_REGION    = 'us-central1';
const SA_KEY_FILE   = process.env['GOOGLE_SA_KEY_FILE']!;

// The SA we deploy workflows AS — it has secretAccessor granted to it
const WORKFLOWS_SA  = 'studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com';

// "Send Teams message weekly" — rule-based, Recurrence trigger, uses Dataverse + Teams
const FLOW_ID   = '57670ead-9e18-f111-8341-6045bd08b5e6';
// flow name for reference: Send Teams message weekly

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getMsToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: MS_CLIENT,
        client_secret: MS_SECRET,
        scope: `${DV_URL}/.default`,
      }),
    },
  );
  const json = await res.json() as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(`MS token failed: ${json.error_description}`);
  return json.access_token;
}

async function getGcpToken(): Promise<string> {
  const { readFileSync } = await import('fs');
  const { createSign }   = await import('crypto');

  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as {
    client_email: string; private_key: string;
  };
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email, sub: key.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    iat: now, exp: now + 3600,
  })).toString('base64url');

  const sig = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(key.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${sig}`,
    }),
  });
  const json = await res.json() as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(`GCP token failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

// ── GCP Workflow deploy + execute ─────────────────────────────────────────────

const BASE = `https://workflows.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}`;
const EXEC_BASE = `https://workflowexecutions.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}`;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function deploy(gcpToken: string, workflowName: string, yaml: string): Promise<void> {
  const headers = { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' };
  // Deploy with our custom SA so it can read Secret Manager secrets
  const body = JSON.stringify({
    sourceContents: yaml,
    serviceAccount: WORKFLOWS_SA,
  });

  let opRes = await fetch(`${BASE}/workflows?workflowId=${workflowName}`, {
    method: 'POST', headers, body,
  });

  if (opRes.status === 409) {
    opRes = await fetch(`${BASE}/workflows/${workflowName}?updateMask=sourceContents,serviceAccount`, {
      method: 'PATCH', headers, body,
    });
  }

  if (!opRes.ok) {
    const err = await opRes.text();
    throw new Error(`Deploy failed (${opRes.status}): ${err}`);
  }

  const op = await opRes.json() as { name: string };

  // Poll operation until done
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const pollRes = await fetch(`https://workflows.googleapis.com/v1/${op.name}`, {
      headers: { Authorization: `Bearer ${gcpToken}` },
    });
    const poll = await pollRes.json() as { done?: boolean; error?: { message: string } };
    if (poll.done) {
      if (poll.error) throw new Error(`Deploy operation failed: ${poll.error.message}`);
      return;
    }
  }
  throw new Error('Deploy operation timed out');
}

async function execute(
  gcpToken: string,
  workflowName: string,
  args: Record<string, unknown>,
): Promise<{ state: string; error: string | null; stepAttempted: string | null }> {
  const execRes = await fetch(
    `${EXEC_BASE}/workflows/${workflowName}/executions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ argument: JSON.stringify(args) }),
    },
  );

  if (!execRes.ok) {
    const err = await execRes.text();
    throw new Error(`Execution create failed (${execRes.status}): ${err}`);
  }

  const exec = await execRes.json() as { name: string };

  // Poll until terminal state
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const statusRes = await fetch(`https://workflowexecutions.googleapis.com/v1/${exec.name}`, {
      headers: { Authorization: `Bearer ${gcpToken}` },
    });
    const status = await statusRes.json() as {
      state: string;
      error?: { payload: string; stackTrace?: { elements: Array<{ step: string }> } };
    };
    if (status.state !== 'ACTIVE' && status.state !== 'QUEUED') {
      const errorPayload = status.error?.payload ?? null;
      const firstStep = status.error?.stackTrace?.elements?.[0]?.step ?? null;
      return { state: status.state, error: errorPayload, stepAttempted: firstStep };
    }
  }
  return { state: 'TIMEOUT', error: 'Did not complete in 90s', stepAttempted: null };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Secret Manager Workflow Test ===\n');

  console.log('1. Getting tokens...');
  const [msToken, gcpToken] = await Promise.all([getMsToken(), getGcpToken()]);
  console.log('   MS token OK, GCP SA token OK');

  console.log('\n2. Storing MS credentials in Secret Manager...');
  await setupMsCredentials(gcpToken, GCP_PROJECT, {
    tenantId: MS_TENANT,
    clientId: MS_CLIENT,
    clientSecret: MS_SECRET,
    orgUrl: 'orga243378d.crm.dynamics.com',
  }, WORKFLOWS_SA);
  console.log('   Secrets stored + IAM granted to:', WORKFLOWS_SA);

  console.log('\n3. Extracting flow IR from Dataverse...');
  const ir = await extractFlow(DV_URL, msToken, FLOW_ID);
  console.log(`   trigger=${ir.trigger.type} confidence=${ir.confidence.score} actions=${ir.actions.length}`);

  console.log('\n4. Mapping flow with useSecretManager=true...');
  const mapped = mapFlow(ir, {}, { useSecretManager: true, gcpProject: GCP_PROJECT });
  if (mapped.unsupported) {
    console.error('   UNSUPPORTED:', mapped.unsupportedReason);
    process.exit(1);
  }
  console.log(`   YAML generated (${mapped.yaml.length} chars) confidence=${mapped.confidence}`);
  console.log('   First 400 chars of YAML:');
  console.log(mapped.yaml.substring(0, 400));

  const workflowName = 'sm-test-send-teams-weekly';
  console.log(`\n5. Deploying as "${workflowName}" with SA ${WORKFLOWS_SA}...`);
  await deploy(gcpToken, workflowName, mapped.yaml);
  console.log('   Deployed OK');

  console.log('\n6. Executing with ONLY gcp_project in args (no MS credentials)...');
  const result = await execute(gcpToken, workflowName, {
    gcp_project: GCP_PROJECT,
    // No tenant_id, client_id, client_secret — these come from Secret Manager
  });

  console.log('\n=== RESULT ===');
  console.log(`   state: ${result.state}`);
  if (result.stepAttempted) console.log(`   failed at step: ${result.stepAttempted}`);
  if (result.error) {
    console.log(`   error: ${result.error.substring(0, 400)}`);
  }

  const smSteps = ['get_ms_tenant_id', 'get_ms_client_id', 'get_ms_client_secret', 'get_ms_org_url', 'decode_ms_secrets', 'get_entra_token'];
  if (result.stepAttempted && !smSteps.includes(result.stepAttempted)) {
    console.log('\n   SECRET MANAGER STEPS PASSED — error is downstream (expected for Teams/Graph)');
  } else if (result.state === 'SUCCEEDED') {
    console.log('\n   FULL SUCCESS — Secret Manager + Entra token working end-to-end');
  } else if (result.stepAttempted && smSteps.includes(result.stepAttempted)) {
    console.log('\n   FAILED AT SECRET MANAGER STEP — check IAM and secret names');
  }

  console.log('\nWorkflow URL:');
  console.log(`   https://console.cloud.google.com/workflows/detail/${GCP_REGION}/${workflowName}/executions?project=${GCP_PROJECT}`);
}

main().catch(console.error);
