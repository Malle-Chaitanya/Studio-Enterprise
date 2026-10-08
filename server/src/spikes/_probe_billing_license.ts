/** Billing + Gemini Enterprise license state for a project. Read-only.
 *  A "Lightning dunning" denial is a BILLING enforcement, so this separates
 *  "billing is off/closed" from "seats are not assigned". */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = process.env.PROJ || 'agentmigrations';
const ENGINE = process.env.ENGINE || 'gemini-enterprise-app_1787446545912';
const token = await getSaToken();
const h = { Authorization: `Bearer ${token}` };
const show = async (label: string, url: string) => {
  const r = await fetch(url, { headers: h });
  const t = await r.text();
  console.log(`\n## ${label}  HTTP ${r.status}`);
  console.log(t.replace(/\s+/g, ' ').slice(0, 700));
  return { ok: r.ok, t };
};

const bi = await show('billingInfo', `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`);
const acct = /"billingAccountName":\s*"([^"]+)"/.exec(bi.t)?.[1];
if (acct) await show('billingAccount', `https://cloudbilling.googleapis.com/v1/${acct}`);

const P = process.env.PROJNUM || '505103737920';
await show(
  'license configs',
  `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/licenseConfigs`,
);
await show(
  'user licenses (first page)',
  `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/userStores/default_user_store/userLicenses?pageSize=5`,
);
process.exit(0);
