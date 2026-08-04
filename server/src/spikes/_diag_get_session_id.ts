import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next();
  console.log(s?._id);
  process.exit(0);
}
main();
