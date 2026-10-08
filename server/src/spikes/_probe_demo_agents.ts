/**
 * Drive a deployed agent through a scripted list of questions and report what the RUNTIME
 * did, not what the prose claimed.
 *
 * WHY the distinction matters for a demo: an agent whose tool failed still answers
 * plausibly. "I've updated the credit limit" reads identically whether a tool ran or the
 * model invented it. Demo questions have to be chosen on toolCalled/toolSucceeded, not on
 * how convincing the sentence looks.
 *
 * Run: cd server && AGENT="Deal Desk" npx tsx src/spikes/_probe_demo_agents.ts
 */
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';

const PROJECT = process.env.GEMINI_PROJECT || 'agentmigrations';
const LOCATION = 'us-central1';
const NAME = process.env.AGENT || 'Deal Desk';
const CALLER = process.env.CALLER || 'admin@migrationn.com';
const QUESTIONS = (process.env.QS || [
  'What can you help me with?',
  'What is the credit limit for Contoso?',
  'Update the credit limit for Contoso to 50000.',
].join('|')).split('|');

const token = await getSaToken();
const r = await fetch(
  `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines`,
  { headers: { Authorization: `Bearer ${token}` } });
const engines = ((await r.json()) as { reasoningEngines?: Array<{ name: string; displayName?: string; createTime?: string }> }).reasoningEngines ?? [];
const mine = engines.filter((e) => (e.displayName ?? '').toLowerCase() === NAME.toLowerCase())
  .sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
if (!mine.length) {
  console.log(`no engine named "${NAME}". Available:`);
  for (const e of engines) console.log('   ' + (e.displayName ?? '?'));
  process.exit(1);
}
const id = mine[0].name.split('/').pop()!;
console.log(`agent "${NAME}"  engine=${id}  as ${CALLER}\n`);

for (const q of QUESTIONS) {
  const res = await chatWithAdkAgent(PROJECT, token, {
    reasoningEngineId: id, message: q, userId: CALLER, location: LOCATION,
  });
  console.log(`Q: ${q}`);
  if (!res.ok) { console.log(`   ERROR: ${res.error}\n`); continue; }
  console.log(`   tools=${(res.toolNames ?? []).join(',') || 'NONE'}  called=${res.toolCalled}  ok=${res.toolSucceeded}`);
  if (res.toolError) console.log(`   toolError: ${res.toolError.slice(0, 200)}`);
  console.log(`   A: ${String(res.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}\n`);
}
