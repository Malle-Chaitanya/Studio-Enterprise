/**
 * Prove the google-adk pin actually produces a WORKING deployment.
 *
 * Background: deployed agents began failing every query with
 *   TypeError: 'NoneType' object is not subscriptable   (llm_agent.py:630, _resolved_model)
 * with no change on our side. Root cause: adk_deploy.py shipped UNPINNED requirements, so
 * the container installed a newer google-adk than the one that wrote the pickle locally.
 * The pickle and its runtime silently disagreed. Fix: pin google-adk to the local version.
 *
 * Nothing about that fix was ever proven end to end — three attempted runs died for
 * unrelated reasons. This spike is the smallest thing that proves it: ONE agent, NO
 * grounding, NO connectors, deployed through the real publishAgentToGallery path, then
 * queried. Grounding is deliberately absent — it is orthogonal to the pin and only adds
 * failure modes that would muddy the verdict.
 *
 * PASS  = deploy ok AND the query returns model text.
 * FAIL  = deploy not ok, OR the query returns the NoneType/_resolved_model error.
 *
 *   cd server && npx tsx src/spikes/_test_adk_pin_proof.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

const ir: AgentIR = {
  sourceId: 'adk-pin-proof-2026-08-19',
  name: 'ADK-Pin-Proof',
  description: 'Diagnostic — proves the google-adk version pin yields a queryable deployment. Safe to delete.',
  instructions:
    'You are a diagnostic test assistant. Answer briefly and directly. ' +
    'When asked what you are, say you are a deployment sanity check.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  topics: [],
  knowledgeSources: [],
  unmapped: [],
};

async function main() {
  const saToken = await getSaToken();

  console.log('=== deploying (no grounding, no connectors) ===');
  const adk = await publishAgentToGallery(DEST, saToken, ir);
  console.log(JSON.stringify(adk, null, 2));

  if (!adk.ok || !adk.reasoningEngine) {
    console.log('\nVERDICT: FAIL — deploy did not succeed. The pin cannot be judged from this run.');
    return;
  }

  console.log('\nWaiting 10s for registration to settle...');
  await new Promise((r) => setTimeout(r, 10_000));

  console.log('=== querying ===');
  const res = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1beta1/${adk.reasoningEngine}:streamQuery?alt=sse`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_method: 'stream_query',
        input: { user_id: 'adk-pin-proof', message: 'What are you? Answer in one sentence.' },
      }),
    },
  );
  const raw = await res.text();
  console.log(`status: ${res.status}, ${raw.length} chars`);
  console.log(raw.slice(0, 3000));

  // The exact signature of the bug this pin exists to kill.
  const brokenPickle = /_resolved_model|NoneType' object is not subscriptable/.test(raw);
  const text = [...raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('').trim();

  console.log('\n--- VERDICT ---');
  console.log(`reasoning engine: ${adk.reasoningEngine}`);
  if (brokenPickle) {
    console.log('FAIL — the pickle/runtime mismatch is STILL present. The pin did not take.');
  } else if (res.status === 200 && text) {
    console.log(`PASS — deployed agent answered: "${text.slice(0, 200)}"`);
  } else {
    console.log('UNKNOWN — no mismatch error, but no model text either. Read the raw stream above.');
  }
}

main().catch((e) => console.error('FATAL:', e.stack || e.message));
