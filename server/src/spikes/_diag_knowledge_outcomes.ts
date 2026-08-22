import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const real = (await db.collection('migrationResults').find({ created: true }).toArray()) as Record<string, unknown>[];
const m = new Map<string, number>();
for (const r of real) {
  for (const f of (r.fidelity ?? []) as Array<{ component: string; status: string; detail: string }>) {
    if (!/^knowledge/i.test(f.component)) continue;
    const d = f.detail || '';
    // Bucket by the knowledge KIND named in the note, which is what a customer would ask about.
    const kind = /confluence/i.test(d) ? 'Confluence'
      : /sharepoint/i.test(d) ? 'SharePoint'
      : /dataverse/i.test(d) ? 'Dataverse'
      : /upload|file/i.test(d) ? 'Uploaded file'
      : /website|url|public web/i.test(d) ? 'Website / URL'
      : 'other';
    const key = `${kind} :: ${f.status}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
}
console.log('KNOWLEDGE SOURCE OUTCOMES (real migrations only)');
for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}x  ${k}`);
process.exit(0);
