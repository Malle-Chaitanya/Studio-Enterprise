/**
 * Credentials by appUserId, WITHOUT going through a session.
 *
 * `migrationSessions` has a Mongo TTL, so every spike that resolves its tenant from "the most
 * recent session" starts reporting nothing the moment that TTL fires — which reads exactly
 * like "the customer never configured anything". The credentials themselves are keyed by
 * appUserId and survive; only the way those spikes found them expires.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
console.log(`sessions alive: ${await db.collection('migrationSessions').countDocuments()}`);
const rows = await db.collection('connectorCredentials').find({}).toArray();
console.log(`connectorCredentials rows: ${rows.length}\n`);
const byUser = new Map<string, string[]>();
for (const r of rows as Array<Record<string, unknown>>) {
  const u = String(r.appUserId);
  byUser.set(u, [...(byUser.get(u) ?? []), `${String(r.connectorId)} [${((r.fields ?? []) as string[]).join(',')}] @${String(r.project)}`]);
}
for (const [u, list] of byUser) {
  console.log(`appUserId ${u} — ${list.length} connector(s)`);
  for (const l of list.sort()) console.log(`   ${l}`);
}
process.exit(0);
