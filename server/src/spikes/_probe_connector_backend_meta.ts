/** Does Microsoft PUBLISH the connector->vendor relationship anywhere machine-readable?
 *  Dumps the non-swagger metadata on a shared connector's definition, looking for policies,
 *  backend hosts, or anything that states the real call. Schema only. Throwaway. */
import 'dotenv/config';
import { clientCredsToken } from '../auth/microsoft.js';
import { POWERAPPS_AUDIENCE } from '../connectors/captureOpIndex.js';

const cid = process.env.CSGE_CONNECTORS ?? 'shared_googledrive';
const token = await clientCredsToken(process.env.CSGE_TENANT_ID!, POWERAPPS_AUDIENCE);
const res = await fetch(
  `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${encodeURIComponent(cid)}?api-version=2016-11-01&$filter=environment eq '${process.env.CSGE_ENVIRONMENT_ID}'`,
  { headers: { Authorization: `Bearer ${token}` } },
);
console.log('HTTP', res.status);
const body = (await res.json()) as any;
const props = body.properties ?? {};
console.log('\n--- top-level property keys ---');
console.log(Object.keys(props).sort().join(', '));

for (const k of ['policyTemplateInstances', 'backendService', 'apiDefinitions', 'runtimeUrls', 'primaryRuntimeUrl', 'metadata', 'capabilities', 'connectionParameters']) {
  if (props[k] === undefined) continue;
  const v = JSON.stringify(props[k], null, 1);
  console.log(`\n--- ${k} (${v.length} chars) ---`);
  console.log(v.length > 1800 ? v.slice(0, 1800) + '\n  ...truncated' : v);
}

// The swagger's own extension points are the other candidate.
const sw = props.swagger ?? {};
const exts = new Set<string>();
const walk = (n: any) => {
  if (!n || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) { if (k.startsWith('x-ms-')) exts.add(k); walk(v); }
};
walk(sw);
console.log('\n--- x-ms-* extensions present in the swagger ---');
console.log([...exts].sort().join('\n') || '(none)');
process.exit(0);
