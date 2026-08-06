/**
 * Verify Atlassian API credentials and list accessible Confluence spaces.
 * Usage: cd server && npx tsx src/spikes/_diag_confluence_creds.ts
 */

const EMAIL = 'sujana.manapuram@cloudfuze.com';
const API_TOKEN = process.env.CONFLUENCE_TOKEN ?? '';
const CANDIDATE_URLS = [
  'https://aicloudfuze.atlassian.net',
];

if (!API_TOKEN) {
  console.error('Set CONFLUENCE_TOKEN env var');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${EMAIL}:${API_TOKEN}`, 'utf-8').toString('base64');

async function probe(baseUrl: string) {
  console.log(`\nProbing ${baseUrl} …`);

  // 1. Current user
  const me = await fetch(`${baseUrl}/wiki/rest/api/user/current`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!me.ok) {
    console.log(`  ✗ auth failed (${me.status}): ${(await me.text()).slice(0, 200)}`);
    return false;
  }
  const user = await me.json() as { displayName?: string; accountId?: string };
  console.log(`  ✓ authenticated as: ${user.displayName} (${user.accountId})`);

  // 2. List spaces
  const spaces = await fetch(`${baseUrl}/wiki/rest/api/space?limit=50&type=global&status=current`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!spaces.ok) {
    console.log(`  ✗ spaces failed (${spaces.status})`);
    return true;
  }
  const spacesJson = await spaces.json() as { results?: { key: string; name: string; type: string }[] };
  console.log(`  ✓ accessible spaces (${spacesJson.results?.length ?? 0}):`);
  for (const s of spacesJson.results ?? []) {
    console.log(`      ${s.key.padEnd(20)} "${s.name}"`);
  }

  // 3. CQL test — search for pages in specific space names
  const targetSpaces = ['Engineering', 'Operations', 'Demo Company Wiki'];
  const quoted = targetSpaces.map((n) => `"${n}"`).join(',');
  const cql = `space.title in (${quoted}) AND type=page AND status=current`;
  const search = await fetch(
    `${baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=10`,
    { headers: { Authorization: auth, Accept: 'application/json' } },
  );
  if (search.ok) {
    const r = await search.json() as { results?: { title: string; space?: { name?: string } }[]; size?: number };
    console.log(`\n  CQL "${cql.slice(0, 80)}…"`);
    console.log(`  → ${r.size ?? r.results?.length ?? 0} page(s) found`);
    for (const p of (r.results ?? []).slice(0, 5)) {
      console.log(`      [${p.space?.name}] ${p.title}`);
    }
  }

  return true;
}

(async () => {
  let found = false;
  for (const url of CANDIDATE_URLS) {
    const ok = await probe(url);
    if (ok) { found = true; console.log(`\n✓ Use base_url: ${url}`); break; }
  }
  if (!found) console.log('\n✗ None of the candidate URLs worked. Provide the correct Atlassian domain.');
  process.exit(0);
})();
