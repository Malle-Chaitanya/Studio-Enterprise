/**
 * After a redeploy, is the PREVIOUS Reasoning Engine still alive?
 *
 * Redeploy repoints the same gallery agent at a fresh engine. Engines are billed whether or
 * not anything points at them, so if the old one survives, every re-migration leaves a paid
 * orphan behind — which is what "81 of 86 engines had no owning record" looks like from the
 * outside (adkDeployer.ts:514).
 *
 * Read-only: one GET per engine. Deletes nothing.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const LOC = 'us-central1';
const ENGINES = process.argv.slice(2);
const token = await getSaToken();
for (const id of ENGINES) {
  const name = `projects/${PROJECT}/locations/${LOC}/reasoningEngines/${id}`;
  const res = await fetch(`https://${LOC}-aiplatform.googleapis.com/v1beta1/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = res.ok ? ((await res.json()) as { displayName?: string; createTime?: string }) : null;
  console.log(`  ${id}  HTTP ${res.status}  ${res.ok ? `ALIVE — "${body?.displayName ?? '?'}" created ${body?.createTime ?? '?'}` : 'gone'}`);
}
process.exit(0);
