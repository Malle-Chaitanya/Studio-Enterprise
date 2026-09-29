/** Enable the Gmail API on the agentmigrations project via the Service Usage API.
 *  npx tsx src/spikes/_diag_enable_gmail_api.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const saToken = await getSaToken();

const res = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/gmail.googleapis.com:enable`,
  { method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, body: '{}' },
);
console.log('Enable status:', res.status);
console.log((await res.text()).slice(0, 1000));
process.exit(0);
