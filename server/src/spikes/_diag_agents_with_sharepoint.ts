/** Which agents have non-file knowledge sources — the ones that need connector wiring. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const col = getDb().collection('stagedAgents');
const ids = await col.distinct('sourceId', {});
const out: string[] = [];
for (const id of ids) {
  const r = await col.find({ sourceId: id }).sort({ _id: -1 }).limit(1).next() as any;
  if (!r) continue;
  const ks = (r.knowledge ?? []).filter((k: any) => k.kind !== 'FileUpload');
  if (!ks.length) continue;
  const parts = ks.map((k: any) =>
    `${k.kind}:${k.name}[conn=${k.classification?.requiresConnectorId ?? '-'} strat=${k.classification?.strategy ?? '-'}]`);
  out.push(`${r.displayName}  (${r.stagedAt})\n    ${parts.join('\n    ')}`);
}
console.log(`agents with non-file knowledge: ${out.length} of ${ids.length}\n`);
console.log(out.join('\n'));
process.exit(0);
