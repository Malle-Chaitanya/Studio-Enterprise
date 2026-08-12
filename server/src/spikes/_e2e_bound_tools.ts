/**
 * END-TO-END PROOF: does a migrated agent reproduce the call its Copilot original made?
 *
 * Extracts one real agent, builds its bound operation tools the way the insert phase does,
 * deploys it as a Reasoning Engine, then ASKS it a question that can only be answered by
 * calling the vendor. A deployment that returns ENABLED proves nothing; an answer carrying
 * live data proves the tool executed.
 *
 * WRITES: creates/replaces a Reasoning Engine and a gallery agent in the destination Google
 * project. Not read-only — run it deliberately.
 *
 * npx tsx src/spikes/_e2e_bound_tools.ts "<agent name fragment>" <envUrl> "<question>"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import { buildLiveConnectorSpecsDetailed, agentConnectorIds } from '../services/connectorToolBuilder.js';
import { connectorsSharingCredentials } from '../services/connectorCredentials.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';
import { mapAgent } from '../services/mapper.js';

const NAME = process.argv[2] ?? 'confluence';
const ENV = process.argv[3] ?? 'https://orga243378d.crm.dynamics.com';
const QUESTION = process.argv[4] ?? 'List a few pages you can see. Use your tool.';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string; environments?: Array<{ url: string; id: string }> } | null;
const tenantId = cache!.tenantId!;
const environmentId = (cache!.environments ?? []).find((e) => e.url.replace(/\/$/, '') === ENV.replace(/\/$/, ''))!.id;
const scope = `ms-${tenantId}`;

const dvToken = await clientCredsToken(tenantId, ENV);
const bots = await listBots(ENV, dvToken);
const bot = bots.find((b) => b.name.toLowerCase().includes(NAME.toLowerCase()));
if (!bot) {
  console.error(`no agent matching "${NAME}". Agents: ${bots.map((b) => b.name).join(' | ')}`);
  process.exit(1);
}
console.log(`\n=== ${bot.name} (${ENV}) ===`);

const ir = await extractAgent(ENV, dvToken, bot);
const mapped = await mapAgent(ir);

// The connectors this agent uses, plus the credential-group siblings that are already
// configured — the same expansion the orchestrator does.
const records = await listConnectorCredentials('default');
const durable = records.map((r) => r.connectorId);
const configured = [...new Set([...durable, ...durable.flatMap((id) => connectorsSharingCredentials(id))])];
const used = agentConnectorIds(ir);
const { specs } = buildLiveConnectorSpecsDetailed(configured, {
  ownerScope: scope,
  storedSecretIds: Object.fromEntries(records.map((r) => [r.connectorId, r.secretIds ?? {}])),
});

const build = await buildBoundToolSpecs(ir, { tenantId, environmentId, scope }, { dataverseOrgUrl: ENV });
for (const n of build.notes) console.log(`note [${n.status}] ${n.component}: ${n.detail}`);

const liveConnectors = specs
  .filter((c) => used.has(c.id))
  .map((c) => (build.byConnector.get(c.id)?.length ? { ...c, boundOperations: build.byConnector.get(c.id) } : c));

console.log(`connectors wired: ${liveConnectors.map((c) => c.id).join(', ') || '(none)'}`);
for (const c of liveConnectors) {
  for (const op of c.boundOperations ?? []) {
    console.log(`  tool ${op.toolName}: ${op.method} ${op.urlTemplate}  fixed=${Object.keys(op.fixedArgs).length} model=${op.modelArgs.length}`);
  }
  if (!c.boundOperations?.length) console.log(`  (generic REST tool — no bound operations)`);
}
if (!liveConnectors.length) process.exit(1);

const saToken = await getSaToken();
const dest = await resolveDestination(process.env.E2E_PROJECT ?? 'studio-enterprise-migration', saToken);
console.log(`destination: ${dest.project} / ${dest.engine}`);

const deployed = await publishAgentToGallery(dest, saToken, ir, {
  instruction: mapped.instruction,
  liveConnectors,
});
console.log(`deploy: ok=${deployed.ok} agent=${deployed.agentId ?? '-'} state=${deployed.state ?? '-'} secretIam=${deployed.secretIamGranted}`);
if (deployed.error) console.log(`deploy error: ${deployed.error}`);
if (deployed.secretIamError) console.log(`secret IAM: ${deployed.secretIamError}`);
if (!deployed.ok || !deployed.reasoningEngine) process.exit(1);

// The only question that matters: does the tool fire and come back with real data?
const userId = 'cf-bound-tool-proof';
const engineId = deployed.reasoningEngine.split('/').pop()!;
const sessionId = await createAdkSession(dest.project, saToken, engineId, userId);
console.log(`\nQ: ${QUESTION}`);
const answer = await chatWithAdkAgent(dest.project, saToken, {
  reasoningEngineId: engineId,
  message: QUESTION,
  userId,
  sessionId: sessionId ?? undefined,
});
console.log(`\nA: ${String(answer).slice(0, 1500)}`);
process.exit(0);
