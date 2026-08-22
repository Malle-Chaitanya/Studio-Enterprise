/**
 * What has this project ACTUALLY migrated, and what did it honestly report?
 *
 * Not a feature list — the record. Every migrationResult ever written, grouped by what the
 * pipeline itself said about the outcome. `deployed=true` is counted separately from
 * `verified=true` throughout, because the whole project turns on the difference.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();

const all = await db.collection('migrationResults').find({}).toArray();
console.log(`${all.length} migration result(s) on record\n`);

const byAgent = new Map<string, Record<string, unknown>[]>();
for (const r of all as Record<string, unknown>[]) {
  const n = String(r.name ?? '?');
  byAgent.set(n, [...(byAgent.get(n) ?? []), r]);
}
console.log('AGENT                          runs  created deployed shared verified  lastError');
for (const [name, rows] of [...byAgent].sort()) {
  const last = rows[rows.length - 1];
  const c = rows.filter((r) => r.created).length;
  const d = rows.filter((r) => r.deployed).length;
  const s = rows.filter((r) => r.shared).length;
  const v = rows.filter((r) => r.verified).length;
  console.log(
    `${name.slice(0, 30).padEnd(30)} ${String(rows.length).padStart(4)}  ${String(c).padStart(7)} ${String(d).padStart(8)} ${String(s).padStart(6)} ${String(v).padStart(8)}  ${String(last.error ?? '-').slice(0, 30)}`,
  );
}

// Which components recur as problems, across every agent ever migrated.
const counts = new Map<string, Map<string, number>>();
for (const r of all as Record<string, unknown>[]) {
  for (const f of (r.fidelity ?? []) as Array<{ component: string; status: string }>) {
    const key = f.component.replace(/:.*$/, '');
    const m = counts.get(key) ?? new Map<string, number>();
    m.set(f.status, (m.get(f.status) ?? 0) + 1);
    counts.set(key, m);
  }
}
console.log('\nFIDELITY BY COMPONENT (across every migration)');
const rows = [...counts].map(([comp, m]) => ({
  comp,
  mapped: m.get('mapped') ?? 0,
  partial: m.get('partial') ?? 0,
  review: m.get('needs-review') ?? 0,
  lost: m.get('lost') ?? 0,
}));
rows.sort((a, b) => b.lost + b.review - (a.lost + a.review));
console.log('component                 mapped partial needs-review lost');
for (const r of rows) {
  console.log(
    `${r.comp.slice(0, 24).padEnd(25)} ${String(r.mapped).padStart(6)} ${String(r.partial).padStart(7)} ${String(r.review).padStart(12)} ${String(r.lost).padStart(4)}`,
  );
}
process.exit(0);
