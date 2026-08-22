import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const all = await db.collection('migrationResults').find({}).toArray();

// Only agents that were REALLY created — dry-runs never exercised the deploy path and their
// notes would inflate every count with work that was not attempted.
const real = (all as Record<string, unknown>[]).filter((r) => r.created);
console.log(`${real.length} real (non-dry-run) migrations\n`);

const buckets = new Map<string, Map<string, number>>();
for (const r of real) {
  for (const f of (r.fidelity ?? []) as Array<{ component: string; status: string; detail: string }>) {
    if (f.status !== 'lost' && f.status !== 'needs-review') continue;
    const key = f.component.replace(/:.*$/, '');
    // First sentence only — the detail carries per-agent specifics after it.
    const gist = (f.detail || '').split(/(?<=\.)\s/)[0].slice(0, 110);
    const m = buckets.get(key) ?? new Map<string, number>();
    m.set(`${f.status}|${gist}`, (m.get(`${f.status}|${gist}`) ?? 0) + 1);
    buckets.set(key, m);
  }
}
for (const [comp, m] of [...buckets].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  const total = [...m.values()].reduce((x, y) => x + y, 0);
  console.log(`\n=== ${comp} (${total}) ===`);
  for (const [k, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    const [status, gist] = k.split('|');
    console.log(`  ${String(n).padStart(3)}x [${status}] ${gist}`);
  }
}
process.exit(0);
