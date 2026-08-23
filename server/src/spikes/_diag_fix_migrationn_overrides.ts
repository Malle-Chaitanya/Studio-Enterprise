/** Fixes the identityMappings doc for tenant 807d6772-...(migrationn.com), appUserId
 *  6a5dfdff7cf05623332758b7 — its "users" keys were raw Dataverse systemuser GUIDs
 *  ("user:{guid}") instead of email addresses, which resolvePrincipal() looks up by
 *  (ctx.overrides.users[srcEmail]). Corrects the keys to real emails and adds the
 *  missing erik -> admin mapping.
 *   npx tsx src/spikes/_diag_fix_migrationn_overrides.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const coll = getDb().collection('identityMappings');
  const doc = await coll.findOne({ _id: '6a7c610660a2011e48ba7cf1' as never });
  console.log('BEFORE:', JSON.stringify(doc, null, 2));

  const correctedUsers = {
    'erik@filefuze.co': 'admin@migrationn.com',
    'alex@filefuze.co': 'alex@migrationn.com',
    'ben@filefuze.co': 'ben@migrationn.com',
  };

  await coll.updateOne(
    { _id: '6a7c610660a2011e48ba7cf1' as never },
    { $set: { users: correctedUsers, updatedAt: new Date().toISOString() } },
  );

  const after = await coll.findOne({ _id: '6a7c610660a2011e48ba7cf1' as never });
  console.log('\nAFTER:', JSON.stringify(after, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
