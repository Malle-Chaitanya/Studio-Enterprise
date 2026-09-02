/**
 * Why does the assist probe answer 400 for the low-code fallback agent?
 * verify.ts records only the STATUS, so the reason has never been seen.
 * Migrate Advisor, run M94r0za3xXtkJuC3Xvn7KVd1LQc (2026-08-23).
 */
import { getSaToken } from '../auth/google.js';

const PROJECT = '505103737920';
const ENGINE = 'gemini-enterprise-app_1787446545912';
const AGENTS: Record<string, string> = {
  'Migrate Advisor (low-code fallback, verified=false)': '4839019307637799308',
  'WorkMate (ADK, verified=true)': '13300623640757970256',
  'Nexus Agent (ADK, verified=true)': '2261370940660059563',
};

const token = await getSaToken('admin@migrationn.com');

for (const assistant of ['default_assistant']) {
  const base =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}` +
    `/locations/global/collections/default_collection/engines/${ENGINE}/assistants/${assistant}`;

  for (const [label, agentId] of Object.entries(AGENTS)) {
    const res = await fetch(`${base}:assist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { text: 'What can you help me with?' }, agentId }),
    });
    const body = await res.text();
    console.log(`\n### ${label}\n    HTTP ${res.status}`);
    console.log('    ' + body.replace(/\s+/g, ' ').slice(0, 400));
  }
}
