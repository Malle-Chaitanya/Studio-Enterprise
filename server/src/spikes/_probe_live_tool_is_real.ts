/**
 * Prove the live connector tool makes a REAL authenticated HTTP call using a
 * credential read from Secret Manager AT CALL TIME — not a hallucinated answer and
 * not a value baked into the deployment.
 *
 * Method (falsification, not confirmation): break the secret, ask again, restore.
 *   1. baseline  — ask a live-only question, expect a real answer
 *   2. sabotage  — write a GARBAGE api_token as a new Secret Manager version
 *   3. re-ask    — a genuine authenticated call must now fail (401 from Confluence)
 *   4. restore   — put the real token back, ask once more, expect success again
 *
 * Reasoning: if the answer survived step 3, the tool was NOT using that secret —
 * either the credential was captured at deploy time or the model was answering from
 * training data. Only a per-call Secret Manager read can flip to failure and back.
 *
 * The indexed question is asked at every stage as a control: it must keep working
 * throughout, since it never touches the connector.
 *
 * npx tsx src/spikes/_probe_live_tool_is_real.ts [reasoningEngineId]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';

const RE_ID = process.argv[2] ?? '2859796208740728832';
const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const USER_ID = 'cf-proof-user';

const LIVE_Q = 'How many days of earned leave do I get?'; // HR space — NOT indexed
const INDEXED_Q = 'What is the VPN access process?'; // ITINFRA — indexed, control

const REAL_TOKEN = process.env.CONFLUENCE_TOKEN ?? '';
if (!REAL_TOKEN) { console.error('CONFLUENCE_TOKEN missing from server/.env'); process.exit(1); }
const SECRET_ID = connectorSecretId('confluence', 'api_token');

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

const token = await saToken();

async function ask(q: string, label: string): Promise<string> {
  // Fresh session each time so a cached conversational answer can't masquerade as a
  // live tool call.
  const sessionId = (await createAdkSession(PROJECT, token, RE_ID, `${USER_ID}-${label}`, LOCATION)) ?? undefined;
  const r = await chatWithAdkAgent(PROJECT, token, {
    reasoningEngineId: RE_ID, message: q, userId: `${USER_ID}-${label}`, sessionId, location: LOCATION,
  });
  return r.ok ? (r.answer ?? '(empty)') : `ERROR ${r.error}`;
}

function verdict(answer: string): string {
  const live = /\[LIVE\]/i.test(answer);
  const refused = /do not have that information/i.test(answer);
  const failed = /error|fail|401|unauthor|permission/i.test(answer);
  return `live=${live ? 'YES' : 'no'} refused=${refused ? 'YES' : 'no'} errorish=${failed ? 'YES' : 'no'}`;
}

try {
  console.log(`═══ 1. BASELINE (real token in Secret Manager) ═══`);
  const base = await ask(LIVE_Q, 'base');
  console.log(`  live Q  : ${verdict(base)}`);
  console.log(`  ${base.replace(/\s+/g, ' ').slice(0, 320)}`);
  const baseCtl = await ask(INDEXED_Q, 'basectl');
  console.log(`  control : ${verdict(baseCtl)}  ${baseCtl.replace(/\s+/g, ' ').slice(0, 120)}`);

  console.log(`\n═══ 2. SABOTAGE — write garbage api_token to ${SECRET_ID} ═══`);
  await upsertSecret(token, PROJECT, SECRET_ID, 'THIS-IS-NOT-A-VALID-TOKEN-deadbeef');
  console.log('  new secret version written (garbage)');
  // No redeploy, no restart — the tool is supposed to read the secret per call.
  await new Promise((r) => setTimeout(r, 5_000));

  console.log(`\n═══ 3. RE-ASK with the broken credential ═══`);
  const broken = await ask(LIVE_Q, 'broken');
  console.log(`  live Q  : ${verdict(broken)}`);
  console.log(`  ${broken.replace(/\s+/g, ' ').slice(0, 400)}`);
  const brokenCtl = await ask(INDEXED_Q, 'brokenctl');
  console.log(`  control : ${verdict(brokenCtl)}  ${brokenCtl.replace(/\s+/g, ' ').slice(0, 120)}`);

  console.log(`\n═══ 4. RESTORE the real token ═══`);
  await upsertSecret(token, PROJECT, SECRET_ID, REAL_TOKEN);
  console.log('  real token restored as latest version');
  await new Promise((r) => setTimeout(r, 5_000));
  const restored = await ask(LIVE_Q, 'restored');
  console.log(`  live Q  : ${verdict(restored)}`);
  console.log(`  ${restored.replace(/\s+/g, ' ').slice(0, 320)}`);

  console.log(`\n════ VERDICT ════`);
  const baseOk = /\[LIVE\]/i.test(base);
  const brokeFailed = !/\[LIVE\]/i.test(broken);
  const restoredOk = /\[LIVE\]/i.test(restored);
  if (baseOk && brokeFailed && restoredOk) {
    console.log('  PROVEN: the tool reads the Secret Manager value on every call and makes a real');
    console.log('  authenticated HTTP request to Confluence. Breaking the secret broke the answer;');
    console.log('  restoring it fixed the answer, with no redeploy in between.');
  } else {
    console.log(`  NOT PROVEN — baseline=${baseOk} brokeFailed=${brokeFailed} restored=${restoredOk}`);
    console.log('  If the broken stage still answered, the credential is not being read per call.');
  }
} finally {
  // Never leave the customer's secret sabotaged, even if a step above threw.
  await upsertSecret(token, PROJECT, SECRET_ID, REAL_TOKEN);
  console.log('\n(cleanup) real token confirmed as the latest secret version');
}
