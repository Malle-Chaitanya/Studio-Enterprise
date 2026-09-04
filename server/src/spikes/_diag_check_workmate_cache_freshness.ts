import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const doc = await getDb().collection('agentIRCache')
    .find({ 'ir.name': 'WorkMate' })
    .sort({ extractedAt: -1 })
    .limit(1)
    .next();
  if (!doc) { console.log('No cached IR found for WorkMate at all.'); process.exit(0); }
  console.log('extractedAt:', doc.extractedAt);
  console.log('topics:', doc.ir?.topics?.length);
  console.log('has Meeting Scheduler Agent topic:', doc.ir?.topics?.some((t: any) => t.name === 'Meeting Scheduler Agent'));
  console.log('agentTools count:', doc.ir?.agentTools?.length);
  console.log('has calendar tool:', doc.ir?.agentTools?.some((t: any) => t.operationId === 'V4CalendarPostItem'));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
