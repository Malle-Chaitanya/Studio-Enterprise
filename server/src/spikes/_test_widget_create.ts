/**
 * Test: can SA+DWD token call widgetCreateAgent on biz-discoveryengine.googleapis.com?
 * This is the key question — if yes, we can create ENABLED agents without browser.
 *
 * Usage: cd server && npx tsx src/spikes/_test_widget_create.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const GEMINI_ADMIN = 'mia@cloudfuze.com';
const CONFIG_ID    = 'db57ac46-13a5-49e8-8b4f-34bb8ec43057';
const BASE_URL     = 'https://biz-discoveryengine.googleapis.com/v1alpha/locations/global';
const DISPLAY_NAME = 'Widget Test Agent (delete me)';

const saToken = await getSaToken(GEMINI_ADMIN);
console.log(`SA token acquired (${saToken.slice(0,20)}...)`);

const headers = {
  'Authorization': `Bearer ${saToken}`,
  'Content-Type': 'application/json',
  'x-server-token': 'CAMSAh0H',
  'origin': 'https://business.gemini.google',
  'referer': 'https://business.gemini.google/',
};

// ── Test 1: widgetListAvailableAgentViews ─────────────────────────────────────
console.log('\n=== Test 1: widgetListAvailableAgentViews ===');
const listRes = await fetch(`${BASE_URL}/widgetListAvailableAgentViews`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    configId: CONFIG_ID,
    additionalParams: { token: '-', origin: 'ORIGIN_UNSPECIFIED' },
    listAvailableAgentViewsRequest: { pageSize: 5, agentOrigin: 'USER' },
  }),
});
console.log(`Status: ${listRes.status}`);
const listJson = await listRes.json() as Record<string, unknown>;
if (listRes.ok) {
  const views = (listJson.listAvailableAgentViewsResponse as Record<string, unknown>)?.agentViews as unknown[] | undefined;
  console.log(`OK — agentViews count: ${views?.length ?? 0}`);
} else {
  const err = listJson.error as Record<string, unknown> | undefined;
  console.log(`Error: ${err?.code} — ${err?.message}`);
  const details = err?.details as Array<Record<string, unknown>> | undefined;
  const reason = details?.[0]?.reason;
  console.log(`Reason: ${reason}`);
}

// ── Test 2: widgetCreateAgent ─────────────────────────────────────────────────
console.log('\n=== Test 2: widgetCreateAgent ===');
const createBody = {
  configId: CONFIG_ID,
  additionalParams: { token: '-', origin: 'LOW_CODE_AGENT' },
  createAgentRequest: {
    agent: {
      name: DISPLAY_NAME,
      displayName: DISPLAY_NAME,
      description: 'Test agent — will be deleted',
      starterPrompts: [{ text: 'Hello' }],
      icon: {},
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [{
          id: 'root_agent',
          displayName: DISPLAY_NAME,
          llmAgentNode: {
            description: 'Test',
            model: 'gemini-2.5-flash',
            instruction: 'You are a test assistant.',
            subAgentIds: [],
            selectedTools: { tool: [{ name: 'googleSearch' }] },
          },
        }],
        draftDisplayName: DISPLAY_NAME,
        draftDescription: 'Test agent — will be deleted',
        draftStarterPrompts: [{ text: 'Hello' }],
        draftIcon: { content: '' },
        deployedNodes: [],
        agentFiles: [],
        draftSchedules: [],
        deployedSchedules: [],
      },
    },
  },
};

const createRes = await fetch(`${BASE_URL}/widgetCreateAgent`, {
  method: 'POST',
  headers,
  body: JSON.stringify(createBody),
});
console.log(`Status: ${createRes.status}`);
const createJson = await createRes.json() as Record<string, unknown>;
if (createRes.ok) {
  const agent = createJson.agent as Record<string, unknown> | undefined;
  const agentId = (agent?.name as string | undefined)?.split('/').pop();
  console.log(`SUCCESS — agent created!`);
  console.log(`  id:    ${agentId}`);
  console.log(`  state: ${agent?.state}`);
  console.log(`\nNext: try widgetDeployLowCodeAgent to ENABLE it.`);
  console.log(`Delete this test agent after confirming.`);
} else {
  const err = createJson.error as Record<string, unknown> | undefined;
  console.log(`Error: ${err?.code} — ${err?.message}`);
  const details = err?.details as Array<Record<string, unknown>> | undefined;
  const reason = details?.[0]?.reason;
  console.log(`Reason: ${reason}`);
  if (reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED') {
    console.log('\nCONCLUSION: SA+DWD token rejected by widget API — same as user OAuth.');
    console.log('Widget API only accepts business.gemini.google browser session tokens.');
    console.log('Need different approach.');
  }
}
