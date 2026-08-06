/**
 * Fix: clear broken agentFiles, re-upload all Confluence pages fresh,
 * then attempt publish + share.
 *
 * The previous PATCH with updateMask=lowCodeAgentDefinition broke the file
 * references — the file IDs exist in agentFiles but the actual resources are
 * gone. Re-upload creates fresh file resources.
 *
 * Usage: cd server && npx tsx src/spikes/_fix_reupload_and_publish.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { uploadConfluencePagesToAgent } from '../services/confluenceMigrator.js';
import type { ConfluenceCreds } from '../services/confluenceMigrator.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';

const CONFLUENCE_CREDS: ConfluenceCreds = {
  base_url:  'https://cf2020.atlassian.net',
  email:     'sujana.manapuram@cloudfuze.com',
  api_token: process.env.CONFLUENCE_TOKEN ?? '',
  spaceNames: ['Engineering', 'Human Resources', 'Sales and Revenue'],
};

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

// ── Step 1: Clear agentFiles so fresh ones aren't blocked by broken refs ───
console.log('[1/4] Clearing broken agentFiles…');
const clearRes = await fetch(
  `${agentUrl}?updateMask=lowCodeAgentDefinition.agentFiles`,
  {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lowCodeAgentDefinition: { agentFiles: [] } }),
  },
);
console.log(`  status: ${clearRes.status}  ${clearRes.ok ? '✓' : '✗ ' + (await clearRes.text()).slice(0, 200)}`);

// ── Step 2: Re-upload all Confluence pages ─────────────────────────────────
console.log('\n[2/4] Re-uploading Confluence pages…');
const result = await uploadConfluencePagesToAgent(dest, saToken, AGENT_ID, CONFLUENCE_CREDS);
console.log(`  uploaded: ${result.uploaded}  skipped: ${result.skipped}`);
if (result.error) console.warn(`  warning: ${result.error}`);

// ── Step 3: Publish ─────────────────────────────────────────────────────────
console.log('\n[3/4] Publishing…');
const pubRes = await fetch(`${agentUrl}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const pubJson = await pubRes.json() as Record<string, unknown>;
const pubAgent = pubJson.agent as Record<string, unknown> | undefined;
console.log(`  status: ${pubRes.status}  agent.state=${pubAgent?.state ?? pubJson.state ?? '?'}`);

// ── Step 4: Share ──────────────────────────────────────────────────────────
console.log('\n[4/4] Sharing (ALL_USERS)…');
const shareRes = await fetch(`${agentUrl}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
const shareText = await shareRes.text();
console.log(`  status: ${shareRes.status}  ${shareRes.ok ? '✓ shared' : '✗ ' + shareText.slice(0, 200)}`);

// ── Final state ────────────────────────────────────────────────────────────
console.log('\n=== Final state ===');
const finalRes = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const final = await finalRes.json() as Record<string, unknown>;
const lcd = final.lowCodeAgentDefinition as Record<string, unknown> | undefined;
console.log(`  state:       ${final.state}`);
console.log(`  agentFiles:  ${(lcd?.agentFiles as unknown[])?.length ?? 0}`);
console.log(`  sharingConfig: ${JSON.stringify(final.sharingConfig)}`);
console.log('\nAgent is ready. In Gemini Enterprise:');
console.log('  1. Open as mia@cloudfuze.com → Agents');
console.log('  2. Click "Confluence Knowledge Agent (Test)"');
console.log('  3. Click "Create" button (top right) to publish the draft');
console.log('  4. Then test in Preview tab');
