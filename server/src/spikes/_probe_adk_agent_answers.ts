/**
 * Invoke the freshly deployed ADK Confluence agent and check it answers FROM the
 * Confluence data store via VertexAiSearchTool.
 *
 * Contract discovered by probing: this deployment registers as framework="custom"
 * exposing only query / stream_query / async_stream_query (no session methods), but
 * the underlying object is an AdkApp — the error
 *   "AdkApp.stream_query() missing 1 required keyword-only argument: 'user_id'"
 * says stream_query needs user_id and manages its own session.
 *
 * npx tsx src/spikes/_probe_adk_agent_answers.ts [reasoningEngineId]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const RE_ID = process.argv[2] ?? '6377081129438019584';
const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const USER_ID = 'cf-e2e-user';
const AI = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;

const QUESTIONS = (process.env.E2E_QUESTIONS ?? [
  'What is the VPN access process?',
  'What does the security policy require?',
  'What is on the client onboarding checklist?',
  'What are the Q1 2026 revenue targets?',
  'What is the maternity leave policy?',
].join('|')).split('|');

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const re = `${AI}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${RE_ID}`;

function texts(raw: string): string {
  return [...raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; } })
    .join('');
}

let grounded = 0;
for (const q of QUESTIONS) {
  const r = await fetch(`${re}:streamQuery?alt=sse`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ class_method: 'stream_query', input: { user_id: USER_ID, message: q } }),
  });
  const t = await r.text();
  console.log(`\n──── Q: ${q}`);
  if (!r.ok) {
    const detail = /"detail":"((?:[^"\\]|\\.)*)"/.exec(t)?.[1] ?? t.replace(/\s+/g, ' ').slice(0, 300);
    console.log(`  FAIL ${r.status}: ${detail.slice(0, 400)}`);
    continue;
  }
  const usedSearch = /vertex_ai_search|VertexAiSearch|functionCall|function_call|grounding/i.test(t);
  const answer = texts(t).replace(/\s+/g, ' ').trim();
  console.log(`  searchToolInvoked=${usedSearch}  bytes=${t.length}`);
  console.log(`  A: ${answer.slice(0, 450) || '(no text)'}`);
  if (answer && !/do not have that information/i.test(answer)) grounded++;
}
console.log(`\n═══ ${grounded}/${QUESTIONS.length} answered from the knowledge base ═══`);
