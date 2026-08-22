/**
 * Delete the currently-broken "Migrate Advisor" ADK deployment (agent + Reasoning
 * Engine) so the next migration run creates a fresh one instead of hitting the
 * "already exists — skipped" dedup path. Also clears the adkDeployments Mongo
 * record so getAdkDeployment() returns null and the next run takes the create path.
 *
 * Dry run by default; pass --apply to actually delete. Identity (displayName) is
 * verified before deletion so a stale id can never delete a different agent.
 *
 * npx tsx src/spikes/_del_migrate_advisor_broken.ts [--apply]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { connectDb, getDb } from '../db/core.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const LOCATION = 'us-central1';
const DE = 'https://discoveryengine.googleapis.com/v1alpha';
const AI = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;

const AGENT_ID = '16275653330643195977';
const REASONING_ENGINE_ID = '6940215800812797952';
const EXPECT_NAME = 'Migrate Advisor';

// The Mongo keys recorded for this deployment (confirmed via _diag_lookup_migrate_advisor.ts).
const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SOURCE_ID = 'bdf9b817-9b90-f111-b8da-0022480b1f83';

async function main() {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
  const agentBase = `${DE}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — project=${PROJECT}\n`);

  const g = await fetch(`${agentBase}/${AGENT_ID}`, { headers: h });
  const gj = (await g.json().catch(() => ({}))) as { displayName?: string; state?: string; adkAgentDefinition?: { provisionedReasoningEngine?: { reasoningEngine?: string } } };
  const actual = gj.displayName ?? '(not found)';
  const match = actual === EXPECT_NAME;
  const liveReasoningEngine = gj.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine?.split('/').pop();

  console.log(`agent ${AGENT_ID}`);
  console.log(`  name             : ${actual}${match ? '' : `   ⚠ EXPECTED "${EXPECT_NAME}"`}`);
  console.log(`  state            : ${gj.state}`);
  console.log(`  live reasoningEngine: ${liveReasoningEngine}${liveReasoningEngine === REASONING_ENGINE_ID ? '' : `   ⚠ EXPECTED ${REASONING_ENGINE_ID}`}`);

  if (g.status === 404) { console.log('  agent already gone\n'); }
  else if (!match) { console.log('  REFUSING to delete — name mismatch\n'); return; }
  else if (liveReasoningEngine !== REASONING_ENGINE_ID) { console.log('  REFUSING to delete — reasoningEngine mismatch\n'); return; }

  if (!APPLY) {
    console.log(`  would delete agent + reasoningEngine ${REASONING_ENGINE_ID}`);
    console.log('  would clear adkDeployments record for this sourceId');
    return;
  }

  if (g.status !== 404) {
    const da = await fetch(`${agentBase}/${AGENT_ID}`, { method: 'DELETE', headers: h });
    console.log(`  delete agent           -> ${da.status}${da.ok ? '' : ' ' + (await da.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  const dr = await fetch(`${AI}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${REASONING_ENGINE_ID}?force=true`, {
    method: 'DELETE', headers: h,
  });
  console.log(`  delete reasoningEngine -> ${dr.status}${dr.ok ? '' : ' ' + (await dr.text()).replace(/\s+/g, ' ').slice(0, 200)}`);

  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const delRes = await db.collection('adkDeployments').deleteOne({ appUserId: APP_USER_ID, envUrl: ENV_URL, sourceId: SOURCE_ID, project: PROJECT, engine: ENGINE });
  console.log(`  cleared adkDeployments record -> deletedCount=${delRes.deletedCount}`);

  const snapDel = await db.collection('migratedAgentSnapshots').deleteOne({ appUserId: APP_USER_ID, envUrl: ENV_URL, sourceId: SOURCE_ID, project: PROJECT, engine: ENGINE }).catch(() => null);
  if (snapDel) console.log(`  cleared migratedAgentSnapshots record -> deletedCount=${snapDel.deletedCount}`);

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
