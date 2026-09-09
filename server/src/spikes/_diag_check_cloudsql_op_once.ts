import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = 'agentmigrations';
const OP = 'f13a336b-b9b0-4190-97b2-a77a00000032';
const saToken = await getSaToken();
const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/operations/${OP}`, {
  headers: { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT },
});
console.log('status:', res.status);
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 1200));
process.exit(0);
