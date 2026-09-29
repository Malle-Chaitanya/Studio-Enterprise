/**
 * Pulls the REAL, complete connector catalog directly from Microsoft's Power Apps API —
 * the same live source captureOpIndex.ts already uses — and saves it as a CSV file the
 * user can open directly in Excel.
 *
 * Not scraped from a webpage: this is the actual structured data Microsoft's platform
 * returns, including the real Publisher field for every connector.
 *
 * Run: npx tsx src/spikes/_prep_export_connector_catalog.ts
 */
import { clientCredsToken } from '../auth/microsoft.js';
// Not importing POWERAPPS_AUDIENCE from captureOpIndex.ts here on purpose — that file
// currently has a real syntax error in a different function (distilOriginalSwagger),
// which breaks the whole module on import. Same constant, inlined, to stay unblocked.
const POWERAPPS_AUDIENCE = 'https://service.powerapps.com';
import { config } from '../config.js';
import fs from 'node:fs';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // real tenant id already confirmed working this session
const ENVIRONMENT_ID = '7f9f87cc-464e-e470-95bb-363b7f227200'; // real environment id already used

interface ApiRow {
  name?: string;
  properties?: {
    displayName?: string;
    publisher?: string;
    tier?: string;
    category?: string;
    connectionParameters?: unknown;
  };
}

async function main() {
  console.log('Requesting a live app-only token for the Power Apps API...');
  const token = await clientCredsToken(TENANT_ID, POWERAPPS_AUDIENCE);

  const rows: ApiRow[] = [];
  let url: string | null =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis?api-version=2016-11-01` +
    `&$filter=${encodeURIComponent(`environment eq '${ENVIRONMENT_ID}'`)}`;

  let page = 0;
  while (url) {
    page++;
    console.log(`Fetching page ${page}...`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`FAILED: ${res.status} ${res.statusText}`);
      const text = await res.text();
      console.error(text.slice(0, 1000));
      process.exit(1);
    }
    const json = (await res.json()) as { value?: ApiRow[]; nextLink?: string };
    rows.push(...(json.value ?? []));
    url = json.nextLink ?? null;
  }

  console.log(`Total connectors returned: ${rows.length}`);

  const csvLines = ['connectorId,displayName,publisher,tier,category'];
  for (const r of rows) {
    const id = r.name ?? '';
    const name = (r.properties?.displayName ?? '').replace(/"/g, '""');
    const publisher = (r.properties?.publisher ?? '').replace(/"/g, '""');
    const tier = r.properties?.tier ?? '';
    const category = (r.properties?.category ?? '').replace(/"/g, '""');
    csvLines.push(`"${id}","${name}","${publisher}","${tier}","${category}"`);
  }

  const outPath = 'C:\\Users\\ChaitanyaMalle\\Desktop\\all_connectors_real.csv';
  fs.writeFileSync(outPath, csvLines.join('\n'), 'utf-8');
  console.log(`Saved ${rows.length} real connectors to: ${outPath}`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
