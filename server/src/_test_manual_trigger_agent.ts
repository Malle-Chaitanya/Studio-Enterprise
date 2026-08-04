/**
 * Test: register a Manual-trigger Cloud Workflow as a Dialogflow CX tool,
 * create an agent playbook that uses it, then send a test query.
 *
 * Auth modes (set AUTH_MODE env var):
 *   "iam"  — SA has been granted roles/dialogflow.admin on customer's GCP project (Option A).
 *            CloudFuze SA calls Dialogflow directly. No DWD needed.
 *            Customer action: GCP IAM grant only.
 *
 *   "dwd"  — SA is registered in customer's Workspace Admin for DWD (Option B / production).
 *            CloudFuze SA impersonates customer user (DWD_SUBJECT).
 *            Customer action: Workspace Admin DWD + optional IAM grant.
 *
 * Production model:
 *   Customer (mia) does ONE-TIME setup:
 *     1. GCP IAM: grant roles/dialogflow.admin to CloudFuze SA on their project
 *     2. Workspace Admin → DWD: add SA client_id 110659723964649683952 with scopes:
 *          https://www.googleapis.com/auth/dialogflow
 *          https://www.googleapis.com/auth/cloud-platform
 *          https://www.googleapis.com/auth/chat.bot
 *
 * Required env:
 *   GOOGLE_SA_KEY_FILE   — path to service_account.json
 *   DIALOGFLOW_PROJECT   — customer's GCP project (sonorous-lightning-t224x)
 *   DIALOGFLOW_LOCATION  — CX location (us-central1)
 *   WORKFLOW_NAME        — deployed workflow (test-google-chat-path)
 *   WORKFLOW_REGION      — us-central1
 *   WORKFLOW_GCP_PROJECT — studio-enterprise-migration (where workflows live)
 *   AUTH_MODE            — "iam" (default) or "dwd"
 *   DWD_SUBJECT          — customer email for DWD (mia@cloudfuze.com)
 *   SERVER_BASE_URL      — proxy server base URL (default: http://localhost:8080)
 *
 * Run (IAM mode — after granting SA Dialogflow Admin on customer project):
 *   $env:GOOGLE_SA_KEY_FILE="C:/Users/LaxmanKadari/STD_ENT/Studio-Enterprise/server/service_account.json"
 *   $env:DIALOGFLOW_PROJECT="sonorous-lightning-t224x"
 *   $env:DIALOGFLOW_LOCATION="us-central1"
 *   $env:WORKFLOW_NAME="test-google-chat-path"
 *   $env:WORKFLOW_REGION="us-central1"
 *   $env:WORKFLOW_GCP_PROJECT="studio-enterprise-migration"
 *   $env:AUTH_MODE="iam"
 *   npx tsx src/_test_manual_trigger_agent.ts
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';

// ── Config ────────────────────────────────────────────────────────────────────

const SA_KEY_FILE      = process.env['GOOGLE_SA_KEY_FILE']!;
const DF_PROJECT       = process.env['DIALOGFLOW_PROJECT'] ?? 'sonorous-lightning-t224x';
const DF_LOCATION      = process.env['DIALOGFLOW_LOCATION'] ?? 'us-central1';
const WORKFLOW_NAME    = process.env['WORKFLOW_NAME'] ?? 'test-google-chat-path';
const WORKFLOW_REGION  = process.env['WORKFLOW_REGION'] ?? 'us-central1';
const WORKFLOW_PROJECT = process.env['WORKFLOW_GCP_PROJECT'] ?? 'studio-enterprise-migration';
const SERVER_BASE      = process.env['SERVER_BASE_URL'] ?? 'http://localhost:8080';
const AUTH_MODE        = process.env['AUTH_MODE'] ?? 'iam'; // "iam" or "dwd"
const DWD_SUBJECT      = process.env['DWD_SUBJECT'] ?? 'mia@cloudfuze.com';

const DF_BASE = `https://${DF_LOCATION}-dialogflow.googleapis.com/v3beta1/projects/${DF_PROJECT}/locations/${DF_LOCATION}`;

// ── Token helpers ─────────────────────────────────────────────────────────────

function buildJwt(
  key: { client_email: string; private_key: string },
  claims: Record<string, unknown>,
): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, iat: now, exp: now + 3600, ...claims })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  return `${h}.${p}.${s}`;
}

async function exchangeJwt(assertion: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const j = await res.json() as { access_token?: string; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Token exchange failed: ${j.error_description ?? j.error}`);
  return j.access_token;
}

/** IAM mode: SA token with cloud-platform scope (SA must have IAM role on customer project). */
async function getSaToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
  return exchangeJwt(buildJwt(key, {
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  }));
}

