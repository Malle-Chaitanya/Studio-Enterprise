import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const CANDIDATES = [
  'systemusers', 'teams', 'asyncoperations', 'auditlog', 'annotations',
  'activitypointers', 'emails', 'processsessions', 'workflowlogs',
  'duplicaterecords', 'bulkdeletefailures', 'solutioncomponents',
  'privileges', 'roles', 'fieldsecurityprofiles', 'sdkmessages',
  'sdkmessageprocessingsteps', 'attributemaps', 'stringmaps',
];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const env = (s.environments ?? []).find((e) => e.name === 'CloudFuze Migration Test') ?? s.environments?.[0];
  if (!env) throw new Error('no environment');
  const token = await clientCredsToken(s.tenantId ?? '', env.url);

  for (const set of CANDIDATES) {
    try {
      const res = await fetch(`${env.url}/api/data/v9.2/${set}?$top=250&$select=${set.slice(0, -1)}id`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=250' },
      });
      if (!res.ok) {
        console.log(`${set}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { value?: unknown[]; '@odata.nextLink'?: string };
      const count = json.value?.length ?? 0;
      const hasMore = !!json['@odata.nextLink'];
      console.log(`${set}: ${count}${hasMore ? '+' : ''} rows`);
    } catch (e) {
      console.log(`${set}: ERROR ${(e as Error).message}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e.message); process.exit(0); });
