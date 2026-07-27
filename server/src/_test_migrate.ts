/**
 * End-to-end migration test harness (run manually, not part of the app).
 *
 *   npx tsx src/_test_migrate.ts <sessionId>          # dry run only (no writes)
 *   npx tsx src/_test_migrate.ts <sessionId> --live   # + create ONE real agent
 *
 * Proves the full pipeline against the REAL Copilot Studio + Gemini APIs:
 *   extract → map   (dry run)
 *   → create → publish → share → verify   (--live)
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { clientCredsToken } from './auth/microsoft.js';
import { getSaToken } from './auth/google.js';
import { extractAgent, listBots } from './services/dataverse.js';
import { mapAgent } from './services/mapper.js';
import { createAgent, defaultDestination, publishAgent, shareAgent, engineReachable } from './services/gemini.js';
import { verifyAgent } from './services/verify.js';

const SESSION_ID = process.argv[2];
const LIVE = process.argv.includes('--live');

function line(s = '─') { console.log(s.repeat(70)); }

async function main() {
  if (!SESSION_ID) throw new Error('usage: tsx src/_test_migrate.ts <sessionId> [--live]');
  await connectMongo();
  // Read the raw session doc directly (bypass the 1h TTL check — this is a test).
  const s = (await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })) as Session | null;
  if (!s) throw new Error(`session ${SESSION_ID} not found`);

  line('=');
  console.log(`SESSION      ${SESSION_ID}`);
  console.log(`Tenant       ${s.orgName} (${s.tenantId})`);
  console.log(`Google       ${s.gEmail}  project=${s.geminiProject}  saOk=${s.saOk}`);
  console.log(`Environments ${s.environments?.length ?? 0}`);
  console.log(`Mode         ${LIVE ? 'LIVE (will create 1 real agent)' : 'DRY RUN (no writes)'}`);
  line('=');

  // 1) Find the first accessible environment that has agents.
  let envUrl = '';
  let envName = '';
  let bots: { botid: string; name: string }[] = [];
  for (const env of s.environments ?? []) {
    try {
      const t = await clientCredsToken(s.tenantId ?? '', env.url);
      const list = await listBots(env.url, t);
      if (list.length) { envUrl = env.url; envName = env.name; bots = list; break; }
    } catch (e) {
      console.log(`  · ${env.name}: probe failed (${(e as Error).message})`);
    }
  }
  if (!bots.length) throw new Error('no agents found in any accessible environment');
  console.log(`\nEnvironment: ${envName}  →  ${bots.length} agent(s)`);
  console.log(`First 5: ${bots.slice(0, 5).map((b) => b.name).join(', ')}\n`);

  const dvToken = await clientCredsToken(s.tenantId ?? '', envUrl);

  // 2) DRY RUN — extract + map up to 3 agents (proves the transform).
  line();
  console.log('DRY RUN — extract + map (no writes)');
  line();
  const sample = bots.slice(0, 3);
  for (const bot of sample) {
    const ir = await extractAgent(envUrl, dvToken, bot);
    const mapped = await mapAgent(ir);
    console.log(`✓ ${bot.name}`);
    console.log(`    instructions: ${ir.instructions ? ir.instructions.length + ' chars' : 'none (derived from topics)'}`);
    console.log(`    topics: ${ir.topics.length}  knowledge: ${ir.knowledgeSources.length}  starters: ${ir.starterPrompts.length}`);
    console.log(`    → mapped "${mapped.displayName}"  model=${mapped.model}  instruction=${mapped.instruction.length} chars`);
    console.log(`    fidelity notes: ${mapped.fidelityNotes.map((f) => `${f.component}[${f.status}]`).join(', ') || 'none'}`);
  }

  if (!LIVE) {
    console.log('\nDRY RUN complete. Extraction + mapping work. Re-run with --live to create in Gemini.');
    process.exit(0);
  }

  // 3) LIVE — create ONE agent in Gemini, publish, share, verify.
  line();
  console.log('LIVE — create → publish → share → verify (ONE agent)');
  line();
  const project = s.geminiProject ?? '';
  const dest = defaultDestination(project);
  const saToken = await getSaToken(s.gEmail);
  const reachable = await engineReachable(dest, saToken);
  console.log(`engine reachable: ${reachable}`);
  if (!reachable) throw new Error('Gemini engine not reachable with the service account');

  const bot = sample[0];
  const ir = await extractAgent(envUrl, dvToken, bot);
  const mapped = await mapAgent(ir);
  mapped.displayName = `[TEST] ${mapped.displayName}`; // clearly-labeled test agent

  console.log(`\nCreating "${mapped.displayName}" …`);
  const create = await createAgent(dest, saToken, mapped);
  if (create.alreadyExists) {
    console.log('  already exists — skipped (delete it in Gemini to re-test creation)');
    process.exit(0);
  }
  if (!create.created || !create.agentId) {
    console.log(`  ✗ CREATE FAILED: ${create.error}`);
    process.exit(1);
  }
  console.log(`  ✓ CREATED  agentId=${create.agentId}`);

  const deployed = await publishAgent(dest, saToken, create.agentId);
  console.log(`  ${deployed ? '✓' : '✗'} publish/deploy`);
  const shared = await shareAgent(dest, saToken, create.agentId);
  console.log(`  ${shared ? '✓' : '✗'} share to org`);
  const v = await verifyAgent(dest, saToken, create.agentId);
  console.log(`  ${v.verified ? '✓' : '✗'} verify  ${v.note ? `(${v.note})` : ''}`);
  if (v.sample) console.log(`    sample reply: "${v.sample.slice(0, 160)}"`);

  line('=');
  console.log(`RESULT: agent ${create.created ? 'CREATED' : 'NOT created'} · deployed=${deployed} · shared=${shared} · verified=${v.verified}`);
  console.log(`Gemini agentId: ${create.agentId}`);
  line('=');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nTEST FAILED:', e.message);
  process.exit(1);
});
