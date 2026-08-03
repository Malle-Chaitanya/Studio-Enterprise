/** SPIKE: programmatically create a Dialogflow CX agent + generative Playbook via
 *  the REST API, with a migrated instruction. Then the human verifies in the
 *  console whether an API-created playbook is EDITABLE (the make-or-break test
 *  vs Discovery Engine's Preview/Delete lock).
 *   npx tsx src/_diag_dialogflow_spike.ts <project> [location] */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, LOCATION = 'global'] = process.argv.slice(2);
// Global uses the base host; regional uses {region}-dialogflow...
const HOST = LOCATION === 'global' ? 'https://dialogflow.googleapis.com' : `https://${LOCATION}-dialogflow.googleapis.com`;

const INSTRUCTION =
  'You are an HR assistant for Acme Corp. Answer questions about the leave policy: ' +
  'employees get 20 paid leave days per year, and must apply 3 days in advance. ' +
  'If unsure, tell them to email hr@acme.com.';

async function main() {
  if (!PROJECT) throw new Error('usage: _diag_dialogflow_spike.ts <project> [location]');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── 1. Create the CX agent ────────────────────────────────────────────────
  const agentsUrl = `${HOST}/v3/projects/${PROJECT}/locations/${LOCATION}/agents`;
  const agentBody = { displayName: 'CF-Spike-CX-Agent', defaultLanguageCode: 'en', timeZone: 'America/Los_Angeles' };
  const aRes = await fetch(agentsUrl, { method: 'POST', headers: h, body: JSON.stringify(agentBody) });
  const aText = await aRes.text();
  console.log(`1) create agent -> ${aRes.status}`);
  if (!aRes.ok) { console.log(aText.replace(/\s+/g, ' ').slice(0, 500)); process.exit(1); }
  const agent = JSON.parse(aText) as { name: string };
  const agentId = agent.name.split('/').pop();
  console.log(`   agent: ${agent.name}`);

  // ── 2. Create a generative Playbook with goal + instruction ───────────────
  const pbUrl = `${HOST}/v3/${agent.name}/playbooks`;
  // Try the documented shape first: instruction.steps[].text
  const pbBody = {
    displayName: 'Migrated HR Playbook',
    goal: 'Help employees with HR leave policy questions.',
    instruction: { steps: [{ text: INSTRUCTION }] },
  };
  let pRes = await fetch(pbUrl, { method: 'POST', headers: h, body: JSON.stringify(pbBody) });
  let pText = await pRes.text();
  if (!pRes.ok) {
    // Fallback: some API versions use instruction.guidelines (a string).
    console.log(`2a) playbook (steps) -> ${pRes.status}: ${pText.replace(/\s+/g, ' ').slice(0, 200)}`);
    const alt = { displayName: 'Migrated HR Playbook', goal: 'Help employees with HR leave policy questions.', instruction: { guidelines: INSTRUCTION } };
    pRes = await fetch(pbUrl, { method: 'POST', headers: h, body: JSON.stringify(alt) });
    pText = await pRes.text();
    console.log(`2b) playbook (guidelines) -> ${pRes.status}`);
  } else {
    console.log(`2) create playbook (steps) -> ${pRes.status}`);
  }
  if (pRes.ok) {
    const pb = JSON.parse(pText) as { name: string };
    console.log(`   playbook: ${pb.name}`);
  } else {
    console.log(`   playbook create failed: ${pText.replace(/\s+/g, ' ').slice(0, 400)}`);
  }

  // ── 3. Hand off to the human for the editability check ────────────────────
  console.log('\n======================================================');
  console.log('SPIKE DONE — NOW THE MAKE-OR-BREAK CHECK (in the browser):');
  console.log('======================================================');
  console.log(`Open: https://conversational-agents.cloud.google.com/projects/${PROJECT}/locations/${LOCATION}/agents/${agentId}`);
  console.log('1. Switch the Agent dropdown to "CF-Spike-CX-Agent".');
  console.log('2. Open Playbooks -> "Migrated HR Playbook".');
  console.log('3. VERIFY: can you EDIT the Goal/Instructions and SAVE? (not locked to view-only)');
  console.log('4. Open the Test panel and ask "how many leave days?" -> expect "20".');
  console.log(`\n(cleanup later: DELETE ${HOST}/v3/${agent.name})`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
