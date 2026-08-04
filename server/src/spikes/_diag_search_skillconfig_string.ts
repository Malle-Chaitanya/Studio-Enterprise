import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const OWNER_EMAIL = 'erik@filefuze.co'; // resolved earlier for these same sources

const SKILL_CONFIGS = [
  'TestingPermissions_3XBDJPyZ3T4MgfrMTwiYX',
  'Dump_docx_2docx_eM8L619TTVnoiUAd4MPz4',
  'daily_queriestxt_ZEHQ13QHyGoE_iNOUiCtg',
];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  const graphToken = await clientCredsToken(s.tenantId ?? '', 'https://graph.microsoft.com');

  for (const query of SKILL_CONFIGS) {
    console.log(`\n=== searching OneDrive (${OWNER_EMAIL}) for literal skillConfiguration string: "${query}" ===`);
    const res = await fetch(
      `${GRAPH}/users/${encodeURIComponent(OWNER_EMAIL)}/drive/root/search(q='${encodeURIComponent(query)}')` +
        `?$select=id,name,size,file,webUrl&$top=10`,
      { headers: { Authorization: `Bearer ${graphToken}` } },
    );
    if (!res.ok) {
      console.log(`  search failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    const json = (await res.json()) as { value?: { name?: string }[] };
    console.log(`  results: ${json.value?.length ?? 0}`);
    for (const hit of json.value ?? []) console.log(`    - ${hit.name}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
