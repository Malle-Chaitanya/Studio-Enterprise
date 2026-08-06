/**
 * Fix: list all agents, then publish + share a specific one.
 * Usage: cd server && npx tsx src/spikes/_fix_publish_agent.ts [agentId]
 * Default agent: 8980160511526117673 (the one with 14 Confluence pages)
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, publishAgent, shareAgent } from '../services/gemini.js';
import { getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);
console.log(`dest: project=${dest.project} engine=${dest.engine}\n`);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;

// ── List all agents ───────────────────────────────────────────────────────────
console.log('=== All agents ===');
const listRes = await fetch(`${assistantBase}/agents?pageSize=100`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
if (!listRes.ok) {
  console.error(`List failed: ${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const listJson = await listRes.json() as { agents?: Array<{ name: string; displayName: string; state?: string }> };
const agents = listJson.agents ?? [];
for (const a of agents) {
  const id = a.name.split('/').pop();
  console.log(`  ${id}  state=${a.state ?? '?'}  displayName="${a.displayName}"`);
}
console.log();

// ── Target: CLI arg or known good ID ─────────────────────────────────────────
const TARGET_ID = process.argv[2] || '8980160511526117673';
console.log(`Target agent: ${TARGET_ID}`);

// ── Show current file count ───────────────────────────────────────────────────
const agent = await getAgent(dest, saToken, TARGET_ID);
if (!agent) {
  console.error(`getAgent failed — agent ${TARGET_ID} may not exist. Check ID above.`);
  process.exit(1);
}
const files = readAgentFiles(agent);
console.log(`  displayName: ${agent.displayName}`);
console.log(`  state:       ${agent.state}`);
console.log(`  agentFiles:  ${files.length} files`);
for (const f of files) console.log(`    ${f.fileName}  (${f.mimeType})`);
console.log();

// ── Publish (PRIVATE → ENABLED) ───────────────────────────────────────────────
process.stdout.write('Publishing… ');
const publishRes = await fetch(`${assistantBase}/agents/${TARGET_ID}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const publishBody = await publishRes.text();
if (publishRes.ok) {
  console.log('✓ Published (ENABLED)');
} else {
  console.log(`✗ ${publishRes.status}: ${publishBody.slice(0, 300)}`);
}

// ── Share (ALL_USERS) ──────────────────────────────────────────────────────────
process.stdout.write('Sharing… ');
const shareRes = await fetch(`${assistantBase}/agents/${TARGET_ID}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
const shareBody = await shareRes.text();
if (shareRes.ok) {
  console.log('✓ Shared (ALL_USERS)');
} else {
  console.log(`✗ ${shareRes.status}: ${shareBody.slice(0, 300)}`);
}

console.log('\nDone. Open Gemini Enterprise as mia@cloudfuze.com → Agents → Preview tab.');
