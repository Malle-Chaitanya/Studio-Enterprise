/**
 * Live end-to-end proof: does ADK's VertexAiSearchTool actually ground answers
 * on a website data store? Deploys ONE real (billable) Reasoning Engine agent,
 * probes it with a question only the configured website can answer, and prints
 * the reasoningEngine resource name so it can be deleted right after.
 *
 *   npx tsx src/_diag_adk_website_live_test.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { verifyAgent } from '../services/verify.js';
import type { AgentIR, KnowledgeSourceIR } from '../types.js';

const TEST_URL = 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/';
const PROBE = 'How do I add SharePoint as a knowledge source?';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');

  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);

  const websiteSource: KnowledgeSourceIR = {
    id: 'adklivetest',
    name: 'ADK Live Test Website',
    kind: 'PublicSiteSearchSource',
    reference: TEST_URL,
    references: [TEST_URL],
  };

  const ir: AgentIR = {
    sourceId: 'adk-live-test',
    name: 'ADK Website Live Test',
    instructions: 'You are a helpful assistant. Use the connected search tool to answer questions about Microsoft Copilot Studio, grounded only in that source.',
    description: 'Live test agent proving VertexAiSearchTool grounds on a website data store.',
    capabilities: { webBrowsing: false, codeInterpreter: false },
    starterPrompts: [],
    topics: [],
    knowledgeSources: [websiteSource],
    unmapped: [],
  };

  console.log(`project: ${dest.project}\nengine: ${dest.engine}\nwebsite: ${TEST_URL}\n`);
  console.log('publishing ADK agent (this deploys a real Reasoning Engine — takes 2-5 min)...');

  const result = await publishAgentToGallery(dest, saToken, ir, { websiteSource });
  console.log('\npublish result:', JSON.stringify(result, null, 2));

  if (!result.ok || !result.agentId) {
    console.log('\nFAILED before reaching a testable agent — stopping here.');
    process.exit(1);
  }

  console.log(`\nreasoningEngine to delete afterward: ${result.reasoningEngine}`);
  console.log(`agentId to delete afterward: ${result.agentId}\n`);
  console.log(`probing: "${PROBE}"`);

  const verify = await verifyAgent(dest, saToken, result.agentId, PROBE);
  console.log('\nverify result:', JSON.stringify(verify, null, 2));

  process.exit(verify.verified ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
