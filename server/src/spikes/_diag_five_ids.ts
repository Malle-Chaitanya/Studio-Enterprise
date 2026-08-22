/** Full sourceIds for the remaining test agents — the plan API takes botIds, and a truncated
 *  id silently selects nothing. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
const WANT = ['Enterprise Migration Knowledge', 'Email Manager', 'HubSpot Agent', 'Confluence Knowledge Assistant'];
await connectMongo();
const rows = (await getDb().collection('stagedAgents').find({ displayName: { $in: WANT } }).toArray()) as Array<Record<string, any>>;
const seen = new Map<string, string>();
for (const r of rows) seen.set(String(r.displayName), `${String(r.sourceId)}   env=${String(r.envUrl)}`);
for (const w of WANT) console.log(`${w.padEnd(34)} ${seen.get(w) ?? 'NOT FOUND'}`);
process.exit(0);
