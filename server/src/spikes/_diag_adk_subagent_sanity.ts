/**
 * Sanity check: does ADK's `sub_agents` mechanism ACTUALLY delegate at runtime
 * when deployed as a real Vertex AI Reasoning Engine, or is this only true in
 * theory (per the ADK docs/source read this session)?
 *
 * Root agent is WorkMate's REAL migrated content (its actual instruction, via
 * the actual buildAdkSpec(ir) path every real migration uses) — not a
 * synthetic throwaway instruction — so the test proves sub_agents works
 * alongside a real, non-trivial migrated agent, not just a bare toy one.
 *
 * Deployed as a SEPARATE, brand-new Reasoning Engine + agent registration
 * ("WorkMate — Subagent Sanity Copy"). The real, currently-verified WorkMate
 * agent (agent id 4163375760872779420, confirmed live 2026-08-23) is NEVER
 * touched — no existingAgentId is passed, so this can only ever create a new
 * agent, never repoint or overwrite the real one.
 *
 * The billing sub-agent's instruction plants an unmistakable,
 * LLM-unlikely-to-invent marker ("SUBAGENT_MARKER_7F3Q") that only appears in
 * the reply if real delegation happened — not just the model improvising a
 * plausible-sounding billing answer on its own.
 *
 * COST WARNING: this deploys a real, billable, always-on Reasoning Engine.
 * Delete it when done — see the printed cleanup command at the end.
 *
 * Run: cd server && npx tsx src/spikes/_diag_adk_subagent_sanity.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { buildAdkSpec, deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';
import type { AgentIR } from '../types.js';

const MARKER = 'SUBAGENT_MARKER_7F3Q';

async function main() {
  await connectMongo();

  // Find WorkMate's real sourceId the same read-only way _diag_boss_workmate_history.ts
  // does — never hardcode a sourceId guess, ask the DB.
  const workmateResult = await getDb()
    .collection('migrationResults')
    .find({ name: /workmate/i })
    .sort({ $natural: -1 })
    .project({ name: 1, sourceId: 1 })
    .limit(1)
    .next();
  if (!workmateResult?.sourceId) throw new Error('no migrationResults row named "WorkMate" with a sourceId — cannot find its real IR');
  console.log(`found WorkMate result: name="${workmateResult.name}" sourceId=${workmateResult.sourceId}`);

  const cached = await getDb()
    .collection('agentIRCache')
    .find({ sourceId: workmateResult.sourceId })
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  if (!cached?.ir) throw new Error(`no cached IR for sourceId ${workmateResult.sourceId}`);
  const ir = cached.ir as AgentIR;
  console.log(`real WorkMate IR: name="${ir.name}" description="${ir.description}"`);
  console.log(`instruction (first 300 chars): ${(ir.instructions ?? '').slice(0, 300)}...\n`);

  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject — run a normal migration once first so a session exists');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = await resolveDestination(s.geminiProject, saToken);
  console.log(`project: ${dest.project}\n`);

  // buildAdkSpec(ir) is the SAME function every real migration uses — this is
  // WorkMate's real instruction, verbatim, not a hand-typed stand-in. Only the
  // name/displayName and subAgents are overridden, so this deploys as an
  // obviously-separate test artifact rather than colliding with the real one.
  const spec = buildAdkSpec(ir);
  spec.name = 'workmate_subagent_sanity_copy';
  spec.displayName = 'WorkMate — Subagent Sanity Copy (safe to delete)';
  spec.subAgents = [
    {
      id: 'billing_expert',
      displayName: 'Billing Expert',
      description:
        'Handles ALL billing, invoice, payment, and refund questions. Use this whenever ' +
        'the user asks about billing, invoices, payments, charges, or refunds.',
      instruction:
        `You are a billing expert sub-agent. For ANY question you answer, you MUST start ` +
        `your reply with the exact literal text "${MARKER}" (no quotes) before anything else. ` +
        `This is a fixed internal marker, not something to explain to the user.`,
      model: 'gemini-2.5-flash',
    },
  ];

  console.log('deploying real Reasoning Engine (2-5 min)...');
  const dep = await deployReasoningEngine(dest.project, process.env.ADK_LOCATION || 'us-central1', spec);
  console.log('deploy result:', JSON.stringify(dep, null, 2));
  if (!dep.ok || !dep.reasoningEngine) {
    console.log('FAILED at deploy — stopping here.');
    process.exit(1);
  }

  console.log('\nregistering into engine...');
  const reg = await registerAdkAgent(dest, saToken, {
    reasoningEngine: dep.reasoningEngine,
    displayName: spec.displayName,
    description: spec.description,
  });
  console.log('register result:', JSON.stringify(reg, null, 2));
  if (!reg.registered || !reg.agentId) {
    console.log('FAILED at register — stopping here.');
    process.exit(1);
  }

  // Three probes:
  //   1. squarely in the sub-agent's domain — should show the marker (real delegation)
  //   2. squarely off-topic — should show NEITHER (proves it isn't delegating everything)
  //   3. WorkMate's own real identity question — proves the REAL migrated instruction
  //      still governs the root's own answers, i.e. adding a sub-agent didn't clobber
  //      or dilute WorkMate's actual migrated behavior.
  const probes: Array<{ label: string; message: string; expectMarker: boolean }> = [
    { label: 'billing question (should delegate)', message: 'Why was I charged twice on my last invoice?', expectMarker: true },
    { label: 'general question (should NOT delegate)', message: 'What is the capital of France?', expectMarker: false },
    { label: "WorkMate's own real identity (root fidelity check)", message: 'Briefly, what can you help me with?', expectMarker: false },
  ];

  for (const probe of probes) {
    console.log(`\n--- probe: ${probe.label} ---`);
    console.log(`> ${probe.message}`);
    const result = await chatWithAdkAgent(dest.project, saToken, {
      reasoningEngineId: dep.reasoningEngine.split('/').pop()!,
      message: probe.message,
      userId: 'cf-subagent-sanity',
      location: process.env.ADK_LOCATION || 'us-central1',
    });
    if (!result.ok) {
      console.log(`FAILED: ${result.error}`);
      continue;
    }
    const answer = result.answer ?? '';
    console.log(`< ${answer}`);
    console.log(`  toolNames observed: ${JSON.stringify(result.toolNames ?? [])}`);
    const hasMarker = answer.includes(MARKER);
    const transferredEvidence = (result.toolNames ?? []).some((n) => /transfer_to_agent|billing_expert/i.test(n));
    const verdict = hasMarker === probe.expectMarker ? 'PASS' : 'FAIL';
    console.log(
      `  marker present: ${hasMarker} (expected ${probe.expectMarker}) — transfer evidence in toolNames: ${transferredEvidence} — ${verdict}`,
    );
  }

  console.log(`\n=== CLEANUP — this Reasoning Engine is billable, delete it when done ===`);
  console.log(`reasoningEngine: ${dep.reasoningEngine}`);
  console.log(`agentId: ${reg.agentId}`);
  console.log(
    `Delete via: DELETE https://${process.env.ADK_LOCATION || 'us-central1'}-aiplatform.googleapis.com/v1beta1/${dep.reasoningEngine}?force=true`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
