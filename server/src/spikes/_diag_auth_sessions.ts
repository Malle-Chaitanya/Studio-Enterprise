import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const n = await getDb().collection('authSessions').countDocuments({});
console.log('authSessions rows:', n);
const one = await getDb().collection('authSessions').findOne({});
console.log('sample keys:', one ? Object.keys(one).join(', ') : '(empty)');
process.exit(0);
