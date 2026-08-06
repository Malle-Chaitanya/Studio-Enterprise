/**
 * Debug: upload ONE HTML file to a Gemini agent and print the raw response.
 * Usage: cd server && npx tsx src/spikes/_diag_agent_file_upload.ts <agentId>
 * defaults to the Confluence test agent id.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { uploadAgentFile, getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';

const AGENT_ID = process.argv[2] || '4595249222720858079';
const PROJECT  = 'sonorous-lightning-t224x';
const EMAIL    = 'mia@cloudfuze.com';

const saToken = await getSaToken(EMAIL);
const dest    = await resolveDestination(PROJECT, saToken);
console.log(`dest: project=${dest.project} engine=${dest.engine}`);

// Current agent files
const agent = await getAgent(dest, saToken, AGENT_ID);
const existing = readAgentFiles(agent);
console.log(`\nExisting agentFiles (${existing.length}):`);
for (const f of existing) console.log(`  ${f.name}  fileName=${f.fileName}`);

// Upload a tiny test HTML file
const testHtml = Buffer.from('<html><body><h1>Test page</h1><p>Hello world</p></body></html>', 'utf-8');
console.log('\nUploading test.html…');
const up = await uploadAgentFile(dest, saToken, AGENT_ID, {
  fileName: 'test-confluence-page.html',
  mimeType: 'text/html',
  bytes: testHtml,
});

console.log(`\nuploadAgentFile result:`);
console.log(`  ok:  ${up.ok}`);
console.log(`  error: ${up.error ?? '(none)'}`);
console.log(`  raw: ${JSON.stringify(up.raw, null, 2)}`);