/** DWD mode: SA impersonates customer user (SA client_id must be in customer Workspace Admin). */
async function getDwdToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
  return exchangeJwt(buildJwt(key, {
    sub: DWD_SUBJECT,
    aud: 'https://oauth2.googleapis.com/token',
    scope: [
      'https://www.googleapis.com/auth/dialogflow',
      'https://www.googleapis.com/auth/cloud-platform',
    ].join(' '),
  }));
}

async function getToken(): Promise<string> {
  if (AUTH_MODE === 'dwd') return getDwdToken();
  return getSaToken();
}

// ── Dialogflow helpers ────────────────────────────────────────────────────────

async function dfPost(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${DF_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function dfGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${DF_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── OpenAPI spec for the Manual trigger proxy endpoint ────────────────────────
// This is what generateWorkflowToolSpec() would produce for a Manual trigger.
// Adjust parameters to match the actual workflow's inputs.

function buildOpenApiSpecYaml(): string {
  // Dialogflow CX requires HTTPS for the server URL.
  // For local dev we use ngrok or a placeholder; swap SERVER_BASE for a tunnel URL in prod.
  const serverUrl = SERVER_BASE.startsWith('http://localhost')
    ? 'https://studio-enterprise-proxy.cloudfuze.com'
    : SERVER_BASE;
  return `openapi: "3.0.0"
info:
  title: "Send Google Chat Message"
  version: "1.0.0"
servers:
  - url: "${serverUrl}"
paths:
  /trigger:
    post:
      operationId: send_google_chat_message
      summary: "Send a message to a Google Chat space"
      description: "Triggers a Cloud Workflow that posts a message to a Google Chat space. Ask the user for the chat space ID and the message text."
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required:
                - chat_space_id
                - message_text
              properties:
                chat_space_id:
                  type: string
                  description: "Google Chat space ID, e.g. spaces/XXXXXXX"
                message_text:
                  type: string
                  description: "The message to send to the Chat space"
      responses:
        "200":
          description: "Message sent successfully"
          content:
            application/json:
              schema:
                type: object
                properties:
                  executionId:
                    type: string
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Manual Trigger Agent Test ===\n');
  console.log(`Workflow : ${WORKFLOW_NAME} (${WORKFLOW_REGION})`);
  console.log(`Agent    : Dialogflow CX in ${DF_PROJECT}/${DF_LOCATION}`);
  console.log(`Auth     : ${AUTH_MODE === 'dwd' ? `DWD → ${DWD_SUBJECT}` : 'IAM (SA direct)'}\n`);

  // 1. Token
  console.log(`1. Getting ${AUTH_MODE === 'dwd' ? 'DWD' : 'SA IAM'} token...`);
  const token = await getToken();
  console.log(` ✓ Token: ${token.substring(0, 20)}...\n`);

  // 2. Create or reuse Generative Playbook agent (Vertex AI Agent Builder)
  // Must use genAppBuilderSettings to enable Playbooks + Tools support.
  console.log('2. Creating Vertex AI Agent Builder (Generative Playbook) agent...');
  const agentDisplayName = `SE-Migration Agent`;
  let agent: { name: string };
  let agentId: string;

  const list = await dfGet(token, `/agents?pageSize=50`) as { agents?: Array<{ name: string; displayName: string }> };
  const existing = list.agents?.find(a => a.displayName === agentDisplayName);

  if (existing) {
    agent = existing;
    agentId = agent.name.split('/').pop()!;
    console.log(` ✓ Reusing existing agent: ${agent.name}\n`);
  } else {
    // Generative agents require genAppBuilderSettings pointing to a CCAI engine.
    // For projects without an existing engine, omit it — the API creates a default one.
    agent = await dfPost(token, '/agents', {
      displayName: agentDisplayName,
      defaultLanguageCode: 'en',
      timeZone: 'America/New_York',
      description: 'CloudFuze Studio-Enterprise migration agent',
      // Enables Generative Playbooks and Tools — production flag
      enableGenerativeAgent: true,
      // Vertex AI model to use for the playbook
      genAppBuilderSettings: {
        engine: `projects/${DF_PROJECT}/locations/${DF_LOCATION}/collections/default_collection/engines/default_search`,
      },
    }) as { name: string };
    agentId = agent.name.split('/').pop()!;
    console.log(` ✓ Agent created: ${agent.name}\n`);
  }

  // 3. Create OpenAPI tool
  console.log('3. Creating OpenAPI tool pointing to proxy endpoint...');
  // Try JSON format — some Dialogflow CX versions prefer it over YAML
  // Minimal spec to isolate parsing error — no requestBody
  const specJson = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Send Chat Message', version: '1.0.0' },
    servers: [{ url: 'https://studio-enterprise-proxy.cloudfuze.com' }],
    paths: {
      '/trigger': {
        post: {
          operationId: 'send_google_chat_message',
          summary: 'Send a message to a Google Chat space',
          parameters: [
            { name: 'chat_space_id', in: 'query', required: true, schema: { type: 'string' }, description: 'Google Chat space ID e.g. spaces/XXXXXXX' },
            { name: 'message_text', in: 'query', required: true, schema: { type: 'string' }, description: 'Message to send' },
          ],
          responses: {
            '200': {
              description: 'Message sent',
              content: { 'application/json': { schema: { type: 'object', properties: { executionId: { type: 'string' } } } } },
            },
          },
        },
      },
    },
  });
  // Try functionSpec first to verify Tools API works, then switch to openApiSpec
  const toolBody = {
    displayName: `send-chat-message`,
    description: 'Send a message to a Google Chat space by triggering a Cloud Workflow.',
    functionSpec: {
      inputSchema: {
        type: 'object',
        required: ['chat_space_id', 'message_text'],
        properties: {
          chat_space_id: { type: 'string', description: 'Google Chat space ID e.g. spaces/XXXXXXX' },
          message_text: { type: 'string', description: 'The message content to send' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          executionId: { type: 'string', description: 'Cloud Workflow execution ID' },
        },
      },
    },
  };
  let tool: { name: string };
  try {
    tool = await dfPost(token, `/agents/${agentId}/tools`, toolBody) as { name: string };
    console.log(` ✓ Tool created: ${tool.name}\n`);
  } catch (e) {
    if (!(e as Error).message.includes('ALREADY_EXISTS')) throw e;
    const tList = await dfGet(token, `/agents/${agentId}/tools`) as { tools?: Array<{ name: string; displayName: string }> };
    tool = tList.tools?.find(t => t.displayName === 'send-chat-message') ?? { name: '' };
    console.log(` ✓ Reusing tool: ${tool.name}\n`);
  }

  // 3b. Register webhook so Dialogflow can call our server when tool fires
  console.log('3b. Registering Dialogflow webhook (our proxy handler)...');
  const webhookUrl = `${SERVER_BASE}/api/workflows/dialogflow-webhook`;
  let webhookName: string;
  try {
    const wh = await dfPost(token, `/agents/${agentId}/webhooks`, {
      displayName: 'studio-enterprise-tool-handler',
      genericWebService: { uri: webhookUrl, httpMethod: 'POST' },
    }) as { name: string };
    webhookName = wh.name;
    console.log(` ✓ Webhook: ${webhookName}`);
  } catch (e) {
    if (!(e as Error).message.includes('ALREADY_EXISTS')) throw e;
    const whList = await dfGet(token, `/agents/${agentId}/webhooks`) as { webhooks?: Array<{ name: string; displayName: string }> };
    webhookName = whList.webhooks?.find(w => w.displayName === 'studio-enterprise-tool-handler')?.name ?? '';
    console.log(` ✓ Reusing webhook: ${webhookName}`);
  }
  console.log('');

  // 4. Create playbook that uses the tool
  console.log('4. Creating playbook that uses the tool...');
  const toolId = tool.name.split('/').pop()!;
  const playbookBody = {
    displayName: 'Send Google Chat message',
    goal:
      'Help the user send a message to a Google Chat space. ' +
      'Ask the user which Chat space to send to (chat_space_id) and what message to send (message_text). ' +
      'Then call send_google_chat_message with those values and confirm success.',
    referencedTools: [tool.name],
    steps: [
      { text: 'Ask the user: "Which Google Chat space should I send to? Please provide the space ID (e.g. spaces/XXXXXXX)."' },
      { text: 'Ask the user: "What message would you like to send?"' },
      { text: 'Call send_google_chat_message with chat_space_id, message_text, and gcp_project="studio-enterprise-migration".' },
      { text: 'Confirm to the user that the message was sent successfully.' },
    ],
  };
  let playbook: { name: string };
  try {
    playbook = await dfPost(token, `/agents/${agentId}/playbooks`, playbookBody) as { name: string };
    console.log(` ✓ Playbook created: ${playbook.name}\n`);
  } catch (e) {
    if (!(e as Error).message.includes('ALREADY_EXISTS')) throw e;
    const pbList = await dfGet(token, `/agents/${agentId}/playbooks`) as { playbooks?: Array<{ name: string; displayName: string }> };
    playbook = pbList.playbooks?.find(p => p.displayName === 'Send Google Chat message') ?? { name: '' };
    console.log(` ✓ Reusing playbook: ${playbook.name}\n`);
  }

  // 5. Test via detectIntent (simulate user message)
  console.log('5. Sending test query to agent...');
  const sessionId = `test-session-${Date.now()}`;
  const detectBody = {
    queryInput: {
      text: { text: 'Send a message to the team chat space' },
      languageCode: 'en',
    },
  };
  try {
    const response = await dfPost(
      token,
      `/agents/${agentId}/sessions/${sessionId}:detectIntent`,
      detectBody,
    ) as { queryResult?: { responseMessages?: Array<{ text?: { text?: string[] } }> } };

    const replies = response.queryResult?.responseMessages
      ?.flatMap(m => m.text?.text ?? []) ?? [];
    console.log(` ✓ Agent reply: ${replies.join(' ') || '(no text response — check Dialogflow console)'}`);
  } catch (e) {
    console.log(` ✗ detectIntent failed: ${(e as Error).message}`);
    console.log('   → This is OK for first run — agent needs to be set as the default start page.');
  }

  console.log('\n=== Summary ===');
  console.log(`Agent ID : ${agentId}`);
  console.log(`Tool ID  : ${toolId}`);
  console.log(`Proxy URL: ${SERVER_BASE}/api/workflows/trigger/${WORKFLOW_PROJECT}/${WORKFLOW_REGION}/${WORKFLOW_NAME}`);
  console.log('\nNext: open Dialogflow CX console and test via Simulator with the agent above.');
  console.log(`Console: https://dialogflow.cloud.google.com/cx/projects/${DF_PROJECT}/locations/${DF_LOCATION}/agents/${agentId}`);
}

main().catch(console.error);
export {};
