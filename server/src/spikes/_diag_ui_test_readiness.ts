import { getSaToken } from '../auth/google.js';
import { listLicensedPrincipals } from '../services/gemini.js';

const dest = {
  project: 'agentmigrations',
  engine: 'gemini-enterprise-app_1787446545912',
  assistant: 'default_assistant',
} as never;

const saToken = await getSaToken();
const licensed = await listLicensedPrincipals(dest, saToken);
if (!licensed) {
  console.log('licence list UNREADABLE (not the same as zero seats)');
} else {
  console.log('licensed accounts:', licensed.size);
  for (const p of [...licensed].sort()) console.log('   ', p);
}
