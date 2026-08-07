/** Why did the documentProcessingConfig PATCH 400? Try each piece separately to find
 *  which field the API rejects. Read-mostly (patches config, not data).
 *  npx tsx src/spikes/_diag_parsing_config_patch.ts <dataStoreId> */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const DS = process.argv[2] ?? 'ee2ea155-208c-f111-ab0f-0022480a981d-sharepoint';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/dataStores/${DS}/documentProcessingConfig`;

const attempts: Array<[string, string, unknown]> = [
  ['parsing only, masked', 'defaultParsingConfig',
    { defaultParsingConfig: { layoutParsingConfig: { enableTableAnnotation: true, enableImageAnnotation: true } } }],
  ['chunking only, masked', 'chunkingConfig',
    { chunkingConfig: { layoutBasedChunkingConfig: { chunkSize: 500 } } }],
  ['parsing, no annotations', 'defaultParsingConfig',
    { defaultParsingConfig: { layoutParsingConfig: {} } }],
  ['ocr for pdf override', 'parsingConfigOverrides',
    { parsingConfigOverrides: { pdf: { layoutParsingConfig: {} } } }],
  ['no updateMask at all', '',
    { defaultParsingConfig: { layoutParsingConfig: { enableTableAnnotation: true, enableImageAnnotation: true } } }],
];

for (const [label, mask, body] of attempts) {
  const r = await fetch(mask ? `${url}?updateMask=${mask}` : url, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  const t = (await r.text()).replace(/\s+/g, ' ');
  console.log(`\n[${r.status}] ${label}`);
  console.log(`  ${t.slice(0, 300)}`);
}
