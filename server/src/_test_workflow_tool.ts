/**
 * Test: Register a Cloud Workflow as a Dialogflow CX tool.
 *
 * Flow:
 *   1. Extract PA flow from Dataverse (Send Teams message weekly)
 *   2. Generate OpenAPI tool spec from FlowIR
 *   3. POST tool to CX Test Agent
 *   4. PATCH Default Generative Playbook to reference the tool
 *   5. Verify tool appears in agent's tool list
 *
 * Run: npx tsx src/_test_workflow_tool.ts
 */
import { readFileSync } from 'fs';
import { createSign } from 'crypto';
import { extractFlow } from './services/flowExtractor.js';
import {
  generateWorkflowToolSpec,
  registerWorkflowTool,
} from './services/workflowToolRegistrar.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const MS_TENANT   = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT   = '68beff40-49fb-4e36-82fe-317bc839a344';
const DV_URL      = 'https://orga243378d.crm.dynamics.com';
const GCP_PROJECT = 'studio-enterprise-migration';
const GCP_REGION  = 'us-central1';
const FLOW_ID     = '57670ead-9e18-f111-8341-6045bd08b5e6'; // "Send Teams message weekly"
const WORKFLOW_NAME = 'send-teams-message-weekly';

// CX Test Agent
const DF_AGENT_ID  = '2aad4f89-1ea9-4132-86cc-530bf1fe0ef1';
const DF_PLAYBOOK  = '00000000-0000-0000-0000-000000000000'; // Default Generative Playbook
const DF_BASE = `https://dialogflow.googleapis.com/v3/projects/${GCP_PROJECT}/locations/global/agents/${DF_AGENT_ID}`;

// ── Token helpers ─────────────────────────────────────────────────────────────

async function getGcpToken(): Promise<string> {
  const key = JSON.parse(readFileSync(process.env['GOOGLE_SA_KEY_FILE']!, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600 })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }) });
  const j = await r.json() as { access_token?: string };
  if (!j.access_token) throw new Error(JSON.stringify(j));
  return j.access_token;
}

async function getMsToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: MS_CLIENT, client_secret: process.env['MS_CLIENT_SECRET']!, scope: `${DV_URL}/.default` }),
  });
  const j = await res.json() as { access_token?: string; error_description?: string };
  if (!j.access_token) throw new Error(j.error_description ?? 'ms token failed');
  return j.access_token;
}

// ── Attach tool to playbook (not agent-level flows) ───────────────────────────

async function attachToolToPlaybook(gcpToken: string, toolName: string): Promise<void> {
  const hdr = { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' };

  // Get current playbook
  const pb = await (await fetch(`${DF_BASE}/playbooks/${DF_PLAYBOOK}`, { headers: hdr })).json() as {
    name: string; displayName: string; referencedTools?: string[];
  };

  const existing = pb.referencedTools ?? [];
  if (existing.includes(toolName)) {
    console.log('  Tool already attached to playbook');
    return;
  }

  const patchRes = await fetch(`${DF_BASE}/playbooks/${DF_PLAYBOOK}?updateMask=referencedTools`, {
    method: 'PATCH',
    headers: hdr,
    body: JSON.stringify({ referencedTools: [...existing, toolName] }),
  });

  if (!patchRes.ok) {
    const t = await patchRes.text();
    throw new Error(`PATCH playbook failed (${patchRes.status}): ${t.substring(0, 300)}`);
  }
  console.log('  ✓ Tool attached to playbook');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Workflow Tool Registration Test ===\n');

  console.log('1. Getting tokens...');
  const [gcpToken, msToken] = await Promise.all([getGcpToken(), getMsToken()]);
  console.log('  ✓ GCP + MS tokens OK');

  console.log('\n2. Extracting PA flow from Dataverse...');
  const ir = await extractFlow(DV_URL, msToken, FLOW_ID);
  console.log(`  ✓ Flow: "${ir.name}" (${ir.actions.length} actions, trigger: ${ir.trigger.type})`);
  console.log(`  Connectors: ${ir.connectors.map(c => c.apiName).join(', ')}`);

  console.log('\n3. Generating OpenAPI tool spec...');
  const spec = generateWorkflowToolSpec(ir, GCP_PROJECT, GCP_REGION, WORKFLOW_NAME);
  console.log(`  ✓ Tool: "${spec.toolName}"`);
  console.log(`  Execution URL: ${spec.workflowExecutionUrl}`);
  const paths = Object.keys(spec.openApiSpec['paths'] as object);
  console.log(`  OpenAPI paths: ${paths.length}`);

  console.log('\n4. Registering tool in Dialogflow CX agent...');
  let result;
  try {
    result = await registerWorkflowTool(gcpToken, GCP_PROJECT, 'global', DF_AGENT_ID, spec, ir.name.substring(0, 64));
    console.log(`  ✓ Tool registered: ${result.toolName}`);
    console.log(`  Tool ID: ${result.toolId}`);
  } catch (err) {
    // Tool might already exist
    const msg = (err as Error).message;
    if (msg.includes('409') || msg.includes('already exists')) {
      console.log(`  Tool already exists — fetching existing...`);
      const hdr = { Authorization: `Bearer ${gcpToken}` };
      const toolsRes = await (await fetch(`${DF_BASE}/tools?pageSize=50`, { headers: hdr })).json() as {
        tools?: Array<{ name: string; displayName: string }>;
      };
      const existing = (toolsRes.tools ?? []).find(t => t.displayName === ir.name.substring(0, 64));
      if (existing) {
        result = { toolName: existing.name, toolId: existing.name.split('/').pop() ?? '', displayName: existing.displayName };
        console.log(`  ✓ Using existing: ${result.toolName}`);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  console.log('\n5. Attaching tool to Default Generative Playbook...');
  await attachToolToPlaybook(gcpToken, result.toolName);

  console.log('\n6. Verifying tool in agent...');
  const hdr = { Authorization: `Bearer ${gcpToken}` };
  const toolsRes = await (await fetch(`${DF_BASE}/tools?pageSize=50`, { headers: hdr })).json() as {
    tools?: Array<{ name: string; displayName: string; toolType: string }>;
  };
  for (const t of toolsRes.tools ?? []) {
    console.log(`  ${t.toolType === 'BUILTIN_TOOL' ? '  ' : '✓ '}${t.displayName} (${t.toolType})`);
  }

  console.log('\n7. Verifying playbook references...');
  const pb = await (await fetch(`${DF_BASE}/playbooks/${DF_PLAYBOOK}`, { headers: hdr })).json() as {
    displayName: string; referencedTools?: string[];
  };
  console.log(`  Playbook: "${pb.displayName}"`);
  console.log(`  Referenced tools: ${(pb.referencedTools ?? []).length}`);
  for (const t of pb.referencedTools ?? []) {
    console.log(`    - ${t.split('/').pop()}`);
  }

  console.log('\n=== DONE ===');
  console.log(`✓ Cloud Workflow "${WORKFLOW_NAME}" registered as Dialogflow CX tool`);
  console.log(`  Gemini agent can now call it: "${ir.name}"`);
  console.log(`  Tool runs: POST ${spec.workflowExecutionUrl}`);
}

main().catch(console.error);
