/** Which Atlassian account does CONFLUENCE_TOKEN belong to? Try each candidate email.
 *  npx tsx src/spikes/_diag_cf_whoami.ts a@b.com c@d.com */
import 'dotenv/config';
const BASE = process.env.CONFLUENCE_BASE_URL!, TOKEN = process.env.CONFLUENCE_TOKEN!;
for (const email of process.argv.slice(2)) {
  const auth = 'Basic ' + Buffer.from(`${email}:${TOKEN}`, 'utf-8').toString('base64');
  const r = await fetch(`${BASE}/wiki/rest/api/user/current`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const t = await r.text();
  let who = '';
  try { who = (JSON.parse(t) as { displayName?: string }).displayName ?? ''; } catch { who = t.replace(/\s+/g, ' ').slice(0, 90); }
  console.log(`[${r.status}] ${email.padEnd(34)} ${who}`);
}
