import { clientCredsToken } from '../auth/microsoft.js';

const TENANT = process.env.MS_TENANT_ID || '807d6772-847c-40e2-9bec-e2c930b3a42e';
const token = await clientCredsToken(TENANT, 'https://graph.microsoft.com');

// Does the app-only token actually carry the mail application permissions? The `roles`
// claim is ground truth -- delegated permissions never appear here.
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
console.log('token roles:', (claims.roles || []).sort().join(', ') || '(none)');
console.log('appid      :', claims.appid || claims.azp);
console.log();

for (const who of ['erik@filefuze.com', 'erik@filefuze.co']) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(who)}?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.text();
  console.log(who.padEnd(22), r.status, body.slice(0, 150).replace(/\s+/g, ' '));
}
