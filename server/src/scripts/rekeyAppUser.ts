/**
 * Give the placeholder-owned data a real owner.
 *
 * Every migration-scoped collection is keyed by `appUserId`, but sign-in did not exist
 * until now, so everything already stored carries the literal string 'default'. Those rows
 * are reachable by any signed-in user (auth/sessionOwnership.ts says so explicitly). This
 * script closes that by moving them to a named account.
 *
 * It is NOT run on boot, deliberately. A silent re-key at startup would attribute whatever
 * happens to be in the database to whoever happens to deploy next — which is precisely the
 * cross-tenant mistake the whole exercise is meant to prevent. An operator names the owner.
 *
 *   npx tsx src/scripts/rekeyAppUser.ts --email admin@cloudfuze.com            # dry run
 *   npx tsx src/scripts/rekeyAppUser.ts --email admin@cloudfuze.com --commit
 *
 * Dry run by default: it prints exactly what it would move and changes nothing.
 */
import 'dotenv/config';
import { config } from '../config.js';
import { getDb } from '../db/core.js';
import { connectMongo } from '../db/mongo.js';

/** Every collection whose rows belong to one customer. Keep in step with mongo.ts. */
const SCOPED_COLLECTIONS = [
  'migrationSessions',
  'migrationRuns',
  'migrationResults',
  'migrationLogs',
  'agentIRCache',
  'environmentsCache',
  'stagedAgents',
  'connectorCredentials',
  'adkDeployments',
  'knowledgeConnectors',
  'identityMap',
  'connectorOpIndex',
  'authSessions',
] as const;

const PLACEHOLDER = 'default';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const email = arg('email')?.trim().toLowerCase();
const commit = process.argv.includes('--commit');

if (!email) {
  console.error('usage: rekeyAppUser.ts --email <account email> [--commit]');
  process.exit(1);
}

await connectMongo();
const db = getDb(config.CSGE_DB);

// Resolve the target from the accounts table rather than accepting a raw id: an id typed
// by hand that matches no account would attribute every row to a user who cannot sign in,
// and the data would look migrated while being unreachable.
const user = await db.collection('appUsers').findOne({ email });
if (!user) {
  const known = await db.collection('appUsers').find({}, { projection: { email: 1 } }).toArray();
  console.error(`no app user with email "${email}". Known accounts: ${known.map((u) => u.email).join(', ') || '(none)'}`);
  process.exit(1);
}
const targetId = String(user._id);

console.log(`${commit ? 'RE-KEY' : 'DRY RUN'} — '${PLACEHOLDER}' → ${email} (${targetId})\n`);

let total = 0;
for (const coll of SCOPED_COLLECTIONS) {
  const filter = { $or: [{ appUserId: PLACEHOLDER }, { appUserId: { $exists: false } }] };
  let count = 0;
  try {
    count = await db.collection(coll).countDocuments(filter);
  } catch (err) {
    console.log(`  ${coll.padEnd(22)} — could not read (${(err as Error).message})`);
    continue;
  }
  if (!count) {
    console.log(`  ${coll.padEnd(22)} 0`);
    continue;
  }
  total += count;
  if (commit) {
    const r = await db.collection(coll).updateMany(filter, { $set: { appUserId: targetId } });
    console.log(`  ${coll.padEnd(22)} ${count} → moved ${r.modifiedCount}`);
  } else {
    console.log(`  ${coll.padEnd(22)} ${count} → would move`);
  }
}

console.log(`\n${commit ? 'moved' : 'would move'} ${total} row(s).`);
if (!commit) console.log('Nothing was changed. Re-run with --commit to apply.');
else {
  console.log(
    '\nSecret Manager ids are NOT rewritten: connectorCredentials rows carry the ids they ' +
      'were stored under, and the deployed agents read those exact ids. Re-keying the row ' +
      'changes who can see the record, not where the secret lives — which is what keeps ' +
      'already-deployed agents working.',
  );
}
process.exit(0);
