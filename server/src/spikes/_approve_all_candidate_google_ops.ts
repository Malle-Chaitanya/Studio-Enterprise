/**
 * ONE-TIME, EXPLICIT RISK-ACCEPTING ACTION — not a normal part of this project's discipline.
 *
 * Every other operation ever marked `approved` in this catalog (the Office 365 Users pilot's
 * get_user/get_manager) was approved AFTER a real live test against a real tenant. These 26
 * operations are NOT — the user explicitly asked to skip that step and use the database-
 * driven tools for a live migration test tonight, accepting the risk in full knowledge of the
 * tradeoff (see the conversation this was built in). Recorded here in the code, not just in
 * chat history, so nobody reading the catalog later mistakes these for tested-and-proven the
 * way get_user/get_manager are.
 *
 * Only flips `lifecycle.status: 'candidate' -> 'approved'`. The 9 operations already marked
 * `unsupported` (binary/multipart uploads, two-step path lookups, Gmail reply threading) are
 * left untouched — approving them would not make them work, since the underlying capability
 * gap is structural, not a confidence level.
 *
 *   npx tsx src/spikes/_approve_all_candidate_google_ops.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { listCatalogOperations, putCatalogOperation } from '../db/repos/connectorCatalog.js';

const CONNECTOR_IDS = [
  'shared_googledrive',
  'shared_googlesheet',
  'shared_googlecontacts',
  'shared_googlecalendar',
  'shared_googletasks',
  'shared_gmail',
];

await connectMongo();

let approved = 0;
let leftUnsupported = 0;

for (const connectorId of CONNECTOR_IDS) {
  const ops = await listCatalogOperations(connectorId);
  for (const op of ops) {
    if (op.lifecycle.status === 'unsupported') {
      leftUnsupported++;
      continue;
    }
    if (op.lifecycle.status === 'approved') continue; // already approved, nothing to do
    await putCatalogOperation({ ...op, lifecycle: { status: 'approved' } });
    approved++;
    console.log(`approved: ${connectorId} :: ${op.operationKey} (${op.sourceOperationIds.join(', ')})`);
  }
}

console.log(`\n${approved} operation(s) approved (untested — explicit risk acceptance for tonight's live migration), ${leftUnsupported} left unsupported (structurally cannot work).`);
process.exit(0);
