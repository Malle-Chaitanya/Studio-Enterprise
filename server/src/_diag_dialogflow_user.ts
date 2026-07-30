/** SPIKE (user-identity variant): prove whether a HUMAN/OAuth identity (e.g. zara)
 *  can create a Dialogflow CX agent via the API — the SAME identity that already
 *  creates CX agents in the console. Our service account is blocked (403 despite
 *  IAM=HAS) by org governance/VPC-SC; this tests whether "act as a user" bypasses it.
 *
 *  It grabs the token from the ACTIVE gcloud user account (no copy-paste). Run
 *  `gcloud auth login` as zara first, then:
 *    npx tsx src/_diag_dialogflow_user.ts <project> [location] [account-email]
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const [PROJECT, LOCATION = 'global', ACCOUNT] = process.argv.slice(2);
const HOST = LOCATION === 'global' ? 'https://dialogflow.googleapis.com' : `https://${LOCATION}-dialogflow.googleapis.com`;

const INSTRUCTION =
  'You are an HR assistant for Acme Corp. Answer questions about the leave policy: ' +
  'employees get 20 paid leave days per year, and must apply 3 days in advance. ' +
  'If unsure, tell them to email hr@acme.com.';

async function userToken(): Promise<{ token: string; account: string }> {
  // Preferred (no install): paste a user token via env, e.g. from the OAuth Playground.
  const pasted = (process.env.USER_ACCESS_TOKEN || '').trim();
  if (pasted) {
    // Ask Google whose token this is + its scopes — PROVES it's a user, not the SA.
    const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(pasted)}`)
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .catch(() => ({} as Record<string, unknown>));
    return { token: pasted, account: String(info.email ?? info.azp ?? '(unknown — tokeninfo failed)') };
  }
  // Fallback: active gcloud user account (only if gcloud is installed).
  const acctArgs = ACCOUNT ? ['--account', ACCOUNT] : [];
  const who = await pexec('gcloud', ['config', 'get-value', 'account', ...acctArgs].filter(Boolean), { shell: true }).catch(() => ({ stdout: '' }));
  const active = (who.stdout || '').trim();
  const { stdout } = await pexec('gcloud', ['auth', 'print-access-token', ...acctArgs], { shell: true });
  return { token: stdout.trim(), account: ACCOUNT || active || '(active gcloud account)' };
}

async function main() {
  if (!PROJECT) throw new Error('usage: _diag_dialogflow_user.ts <project> [location] [account-email]');

  const { token, account } = await userToken();
  console.log(`Using USER identity: ${account}`);
  if (account.includes('gserviceaccount.com')) {
    console.log('⚠️  This is a SERVICE ACCOUNT, not a user. Run `gcloud auth login` as zara first, or pass her email as the 3rd arg.');
  }
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── The ONE thing we are testing: can THIS identity create a CX agent? ──────
  const agentsUrl = `${HOST}/v3/projects/${PROJECT}/locations/${LOCATION}/agents`;
  const agentBody = { displayName: 'CF-Spike-UserAuth', defaultLanguageCode: 'en', timeZone: 'America/Los_Angeles' };
  const aRes = await fetch(agentsUrl, { method: 'POST', headers: h, body: JSON.stringify(agentBody) });
  const aText = await aRes.text();
  console.log(`\n1) create agent (as user) -> ${aRes.status}`);
  if (!aRes.ok) {
    console.log('❌ USER-AUTH ALSO BLOCKED:', aText.replace(/\s+/g, ' ').slice(0, 500));
    console.log('\nVERDICT: the API path is walled for this identity too — Dialogflow-via-API is not viable here.');
    process.exit(1);
  }
  const agent = JSON.parse(aText) as { name: string };
  const agentId = agent.name.split('/').pop();
  console.log(`✅ CREATED as user: ${agent.name}`);

  // ── Playbook with the migrated instruction ─────────────────────────────────
  const pbUrl = `${HOST}/v3/${agent.name}/playbooks`;
  const pbBody = { displayName: 'Migrated HR Playbook', goal: 'Help employees with HR leave policy questions.', instruction: { steps: [{ text: INSTRUCTION }] } };
  let pRes = await fetch(pbUrl, { method: 'POST', headers: h, body: JSON.stringify(pbBody) });
  let pText = await pRes.text();
  if (!pRes.ok) {
    const alt = { displayName: 'Migrated HR Playbook', goal: 'Help employees with HR leave policy questions.', instruction: { guidelines: INSTRUCTION } };
    pRes = await fetch(pbUrl, { method: 'POST', headers: h, body: JSON.stringify(alt) });
    pText = await pRes.text();
    console.log(`2) create playbook (guidelines) -> ${pRes.status}`);
  } else {
    console.log(`2) create playbook (steps) -> ${pRes.status}`);
  }
  if (pRes.ok) console.log(`   playbook: ${(JSON.parse(pText) as { name: string }).name}`);
  else console.log(`   ⚠️ playbook create failed (agent still created): ${pText.replace(/\s+/g, ' ').slice(0, 300)}`);

  console.log('\n======================================================');
  console.log('✅ USER-AUTH WORKS — the domino falls. Now the make-or-break check:');
  console.log('======================================================');
  console.log(`Open: https://conversational-agents.cloud.google.com/projects/${PROJECT}/locations/${LOCATION}/agents/${agentId}`);
  console.log('1. Switch Agent dropdown -> "CF-Spike-UserAuth".');
  console.log('2. Playbooks -> "Migrated HR Playbook": can you EDIT + SAVE the Goal/Instructions?');
  console.log('3. Test panel: ask "how many leave days?" -> expect "20".');
  console.log(`\n(cleanup later: DELETE ${HOST}/v3/${agent.name})`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
