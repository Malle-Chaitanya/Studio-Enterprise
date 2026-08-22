/**
 * Does one app-only Microsoft credential really reach ANY user, or does the configured
 * `impersonate_email` have privileges of its own?
 *
 * The distinction matters and is easy to get backwards. Google DWD genuinely IMPERSONATES: the
 * service account acts as a person and needs delegation authorised for that scope. Microsoft
 * app-only does NOT impersonate — the app holds tenant-wide APPLICATION permissions, and the
 * email is just a path segment (`/users/{upn}/...`). So the email is a POINTER, not a
 * credential, and it does not need to be an admin.
 *
 * Proof: read the tenant's users with the app credential, then call joinedTeams for a user who
 * is NOT the configured one. Read-only throughout; no secret is printed.
 *
 *   cd server && npx tsx src/spikes/_diag_ms_any_user.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const db = getDb();
const row = (await db.collection('connectorCredentials').findOne({ connectorId: 'shared_teams' })) as Record<string, any> | null;
if (!row) throw new Error('no shared_teams credential recorded');
const project = String(row.project ?? '231705905417');
const saToken = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);

async function secret(field: string): Promise<string> {
  const id = (row!.secretIds ?? {})[field];
  if (!id) throw new Error(`no secret id recorded for ${field}`);
  const got = await getEntraSecret(saToken, `projects/${project}/secrets/${id}/versions/latest`);
  if (!got.ok || !got.plaintext) throw new Error(`could not read ${field}`);
  return got.plaintext.trim();
}
const [tenant, clientId, clientSecret] = await Promise.all([secret('tenant_id'), secret('client_id'), secret('client_secret')]);
const configured = await secret('impersonate_email').catch(() => '(none)');

// App-only token: no user involved at all.
const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }),
});
const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
if (!token) throw new Error('client_credentials token failed');
console.log(`app-only token minted (no user in the exchange). configured identity = ${configured}\n`);

const graph = async (p: string) => {
  const r = await fetch(`https://graph.microsoft.com/v1.0${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const users = await graph('/users?$top=8&$select=userPrincipalName,displayName');
const list = (users.body.value ?? []) as Array<Record<string, string>>;
console.log(`GET /users -> ${users.status}, ${list.length} shown:`);
for (const u of list) console.log(`   ${u.userPrincipalName}  (${u.displayName})`);

// Now read TEAMS for users other than the configured one.
const others = list.map((u) => u.userPrincipalName).filter((u) => u && u.toLowerCase() !== configured.toLowerCase()).slice(0, 3);
console.log(`\njoinedTeams for users OTHER than the configured identity:`);
for (const upn of others) {
  const r = await graph(`/users/${encodeURIComponent(upn)}/joinedTeams`);
  const n = ((r.body.value ?? []) as unknown[]).length;
  const err = r.status === 200 ? '' : ` ${String(r.body?.error?.message ?? '').slice(0, 110)}`;
  console.log(`   ${upn.padEnd(34)} HTTP ${r.status}  teams=${r.status === 200 ? n : '-'}${err}`);
}
process.exit(0);
