/**
 * Option B probe: does Discovery Engine's workspace-datastore search accept a
 * DWD-impersonated token (real user identity via subject claim) where a bare
 * service-account token gets 403 "Search using service account credentials
 * is not supported for workspace datastores"? Read-only — no deploy, no
 * mutation. If this works, ADK agents can keep genuine per-user ACL-aware
 * search instead of falling back to the flattened live-tool identity model.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'erik-googledrive_1786356561493_google_drive';
const IMPERSONATE = 'erik@filefuze.co';
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection`;

async function main() {
  let token: string;
  try {
    token = await getSaToken(IMPERSONATE);
  } catch (e) {
    console.error('IMPERSONATION MINT FAILED:', (e as Error).message);
    return;
  }
  console.log('minted impersonated token for', IMPERSONATE, '(length', token.length, ')');

  const res = await fetch(`${BASE}/dataStores/${DATA_STORE_ID}/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'ABCD', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  console.log('\nsearch status:', res.status);
  console.log((await res.text()).slice(0, 3000));
}
main().catch((e) => console.error('FAILED:', e.message));
