/**
 * Live end-to-end proof, attempt 2: same as _diag_adk_website_live_test.ts but
 * targeting the Standard-edition project (studio-enterprise-migration /
 * 231705905417) where the SA has DIRECT IAM Owner access (no DWD impersonation
 * needed) per docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md — and where an ADK
 * Reasoning Engine deploy was already proven working previously.
 *
 *   npx tsx src/_diag_adk_website_live_test_standard.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { verifyAgent } from '../services/verify.js';
import type { AgentIR, GeminiDestination, KnowledgeSourceIR } from '../types.js';

const TEST_URL = 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/';
const PROBE = 'How do I add SharePoint as a knowledge source?';

const dest: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

async function main() {
  await connectMongo(); // harmless if unused; keeps parity with other diag scripts
  const saToken = await getSaToken(); // NO impersonation — direct IAM Owner on this project

  const websiteSource: KnowledgeSourceIR = {
    id: 'adklivetest2',
    name: 'ADK Live Test Website 2',
    kind: 'PublicSiteSearchSource',
    reference: TEST_URL,
    references: [TEST_URL],
  };

  const ir: AgentIR = {
    sourceId: 'adk-live-test-2',
    name: 'ADK Website Live Test 2',
    instructions: 'You are a helpful assistant. Use the connected search tool to answer questions about Microsoft Copilot Studio, grounded only in that source.',
    description: 'Live test agent (attempt 2, Standard-edition project) proving VertexAiSearchTool grounds on a website data store.',
    capabilities: { webBrowsing: false, codeInterpreter: false },
    starterPrompts: [],
    topics: [],
    knowledgeSources: [websiteSource],
    unmapped: [],
  };

  console.log(`project: ${dest.project}\nengine: ${dest.engine}\nwebsite: ${TEST_URL}\n`);
  console.log('publishing ADK agent (this deploys a real Reasoning Engine — takes 2-5 min)...');

  const result = await publishAgentToGallery(dest, saToken, ir, { websiteSource, location: 'us-central1' });
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
