/** Does verification now FAIL on an agent that cannot reach its knowledge sources?
 *  Agent 1182486822521929728 is the migrated agent whose stores live in another project
 *  and whose every retrieval 403s — it previously reported verified=true.
 *  npx tsx src/spikes/_test_verify_honesty.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { verifyAgent } from '../services/verify.js';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const dest = { project: PROJECT, engine: ENGINE, assistant: 'default_assistant' };

for (const [label, agentId, reId] of [
  ['broken grounding (403 on retrieval)', '8277338168224151082', '1182486822521929728'],
  ['working agent (cited + live)', '13332936524828407630', '2859796208740728832'],
] as const) {
  const v = await verifyAgent(dest, access_token!, agentId, undefined, { reasoningEngineId: reId, expectsGrounding: true });
  console.log(`\n${label}`);
  console.log(`  verified : ${v.verified}`);
  console.log(`  note     : ${v.note ?? '-'}`);
  console.log(`  sample   : ${(v.sample ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
}
process.exit(0);
