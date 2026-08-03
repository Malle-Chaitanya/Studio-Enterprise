/**
 * One-off: deploy + register a REAL ADK agent using the actual extracted
 * AgentIR for "Migration Test Agent 1" (sourceId 66c1641a-6b89-f111-8076-0022480b1f83)
 * pulled straight from agentIRCache — not hand-typed placeholder text. Lets
 * the user compare real migrated behavior against Copilot Studio directly.
 * Throwaway — see conversation for context.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { buildAdkSpec, deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { verifyAgent } from '../services/verify.js';
import type { AgentIR } from '../types.js';

const SOURCE_ID = '66c1641a-6b89-f111-8076-0022480b1f83';

async function main() {
  await connectMongo();
  const cached = await getDb().collection('agentIRCache').find({ sourceId: SOURCE_ID }).sort({ $natural: -1 }).limit(1).next();
  if (!cached?.ir) throw new Error('no cached IR for this sourceId');
  const ir = cached.ir as AgentIR;

  console.log('real extracted IR:');
  console.log('  name:', ir.name);
  console.log('  description:', ir.description);
  console.log('  instructions:', ir.instructions);
  console.log('  capabilities:', JSON.stringify(ir.capabilities));

  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = await resolveDestination(s.geminiProject, saToken);
  console.log(`\nproject: ${dest.project}\nengine: ${dest.engine}\n`);

  const spec = buildAdkSpec(ir);
  console.log('ADK spec (via real buildAdkSpec()):', JSON.stringify(spec, null, 2));

  console.log('\ndeploying real Reasoning Engine (2-5 min)...');
  const dep = await deployReasoningEngine(dest.project, process.env.ADK_LOCATION || 'us-central1', spec);
  console.log('\ndeploy result:', JSON.stringify(dep, null, 2));
  if (!dep.ok || !dep.reasoningEngine) {
    console.log('\nFAILED at deploy — stopping here.');
    process.exit(1);
  }

  console.log('\nregistering into engine...');
  const reg = await registerAdkAgent(dest, saToken, {
    reasoningEngine: dep.reasoningEngine,
    displayName: spec.displayName,
    description: spec.description,
  });
  console.log('\nregister result:', JSON.stringify(reg, null, 2));
  if (!reg.registered || !reg.agentId) {
    console.log('\nFAILED at register — stopping here.');
    process.exit(1);
  }

  const probe = 'What is the leave policy?';
  console.log(`\nprobing: "${probe}"`);
  const verify = await verifyAgent(dest, saToken, reg.agentId, probe);
  console.log('\nverify result:', JSON.stringify(verify, null, 2));

  console.log(`\nreasoningEngine: ${dep.reasoningEngine}`);
  console.log(`agentId: ${reg.agentId}, state: ${reg.state}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
