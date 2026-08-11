/**
 * Live check: does a MIGRATED agent's chat actually retrieve and answer from
 * a Dataverse-snapshot knowledge source, or does the data just sit indexed
 * and unreachable? Uses the real Dataverse-backed structured data store
 * already created this session (spiketest-inline-*-tbl-contacts), reads its
 * actual row content first (so the probe question has a checkable expected
 * answer), then deploys a throwaway ADK agent grounded on it and asks.
 *
 * Real cost: one Reasoning Engine deploy (2-5 min, billable) + one
 * agent-creation quota unit. Safe to delete afterward (throwaway agent).
 *   npx tsx src/spikes/_diag_verify_dv_agent_chat_retrieval.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { verifyAgent } from '../services/verify.js';
import type { AgentIR } from '../types.js';

const DATA_STORE_ID = 'spiketest-inline-msho2nqk-tbl-contacts';
// Pinned to the exact account/project used to create this store earlier this
// session (the live migrationSessions row is a single mutable doc that gets
// overwritten by concurrent real usage of the app — not safe to re-query).
const GEMINI_PROJECT = '72860638029';
const G_EMAIL = 'zara@storefuze.com';

async function searchStore(project: string, saToken: string) {
  // documents.list is the correct way to confirm real indexing for a
  // structured store — a :search call with query:'*' returns empty here
  // even when the document IS indexed (wildcard isn't a real structured-data
  // query); confirmed by cross-checking against a direct documents.list read.
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/branches/0/documents`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, doc: json.documents?.[0]?.structData ?? null, raw: json };
}

async function main() {
  await connectMongo();
  const saToken = await getSaToken(G_EMAIL);
  const dest = await resolveDestination(GEMINI_PROJECT, saToken);
  console.log(`project=${dest.project} engine=${dest.engine}`);

  console.log('\n1) Reading the actual row content from the Dataverse-backed store...');
  const found = await searchStore(dest.project, saToken);
  console.log('   search status:', found.status);
  if (!found.doc) {
    console.log('   NO DOCUMENT FOUND — the store is empty/not searchable. Stopping before deploy (nothing to verify against).');
    console.log('   raw:', JSON.stringify(found.raw).slice(0, 800));
    process.exit(1);
  }
  console.log('   real row structData:', JSON.stringify(found.doc, null, 2).slice(0, 1500));

  // Pick whichever field looks most like a distinctive name/identifier to probe with.
  const nameField = ['fullname', 'name', 'firstname', 'lastname', 'emailaddress1'].find((f) => found.doc[f]);
  const probeValue = nameField ? found.doc[nameField] : JSON.stringify(found.doc).slice(0, 60);
  console.log(`\n   Using field "${nameField}" = "${probeValue}" as the probe target.`);

  const resourcePath = `projects/${dest.project}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}`;

  console.log('\n2) Deploying throwaway ADK agent grounded on this store...');
  const ir = {
    name: 'DV-Chat-Retrieval-Test-Agent',
    description: 'Diagnostic — verifies a migrated agent can actually retrieve from a Dataverse-snapshot knowledge source. Safe to delete.',
    instructions:
      'You are a diagnostic test assistant grounded on a Dataverse contacts table snapshot. When asked about a ' +
      'contact, answer ONLY using the knowledge source data available to you, and quote the specific field values ' +
      'you found. If you cannot find the answer in your knowledge source, say so plainly instead of guessing.',
    capabilities: {},
    knowledgeSources: [],
  } as unknown as AgentIR;

  const adk = await publishAgentToGallery(dest, saToken, ir, {
    groundingDataStores: [{ resourcePath, sourceName: 'contacts (Dataverse snapshot)' }],
  });
  console.log('   deploy result:', JSON.stringify(adk, null, 2));
  if (!adk.ok || !adk.agentId) {
    console.log('DEPLOY FAILED — stopping.');
    process.exit(1);
  }

  console.log('\n3) Asking the deployed agent about the real contact...');
  await new Promise((r) => setTimeout(r, 8000)); // let registration settle
  const probe = `Look up the contact record. What is the value of "${nameField}"? Quote it exactly.`;
  const v = await verifyAgent(dest, saToken, adk.agentId, probe);
  console.log('   verified:', v.verified);
  console.log('   note:', v.note);
  console.log('   ANSWER:', v.sample);

  console.log('\n--- SUMMARY ---');
  console.log(`expected value: "${probeValue}"`);
  const hit = typeof v.sample === 'string' && String(probeValue) && v.sample.includes(String(probeValue));
  console.log(hit
    ? `CONFIRMED: the agent's answer contains the real Dataverse field value — chat retrieval from Dataverse knowledge WORKS.`
    : `NOT CONFIRMED: the answer did not contain the expected value — either grounding isn't reaching the agent at query time, or the assist probe itself is broken/unavailable.`);
  console.log(`New agent id: ${adk.agentId}`);
  console.log(`New reasoning engine: ${adk.reasoningEngine}`);
  console.log('Delete this test agent + its Reasoning Engine once done (no automated cleanup exists yet).');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
