/**
 * Save one connector credential field through the real API, using the operator's own live
 * browser login (same cookie, same requireAuth). Values come from the environment, never argv,
 * and nothing here prints them.
 *
 *   CRED_VALUE=... npx tsx src/spikes/_set_connector_cred.ts <connectorId> <field>
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const [connectorId, field] = process.argv.slice(2);
const value = process.env.CRED_VALUE;
if (!connectorId || !field || !value) throw new Error('usage: CRED_VALUE=... _set_connector_cred.ts <connectorId> <field>');

await connectMongo();
const db = getDb();
const login = (await db.collection('appLoginSessions').find({}).sort({ expiresAt: -1 }).limit(1).next()) as Record<string, any> | null;
const session = (await db.collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next()) as Record<string, any> | null;
if (!login || !session) throw new Error('need a live app login AND a migration session');

const r = await fetch('http://localhost:8080/api/migrate/third-party-connectors/credentials', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: `csge_auth=${String(login._id)}` },
  body: JSON.stringify({ session: String(session._id), connectorId, creds: [{ field, value }] }),
});
const body = await r.text();
console.log(`POST credentials (${connectorId}.${field}) -> ${r.status}`);
// split/join, not a RegExp: the value is arbitrary text, and escaping it for a pattern is the
// kind of detail that fails quietly and echoes a credential into the log.
console.log(body.split(value).join('[redacted]').slice(0, 400));
process.exit(0);
