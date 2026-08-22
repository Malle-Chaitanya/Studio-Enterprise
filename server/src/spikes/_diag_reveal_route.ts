/**
 * Does the credential-reveal route work, and is it tenant-scoped?
 *
 * The second question is the one that matters. This route returns a real secret value, so a
 * lookup that ignored `appUserId` would be a cross-tenant credential leak — the single worst
 * bug this codebase could ship. Verifies the happy path AND that an unknown field/connector
 * yields nothing rather than someone else's secret.
 *
 *   cd server && npx tsx src/spikes/_diag_reveal_route.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | { _id?: string; appUserId?: string } | null;
const session = String(s?._id ?? '');
console.log(`session ${session.slice(0, 12)}...\n`);

const BASE = 'http://localhost:8080/api/migrate/connector-credential-value';
async function probe(label: string, connectorId: string, field: string) {
  const res = await fetch(`${BASE}?session=${session}&connectorId=${encodeURIComponent(connectorId)}&field=${field}`);
  const body = (await res.json()) as { value?: string; error?: string };
  // Print only the LENGTH and a masked prefix — a diagnostic must not become the thing that
  // writes a client secret into a terminal buffer or a log file.
  const shown = body.value
    ? `${body.value.slice(0, 4)}…(${body.value.length} chars)`
    : `error=${body.error}`;
  console.log(`  ${res.status}  ${label.padEnd(34)} ${shown}`);
}

await probe('ms_graph tenant_id', 'shared_teams', 'tenant_id');
await probe('ms_graph client_secret', 'shared_teams', 'client_secret');
await probe('atlassian api_token', 'shared_jira', 'api_token');
console.log('\n  negative cases (must NOT return a value):');
await probe('unknown connector', 'shared_doesnotexist', 'api_key');
await probe('unknown field', 'shared_teams', 'not_a_field');
await probe('empty field', 'shared_teams', '');

const bad = await fetch(`${BASE}?session=deadbeefnotasession&connectorId=shared_teams&field=tenant_id`);
console.log(`  ${bad.status}  ${'bogus session'.padEnd(34)} ${JSON.stringify(await bad.json())}`);
process.exit(0);
