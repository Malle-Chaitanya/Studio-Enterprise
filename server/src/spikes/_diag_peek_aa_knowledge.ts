import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const mc = await MongoClient.connect(config.MONGO_HOST);
const doc = await mc.db(config.CSGE_DB).collection('stagedAgents').find({}).sort({$natural:-1}).limit(1).next();
const dv = (doc.knowledge || []).find(k => k.kind === 'DataverseStructuredSearchSource');
console.log(JSON.stringify(dv, null, 2));
await mc.close(); process.exit(0);
