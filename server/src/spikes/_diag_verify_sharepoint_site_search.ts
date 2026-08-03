import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { searchSharePointSiteForFile } from '../services/graphSearch.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  const graphToken = await clientCredsToken(s.tenantId ?? '', 'https://graph.microsoft.com');

  // Discover real SharePoint sites in this tenant (app-only, same token as
  // everything else — no new permission grant).
  const sitesRes = await fetch(`${GRAPH}/sites?search=*&$top=25`, {
    headers: { Authorization: `Bearer ${graphToken}` },
  });
  if (!sitesRes.ok) {
    console.log(`sites search failed: ${sitesRes.status} ${await sitesRes.text()}`);
    process.exit(1);
  }
  const sitesJson = (await sitesRes.json()) as { value?: { id?: string; displayName?: string; webUrl?: string }[] };
  const sites = sitesJson.value ?? [];
  console.log(`Found ${sites.length} SharePoint site(s):`);
  for (const site of sites) console.log(`  - ${site.displayName}  (${site.webUrl})  id=${site.id}`);

  if (!sites.length) {
    console.log('\nNo SharePoint sites discoverable in this tenant — cannot test site search live.');
    process.exit(0);
  }

  // Try a broad, generic term across each real site's default drive to prove
  // the drive-lookup + search mechanics actually work against SharePoint
  // (not just OneDrive) — not testing for a SPECIFIC known file.
  for (const site of sites) {
    if (!site.id) continue;
    console.log(`\n--- searching site "${site.displayName}" for "docx" ---`);
    const hits = await searchSharePointSiteForFile(graphToken, site.id, 'docx');
    console.log(`  -> ${hits.length} hit(s)`);
    for (const h of hits.slice(0, 5)) {
      console.log(`     - "${h.name}" (${h.sizeBytes ?? '?'} bytes) context=${h.parentContext}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
