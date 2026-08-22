import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const real = (await db.collection('migrationResults').find({ created: true }).toArray()) as Record<string, unknown>[];

let clean = 0, verifiedNoLoss = 0;
const summary: string[] = [];
for (const r of real) {
  const fid = (r.fidelity ?? []) as Array<{ component: string; status: string }>;
  const lost = fid.filter((f) => f.status === 'lost').length;
  const review = fid.filter((f) => f.status === 'needs-review').length;
  const v = !!r.verified;
  if (lost === 0) clean++;
  if (lost === 0 && v) verifiedNoLoss++;
  summary.push(`${String(r.name).slice(0, 28).padEnd(29)} verified=${v ? 'Y' : 'n'} lost=${String(lost).padStart(2)} needsReview=${String(review).padStart(2)}`);
}
console.log(`${real.length} real migrations\n`);
console.log(`  verified=true                : ${real.filter((r) => r.verified).length}`);
console.log(`  zero LOST items              : ${clean}`);
console.log(`  verified AND zero lost       : ${verifiedNoLoss}   <- "migrated with no loss and proven"`);
console.log(`  zero lost AND zero needsReview: ${real.filter((r) => !((r.fidelity ?? []) as Array<{status:string}>).some((f) => f.status === 'lost' || f.status === 'needs-review')).length}`);
console.log('');
for (const s of summary.sort()) console.log('  ' + s);
process.exit(0);
