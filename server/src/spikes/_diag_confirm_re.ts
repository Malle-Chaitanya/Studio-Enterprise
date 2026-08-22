/** Do the two Reasoning Engines this run created actually exist? Deployment "via ADK" means an
 *  RE was built and registered; the claim is only as good as the resource answering. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const t = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
// The pairs are "what the RUN said this engine is" -> engine id. If displayName disagrees,
// the id recorded against the agent belongs to a different deploy.
for (const [name, re] of [
  ['Hubspot agentt (per run log)', '6162535624533344256'],
  ['Email Manager (per run log)', '5444211483967750144'],
]) {
  const url = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/231705905417/locations/us-central1/reasoningEngines/${re}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  const j = (await r.json()) as Record<string, any>;
  console.log(`${name.padEnd(20)} ${re}  GET ${r.status}  displayName="${j.displayName ?? '-'}"  created=${String(j.createTime ?? '-').slice(0, 19)}`);
  const specKeys = Object.keys(j.spec ?? {});
  console.log(`  spec: ${specKeys.join(', ') || '(none)'}  class=${j.spec?.classMethods?.length ?? 0} method(s)`);
}
process.exit(0);
