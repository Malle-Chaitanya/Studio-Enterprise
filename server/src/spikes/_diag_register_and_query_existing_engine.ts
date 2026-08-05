// Registers the Reasoning Engine that WAS created server-side by the timed-out
// deploy attempt (1395114779147763712 — the client gave up waiting, but the
// resource exists), instead of orphaning it and deploying yet another one.
// Then queries it with the real content questions.
//   npx tsx src/spikes/_diag_register_and_query_existing_engine.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { registerAdkAgent } from '../services/adkDeployer.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/1395114779147763712';
const SECRET_MARKER = 'ZX-CONFLICT-7742';

async function main() {
  const saToken = await getSaToken();

  console.log('Registering the existing Reasoning Engine into the gallery...');
  const reg = await registerAdkAgent(DEST, saToken, {
    reasoningEngine: REASONING_ENGINE,
    displayName: 'ADK-File-Grounding-Sanity-Check',
    description: 'Diagnostic — clean sanity check for the ADK knowledge-parity fix. Safe to delete.',
  });
  console.log('->', JSON.stringify(reg, null, 2));
  if (!reg.registered) {
    console.log('REGISTER FAILED — stopping.');
    return;
  }

  console.log('Waiting 8s, then querying...');
  await new Promise((r) => setTimeout(r, 8000));

  const ask = async (message: string) => {
    const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'file-grounding-sanity-3', message } }),
    });
    console.log(`\n>>> ${message}`);
    console.log('status:', res.status);
    console.log(await res.text());
  };

  await ask('What secret test marker is mentioned in your knowledge source? Quote it exactly.');
  await ask('What MongoDB query do I use to get the Conflict report for a onetime migration? Quote it exactly.');
  await ask('What is the capital of France?');

  console.log('\n--- SUMMARY ---');
  console.log(`agentId: ${reg.agentId}, state: ${reg.state}`);
  console.log(`If the first two answers above contain "${SECRET_MARKER}" and the real MongoDB query text,`);
  console.log('the ADK grounding fix works end to end, cleanly, independent of the SharePoint fixture.');
}
main().catch((e) => console.error('FATAL:', e.message));
