/**
 * End-to-end Confluence migration spike.
 * Fetches pages from cf2020.atlassian.net → uploads as agentFiles on a
 * Gemini low-code agent so mia@cloudfuze.com can see it with real knowledge.
 *
 * Usage: cd server && npx tsx src/spikes/_test_confluence_e2e.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, publishAgent, shareAgent } from '../services/gemini.js';
import { uploadConfluencePagesToAgent } from '../services/confluenceMigrator.js';

// ── Confluence creds ──────────────────────────────────────────────────────────
const CONFLUENCE_BASE_URL = 'https://cf2020.atlassian.net';
const CONFLUENCE_EMAIL    = 'sujana.manapuram@cloudfuze.com';
const CONFLUENCE_TOKEN    = process.env.CONFLUENCE_TOKEN ?? '';

const SPACE_NAMES = ['Engineering', 'Human Resources', 'Sales and Revenue'];

// ── GCP / Gemini ──────────────────────────────────────────────────────────────
const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';

async function main() {
  console.log('═'.repeat(70));
  console.log('Confluence E2E Migration Spike (agentFiles approach)');
  console.log('═'.repeat(70));

  // ── Step 1: DWD token as mia (Owner of Business project) ──────────────────
  console.log('\n[1/4] Getting DWD token…');
  let saToken: string;
  try {
    saToken = await getSaToken(GEMINI_ADMIN);
    console.log(`  ✓ Token acquired (DWD as ${GEMINI_ADMIN})`);
  } catch (e) {
    console.error('  ✗ Token failed:', (e as Error).message);
    process.exit(1);
  }

  // ── Step 2: Resolve Gemini destination ────────────────────────────────────
  console.log('\n[2/4] Discovering Gemini engine…');
  const dest = await resolveDestination(GCP_PROJECT, saToken);
  console.log(`  ✓ project=${dest.project} engine=${dest.engine} assistant=${dest.assistant}`);

  // ── Step 3: Find or create the Gemini agent ───────────────────────────────
  console.log('\n[3/4] Finding or creating Gemini agent…');
  const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
  const assistantBase =
    `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
    `/engines/${dest.engine}/assistants/${dest.assistant}`;

  const DISPLAY_NAME = 'Confluence Knowledge Agent (Test)';
  const DESCRIPTION  = 'Test agent grounded on Confluence spaces: ' + SPACE_NAMES.join(', ');
  const INSTRUCTION  =
    `You are a helpful assistant that answers questions using knowledge from the Confluence spaces: ${SPACE_NAMES.join(', ')}. ` +
    'Your knowledge comes from files attached to this agent — search them to answer questions. ' +
    'If the answer is not in your knowledge files, say so clearly. ' +
    'Cite the page title when referencing specific information.';
  const STARTERS = [
    { text: 'What are our coding standards?' },
    { text: 'Summarise the Engineering home page' },
    { text: 'What is in the HR space?' },
  ];

  // Search first — avoid quota exhaustion from repeated creates
  let agentId: string | undefined;
  const listRes = await fetch(`${assistantBase}/agents?pageSize=50`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (listRes.ok) {
    const listJson = await listRes.json() as { agents?: Array<{ name: string; displayName: string }> };
    const found = (listJson.agents ?? []).find((a) => a.displayName === DISPLAY_NAME);
    if (found) {
      agentId = found.name.split('/').pop()!;
      console.log(`  ✓ Reusing existing agent: ${agentId}`);
    }
  }

  if (!agentId) {
    const agentBody = {
      displayName: DISPLAY_NAME,
      description: DESCRIPTION,
      starterPrompts: STARTERS,
      icon: {},
      lowCodeAgentDefinition: {
        rootAgentId: 'root_agent',
        nodes: [
          {
            id: 'root_agent',
            displayName: DISPLAY_NAME,
            llmAgentNode: {
              description: DESCRIPTION,
              model: 'gemini-2.0-flash-001',
              instruction: INSTRUCTION,
              subAgentIds: [],
              selectedTools: { tool: [{ name: 'googleSearch' }] },
            },
          },
        ],
        draftDisplayName: DISPLAY_NAME,
        draftDescription: DESCRIPTION,
        draftStarterPrompts: STARTERS.slice(0, 2),
        draftIcon: { content: '' },
        deployedNodes: [],
        agentFiles: [],
        draftSchedules: [],
        deployedSchedules: [],
      },
    };

    const createRes = await fetch(`${assistantBase}/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(agentBody),
    });
    const createJson = await createRes.json() as Record<string, unknown>;
    if (!createRes.ok) {
      console.error('  ✗ Create failed:', createRes.status, JSON.stringify(createJson).slice(0, 300));
      process.exit(1);
    }
    agentId = (createJson.name as string).split('/').pop()!;
    console.log(`  ✓ Agent created: ${agentId}  state=${createJson.state}`);
  }

  // ── Step 4: Upload Confluence pages as agent files ────────────────────────
  console.log(`\n[4/4] Uploading Confluence pages as agent files…`);
  const result = await uploadConfluencePagesToAgent(dest, saToken, agentId, {
    base_url:  CONFLUENCE_BASE_URL,
    email:     CONFLUENCE_EMAIL,
    api_token: CONFLUENCE_TOKEN,
    spaceNames: SPACE_NAMES,
  });

  if (result.error && result.uploaded === 0) {
    console.error('  ✗ Upload failed:', result.error);
    process.exit(1);
  }

  console.log(`  ✓ Uploaded: ${result.uploaded} pages  Skipped (already exist): ${result.skipped}`);
  if (result.error) console.warn('  ⚠ Warning:', result.error);

  // ── Step 5: Publish + share ────────────────────────────────────────────────
  console.log('\n[publish] Publishing agent…');
  const published = await publishAgent(dest, saToken, agentId);
  console.log(published ? '  ✓ Published (ENABLED)' : '  ⚠ Publish returned non-OK (may need manual Create in UI)');

  console.log('[share]   Sharing with all users…');
  const shared = await shareAgent(dest, saToken, agentId);
  console.log(shared ? '  ✓ Shared (ALL_USERS)' : '  ⚠ Share returned non-OK');

  console.log('\n' + '═'.repeat(70));
  console.log('✓ Done — open Gemini Enterprise as mia@cloudfuze.com → Agents.');
  console.log(`  Agent: "${DISPLAY_NAME}"`);
  console.log(`  Knowledge files from spaces: ${SPACE_NAMES.join(', ')}`);
  console.log('═'.repeat(70));
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
