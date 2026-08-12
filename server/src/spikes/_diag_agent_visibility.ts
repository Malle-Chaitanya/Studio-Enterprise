/** Where did the deployed agent actually land, and what state is it in? Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const PROJECT = process.argv[2] ?? 'studio-enterprise-migration';
const LOOK_FOR = process.argv[3] ?? '';
const saToken = await getSaToken();
const dest = await resolveDestination(PROJECT, saToken);
console.log(`project=${dest.project} engine=${dest.engine} assistant=${dest.assistant}`);

const base =
  `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global` +
  `/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`;
const res = await fetch(base, { headers: { Authorization: `Bearer ${saToken}` } });
const text = await res.text();
if (!res.ok) {
  console.log(`list agents ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
const agents = (JSON.parse(text).agents ?? []) as Array<Record<string, any>>;
console.log(`\n${agents.length} agent(s) in this assistant:`);
for (const a of agents) {
  const id = String(a.name ?? '').split('/').pop();
  const adk = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '';
  const mark = LOOK_FOR && (id === LOOK_FOR || String(a.displayName ?? '').includes(LOOK_FOR)) ? '  <<<' : '';
  console.log(
    `  ${id}  state=${a.state ?? '-'}  "${a.displayName}"  ${adk ? 'ADK:' + adk.split('/').pop() : 'low-code'}${mark}`,
  );
}
process.exit(0);
