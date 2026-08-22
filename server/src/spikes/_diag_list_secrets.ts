/** List Secret Manager secret NAMES (never values) so we can reuse rather than duplicate.
 *  cd server && npx tsx src/spikes/_diag_list_secrets.ts [filterRegex] */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const filter = new RegExp(process.argv[2] ?? '.', 'i');
const token = await getSaToken();
const res = await fetch(
  'https://secretmanager.googleapis.com/v1/projects/studio-enterprise-migration/secrets?pageSize=300',
  { headers: { Authorization: `Bearer ${token}` } },
);
const json = (await res.json()) as { secrets?: Array<{ name: string }>; error?: { message?: string } };
if (json.error) {
  console.log('ERROR:', json.error.message);
  process.exit(0);
}
const names = (json.secrets ?? []).map((s) => s.name.split('/').pop() ?? '');
console.log(`total: ${names.length}`);
for (const n of names.filter((n) => filter.test(n)).sort()) console.log('  ', n);
process.exit(0);
