import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

await connectMongo();
const db = getDb(config.CSGE_DB);
const doc = await db.collection('stagedAgents').findOne({ 'mapped.ir.name': { $regex: /helpdesk/i } });
const tools = (doc as any)?.mapped?.ir?.agentTools ?? [];

const GOOGLE_SIX = ['shared_googledrive','shared_googlesheet','shared_googlecontacts','shared_googlecalendar','shared_googletasks','shared_gmail'];
const byConnector = new Map<string, Set<string>>();
for (const t of tools) {
  if (!t.connectorId || !GOOGLE_SIX.includes(t.connectorId)) continue;
  const modes = byConnector.get(t.connectorId) ?? new Set<string>();
  modes.add(t.connectionAuthMode ?? '(unset)');
  byConnector.set(t.connectorId, modes);
}
for (const [cid, modes] of byConnector) {
  console.log(`${cid}: connectionAuthMode = ${[...modes].join(', ')}`);
}
process.exit(0);
