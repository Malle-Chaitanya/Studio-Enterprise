/**
 * Test widget API reachability with SA+DWD token, with/without x-server-token.
 * Also try widgetDeployLowCodeAgent on the existing PRIVATE agent.
 *
 * Usage: cd server && npx tsx src/spikes/_test_widget_token.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const GEMINI_ADMIN = 'mia@cloudfuze.com';
const CONFIG_ID    = 'db57ac46-13a5-49e8-8b4f-34bb8ec43057';
const AGENT_ID     = '8980160511526117673';
const BASE_URL     = 'https://biz-discoveryengine.googleapis.com/v1alpha/locations/global';

const saToken = await getSaToken(GEMINI_ADMIN);
console.log(`SA token: ${saToken.slice(0,20)}...`);

const listBody = JSON.stringify({
  configId: CONFIG_ID,
  additionalParams: { token: '-', origin: 'ORIGIN_UNSPECIFIED' },
  listAvailableAgentViewsRequest: { pageSize: 3, agentOrigin: 'USER' },
});

// ── Test A: no x-server-token ─────────────────────────────────────────────────
console.log('\n=== Test A: widgetListAvailableAgentViews (NO x-server-token) ===');
const rA = await fetch(`${BASE_URL}/widgetListAvailableAgentViews`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${saToken}`,
    'Content-Type': 'application/json',
    'origin': 'https://business.gemini.google',
    'referer': 'https://business.gemini.google/',
  },
  body: listBody,
});
const jA = await rA.json() as Record<string, unknown>;
console.log(`Status: ${rA.status}`);
const errA = jA.error as Record<string, unknown> | undefined;
if (errA) {
  console.log(`Error: ${errA.code} — ${errA.message}`);
  const details = errA.details as Array<Record<string, unknown>> | undefined;
  console.log(`Reason: ${details?.[0]?.reason ?? 'none'}`);
} else {
  console.log(`Response keys: ${Object.keys(jA).join(', ')}`);
}

// ── Test B: with x-server-token ───────────────────────────────────────────────
console.log('\n=== Test B: widgetListAvailableAgentViews (WITH x-server-token) ===');
const rB = await fetch(`${BASE_URL}/widgetListAvailableAgentViews`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${saToken}`,
    'Content-Type': 'application/json',
    'x-server-token': 'CAMSAh0H',
    'origin': 'https://business.gemini.google',
    'referer': 'https://business.gemini.google/',
  },
  body: listBody,
});
const jB = await rB.json() as Record<string, unknown>;
console.log(`Status: ${rB.status}`);
const errB = jB.error as Record<string, unknown> | undefined;
if (errB) {
  console.log(`Error: ${errB.code} — ${errB.message}`);
  const details = errB.details as Array<Record<string, unknown>> | undefined;
  console.log(`Reason: ${details?.[0]?.reason ?? 'none'}`);
} else {
  console.log(`Response keys: ${Object.keys(jB).join(', ')}`);
}

// ── Test C: widgetDeployLowCodeAgent on existing PRIVATE agent ─────────────────
console.log('\n=== Test C: widgetDeployLowCodeAgent (WITH x-server-token) ===');
const rC = await fetch(`${BASE_URL}/widgetDeployLowCodeAgent`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${saToken}`,
    'Content-Type': 'application/json',
    'x-server-token': 'CAMSAh0H',
    'origin': 'https://business.gemini.google',
    'referer': 'https://business.gemini.google/',
  },
  body: JSON.stringify({
    configId: CONFIG_ID,
    additionalParams: { token: '-', origin: 'LOW_CODE_AGENT' },
    deployLowCodeAgentRequest: { name: AGENT_ID, deployMode: 'DEPLOY' },
    location: 'global',
  }),
});
const jC = await rC.json() as Record<string, unknown>;
console.log(`Status: ${rC.status}`);
const errC = jC.error as Record<string, unknown> | undefined;
if (errC) {
  console.log(`Error: ${errC.code} — ${errC.message}`);
  const details = errC.details as Array<Record<string, unknown>> | undefined;
  console.log(`Reason: ${details?.[0]?.reason ?? 'none'}`);
} else {
  console.log(`SUCCESS!`);
  console.log(`Response: ${JSON.stringify(jC).slice(0, 300)}`);
}

// ── Test D: widgetDeployLowCodeAgent WITHOUT x-server-token ───────────────────
console.log('\n=== Test D: widgetDeployLowCodeAgent (NO x-server-token) ===');
const rD = await fetch(`${BASE_URL}/widgetDeployLowCodeAgent`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${saToken}`,
    'Content-Type': 'application/json',
    'origin': 'https://business.gemini.google',
    'referer': 'https://business.gemini.google/',
  },
  body: JSON.stringify({
    configId: CONFIG_ID,
    additionalParams: { token: '-', origin: 'LOW_CODE_AGENT' },
    deployLowCodeAgentRequest: { name: AGENT_ID, deployMode: 'DEPLOY' },
    location: 'global',
  }),
});
const jD = await rD.json() as Record<string, unknown>;
console.log(`Status: ${rD.status}`);
const errD = jD.error as Record<string, unknown> | undefined;
if (errD) {
  console.log(`Error: ${errD.code} — ${errD.message}`);
  const details = errD.details as Array<Record<string, unknown>> | undefined;
  console.log(`Reason: ${details?.[0]?.reason ?? 'none'}`);
} else {
  console.log(`SUCCESS!`);
  console.log(`Response: ${JSON.stringify(jD).slice(0, 300)}`);
}
