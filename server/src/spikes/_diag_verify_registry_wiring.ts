import { connectDb, closeDb } from '../db/core.js';
import { config } from '../config.js';
import { resolveOpIndex } from '../connectors/captureOpIndex.js';
import { loadFromRegistry } from '../db/repos/connectorRegistry.js';

async function main() {
  await connectDb(config.CSGE_DB);

  console.log('[1/2] Directly testing loadFromRegistry("shared_dropbox")...');
  const direct = await loadFromRegistry('shared_dropbox');
  if (!direct) {
    console.log('FAILED: got undefined');
  } else {
    console.log(`OK: displayName=${direct.displayName}, operationCount=${direct.operationCount}, proxyHost=${direct.proxyHost}`);
    console.log(`Sample operation keys: ${Object.keys(direct.operations).slice(0, 3).join(', ')}`);
  }

  console.log('\n[2/2] Testing resolveOpIndex() with NO ctx (forces it straight to the registry/fixture tiers)...');
  const viaResolve = await resolveOpIndex('shared_dropbox', undefined);
  if (!viaResolve) {
    console.log('FAILED: got undefined');
  } else {
    console.log(`OK: resolveOpIndex found it via the fallback chain — operationCount=${viaResolve.operationCount}`);
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
