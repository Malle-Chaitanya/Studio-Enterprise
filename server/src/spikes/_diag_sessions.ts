import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const rows = await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(8).toArray();
for (const r of rows as Array<Record<string, unknown>>) {
  const plan = r.plan as { units?: Array<{ bots?: unknown[] }> } | undefined;
  const bots = (plan?.units ?? []).reduce((n, u) => n + (u.bots?.length ?? 0), 0);
  console.log(
    `${String(r._id).slice(0, 14).padEnd(15)} appUser=${String(r.appUserId ?? '-').slice(0, 10)} ` +
    `project=${String(r.geminiProject ?? '-').padEnd(28)} plannedBots=${bots} created=${String(r.createdAt ?? '-').slice(0, 19)}`,
  );
}
process.exit(0);
