/**
 * Find Reasoning Engines nothing is using, and (only when told) delete them.
 *
 * Every ADK migration deploys a Reasoning Engine and then registers it as a gallery agent.
 * When registration failed the engine was supposed to be deleted — but the cleanup minted
 * its own Application Default Credentials instead of using the service account, so on any
 * host without ADC it failed, returned `false`, and left the engine deployed and billable.
 * Observed live 2026-08-12: **81 of 86** engines in the project had no owning record. The
 * credential bug is fixed; this script is for the ones already there.
 *
 * An engine is only safe to delete when NOTHING points at it. Two sources of truth, and
 * both must agree, because either alone is wrong:
 *   - `adkDeployments` — what this tool believes it deployed. Incomplete: agents repointed
 *     by hand (spikes, repairs) are live but unrecorded.
 *   - The Gemini gallery — every registered agent's `provisionedReasoningEngine`. This is
 *     the authority on what is actually SERVING, and it is the check that stops a reaper
 *     from deleting the engine behind a working agent.
 *
 *   npx tsx src/scripts/reapOrphanEngines.ts                    # report only
 *   npx tsx src/scripts/reapOrphanEngines.ts --older-than 2     # only ones >2 days old
 *   npx tsx src/scripts/reapOrphanEngines.ts --older-than 2 --commit
 *
 * Report-only by default, and it prints what it would keep as well as what it would
 * delete: a reaper you cannot audit before running is not safer than the leak.
 */
import 'dotenv/config';
import { config } from '../config.js';
import { getDb } from '../db/core.js';
import { connectMongo } from '../db/mongo.js';
import { getSaToken } from '../auth/google.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const PROJECT = arg('project') ?? process.env.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration';
const LOCATION = arg('location') ?? process.env.ADK_LOCATION ?? 'us-central1';
const OLDER_THAN_DAYS = Number(arg('older-than') ?? '0');
const COMMIT = process.argv.includes('--commit');

await connectMongo();
const saToken = await getSaToken();
const auth = { Authorization: `Bearer ${saToken}` };

// ── 1. Every engine in the project ────────────────────────────────────────────
interface Engine { name: string; displayName: string; createTime: string }
const engines: Engine[] = [];
{
  let pageToken = '';
  do {
    const url =
      `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}` +
      `/locations/${LOCATION}/reasoningEngines?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: auth });
    if (!res.ok) {
      console.error(`listing engines failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    const j = (await res.json()) as { reasoningEngines?: Engine[]; nextPageToken?: string };
    engines.push(...(j.reasoningEngines ?? []));
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
}

// ── 2. What this tool recorded ────────────────────────────────────────────────
const recorded = new Set(
  (await getDb(config.CSGE_DB).collection('adkDeployments').find({}).toArray())
    .map((r) => String((r as { reasoningEngine?: string }).reasoningEngine ?? '').split('/').pop())
    .filter(Boolean) as string[],
);

// ── 3. What the gallery is actually serving ───────────────────────────────────
//
// The authority. An engine referenced here is live no matter what our database thinks,
// and deleting it breaks a working agent — so a failure to read the gallery must abort
// rather than downgrade every engine to "unreferenced".
const serving = new Set<string>();
{
  const engineIds = new Set(
    (await getDb(config.CSGE_DB).collection('adkDeployments').find({}).toArray())
      .map((r) => String((r as { engine?: string }).engine ?? ''))
      .filter(Boolean),
  );
  const envEngine = process.env.GEMINI_ENGINE_ID;
  if (envEngine) engineIds.add(envEngine);
  if (engineIds.size === 0) {
    console.error('no Gemini engine known — cannot check what is serving. Aborting rather than guessing.');
    process.exit(1);
  }
  for (const engineId of engineIds) {
    const url =
      `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global` +
      `/collections/default_collection/engines/${engineId}/assistants/default_assistant/agents`;
    const res = await fetch(url, { headers: auth });
    if (!res.ok) {
      console.error(`could not list agents on engine ${engineId}: ${res.status}. Aborting — deleting on an incomplete picture is how a working agent dies.`);
      process.exit(1);
    }
    const j = (await res.json()) as {
      agents?: Array<{ displayName?: string; adkAgentDefinition?: { provisionedReasoningEngine?: { reasoningEngine?: string } } }>;
    };
    for (const a of j.agents ?? []) {
      const re = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine;
      if (re) serving.add(re.split('/').pop()!);
    }
  }
}

// ── 4. Classify ───────────────────────────────────────────────────────────────
const cutoff = OLDER_THAN_DAYS > 0 ? Date.now() - OLDER_THAN_DAYS * 86400_000 : Infinity;
const keep: string[] = [];
const reap: Engine[] = [];

for (const e of engines.sort((a, b) => a.createTime.localeCompare(b.createTime))) {
  const id = e.name.split('/').pop()!;
  const age = (Date.now() - new Date(e.createTime).getTime()) / 86400_000;
  let why = '';
  if (serving.has(id)) why = 'SERVING a gallery agent';
  else if (recorded.has(id)) why = 'recorded in adkDeployments';
  else if (new Date(e.createTime).getTime() > cutoff) why = `only ${age.toFixed(1)}d old (under --older-than)`;
  if (why) {
    keep.push(`  KEEP  ${id}  ${e.displayName.padEnd(30)} ${why}`);
  } else {
    reap.push(e);
  }
}

console.log(`${engines.length} engine(s) in ${PROJECT}/${LOCATION}`);
console.log(`  serving a gallery agent: ${serving.size}`);
console.log(`  recorded in adkDeployments: ${recorded.size}\n`);
for (const k of keep) console.log(k);
console.log('');
for (const e of reap) {
  const id = e.name.split('/').pop()!;
  const age = ((Date.now() - new Date(e.createTime).getTime()) / 86400_000).toFixed(1);
  console.log(`  ${COMMIT ? 'DELETE' : 'would delete'}  ${id}  ${e.displayName.padEnd(30)} ${age}d old`);
}

console.log(`\n${reap.length} unreferenced engine(s); ${keep.length} kept.`);

if (!COMMIT) {
  console.log('Report only — nothing was deleted. Re-run with --commit to delete the listed engines.');
  process.exit(0);
}

let deleted = 0;
for (const e of reap) {
  // force=true: an engine with sessions or memories attached refuses a plain delete.
  const res = await fetch(`https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${e.name}?force=true`, {
    method: 'DELETE',
    headers: auth,
  });
  if (res.ok || res.status === 404) {
    deleted++;
    console.log(`  deleted ${e.name.split('/').pop()}`);
  } else {
    console.log(`  FAILED  ${e.name.split('/').pop()} -> ${res.status} ${(await res.text()).slice(0, 140)}`);
  }
}
console.log(`\ndeleted ${deleted}/${reap.length}.`);
process.exit(0);
