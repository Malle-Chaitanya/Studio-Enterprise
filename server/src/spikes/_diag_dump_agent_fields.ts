// Research-only: dump the FULL raw Agent resource for every agent in the
// engine, to verify (not assume/recall from memory) whether Discovery Engine's
// Agent resource has ANY field for per-agent knowledge/data-store scoping —
// answering the user's question about automating the chat UI's "+"/connector
// toggle as a per-agent knowledge fix.
//   npx tsx src/spikes/_diag_dump_agent_fields.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { assistantBase } from '../services/gemini.js';

const PROJECT = '231705905417';

async function main() {
  const saToken = await getSaToken();
  const dest = await resolveDestination(PROJECT, saToken);
  const base = assistantBase(dest);
  const res = await fetch(`${base}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { agents?: Record<string, unknown>[] };
  console.log(`status: ${res.status}, agent count: ${json.agents?.length ?? 0}\n`);
  for (const a of json.agents ?? []) {
    console.log('='.repeat(80));
    console.log(JSON.stringify(a, null, 2));
  }
}
main().catch((e) => console.error('FAILED:', e.message));
