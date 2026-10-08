/** Same agent, same question, two callers — is the failure caller-specific or universal? */
import 'dotenv/config';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '505103737920';
const RE_ID = process.env.RE_ID || '4850250904596643840';
const Q = process.env.Q || 'look up the client profile for Atlas Industrial Group';
const saToken = await getSaToken();

for (const userId of (process.env.WHO || 'admin@migrationn.com,alex@migrationn.com').split(',')) {
  const res = await chatWithAdkAgent(PROJECT, saToken, {
    reasoningEngineId: RE_ID,
    message: Q,
    userId: userId.trim(),
  });
  console.log(`\n=== ${userId.trim()} ===`);
  console.log(JSON.stringify(res).slice(0, 900));
}
process.exit(0);
