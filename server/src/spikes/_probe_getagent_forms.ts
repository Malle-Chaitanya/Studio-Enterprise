/**
 * getAgent() said a deleted agent was still there. Which project spelling did it ask about?
 *
 * The run's destination is the project ID (studio-enterprise-migration); the probe that
 * returned 404 used the project NUMBER (231705905417). If one spelling answers 200 for an
 * agent the other says is gone, the existence check is asking a question that cannot fail.
 *
 * Read-only.  npx tsx src/spikes/_probe_getagent_forms.ts <agentId>
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getAgent } from '../services/geminiAgentFiles.js';

const ID = process.argv[2];
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const token = await getSaToken();

for (const project of ['studio-enterprise-migration', '231705905417']) {
  const dest = { project, engine: ENGINE, assistant: 'default_assistant' };
  const got = await getAgent(dest, token, ID).catch((e) => ({ __throw: (e as Error).message }) as any);
  const verdict = got && !('__throw' in got) ? `NON-NULL — displayName="${(got as any).displayName ?? '?'}"` : got ? `threw: ${(got as any).__throw}` : 'null (treated as deleted)';
  console.log(`  project=${project.padEnd(30)} -> ${verdict}`);
}
process.exit(0);
