import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const cols = await getDb().listCollections().toArray();
  for (const c of cols) {
    const doc = await getDb().collection(c.name).findOne({ $or: [{ cid: { $exists: true } }, { webAppId: { $exists: true } }] } as any);
    if (doc) console.log(c.name, ':', JSON.stringify(doc).slice(0, 300));
  }
  console.log('done scanning');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(0); });
