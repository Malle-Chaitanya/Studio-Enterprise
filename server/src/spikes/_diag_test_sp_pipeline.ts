/**
 * Live but non-mutating test of the new SharePoint/OneDrive pipeline:
 *   1. Search Erik's OneDrive for "Dump_docx_2.docx" (real search, read-only).
 *   2. Run migrateSharePointDriveItem in DRY-RUN mode against the real
 *      "CS_GE Knowledge Test Agent" — resolves + downloads but does NOT
 *      upload/attach anything to the live agent.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { findCandidates } from '../services/graphSearch.js';
import { migrateSharePointDriveItem } from '../services/knowledgeDataStoreExecutor.js';

const KNOWN_AGENT_ID = '4173300091433252924'; // CS_GE Knowledge Test Agent, from the earlier real migration run
const KNOWN_ONEDRIVE_OWNER = 'erik@filefuze.co';
const FILENAME = 'Dump_docx_2.docx';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId || !s.geminiProject) throw new Error('no usable session found');

  const graphToken = await clientCredsToken(s.tenantId, 'https://graph.microsoft.com');

  console.log(`=== Step 1: search Erik's OneDrive for "${FILENAME}" ===`);
  const candidates = await findCandidates(graphToken, FILENAME, { oneDriveOwnerEmail: KNOWN_ONEDRIVE_OWNER });
  console.log(`Found ${candidates.length} candidate(s):`);
  for (const c of candidates) {
    console.log(`  - ${c.name} (${c.sizeBytes} bytes, in "${c.parentContext}", modified ${c.lastModifiedDateTime})`);
    console.log(`    driveId=${c.driveId} itemId=${c.itemId}`);
  }
  if (!candidates.length) {
    console.log('No candidates found — cannot continue to step 2.');
    process.exit(0);
  }

  console.log(`\n=== Step 2: migrateSharePointDriveItem in DRY-RUN mode (no writes to the live agent) ===`);
  const saToken = await getSaToken(s.gEmail);
  const dest = defaultDestination(s.geminiProject);
  const result = await migrateSharePointDriveItem(
    dest,
    saToken,
    graphToken,
    KNOWN_AGENT_ID,
    candidates[0],
    true, // dryRun
  );
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
