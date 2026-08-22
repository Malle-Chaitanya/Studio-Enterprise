import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const row = await getDb().collection('stagedAgents').find({}).sort({ _id: -1 }).limit(1).next() as any;
console.log('top keys:', Object.keys(row ?? {}).join(', '));
const ir = row?.ir ?? row?.agentIR ?? row?.agent;
console.log('ir keys:', ir ? Object.keys(ir).join(', ') : '(no ir)');
process.exit(0);
