/** Dump the FULL config of the ACL-enabled sharepoint connector so we can see exactly
 *  which fields flip ACL mode on, and read its WARNING state. Read-only.
 *  npx tsx src/spikes/_diag_acl_connector_config.ts [collectionId] */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const COL = process.argv[2] ?? 'connectortest_1785961359928';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}` };

const r = await fetch(`${HOST}/projects/${P}/locations/global/collections/${COL}/dataConnector`, { headers: h });
const j = await r.json() as Record<string, any>;
console.log(`=== ${COL} dataConnector [${r.status}] ===`);
// params often carry the auth/site config; redact anything secret-looking.
const redact = (o: any): any => {
  if (typeof o === 'string') return /secret|password|token|key/i.test(o) ? '<redacted>' : o;
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === 'object') {
    const out: Record<string, any> = {};
    for (const [k2, v] of Object.entries(o)) {
      out[k2] = /secret|password|client_secret|token/i.test(k2) ? '<redacted>' : redact(v);
    }
    return out;
  }
  return o;
};
console.log(JSON.stringify(redact(j), null, 2).slice(0, 4000));
