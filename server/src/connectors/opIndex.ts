/**
 * Load the captured operation index for a connector.
 *
 * The indexes are committed JSON (`fixtures/<connectorId>.ops.json`), captured from the
 * live Power Apps swagger by `spikes/_dump_connector_op_index.ts`. They are read from disk
 * rather than imported so that adding a connector is a data change: drop the file in, no
 * code edit, no rebuild of an import map.
 *
 * A missing index is a normal outcome, not an error — it means "we have not captured this
 * connector yet", which the caller reports as such. Throwing here would turn an unknown
 * connector into a failed migration.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import type { ConnectorOpIndex } from './operationBinding.js';

// Resolved from this module's own location so it works under `tsx` (src/) and after a
// build (dist/) without a cwd assumption — the server is started from several places.
const FIXTURE_DIRS = [
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  join(process.cwd(), 'src', 'connectors', 'fixtures'),
];

const cache = new Map<string, ConnectorOpIndex | null>();

function fixturePath(connectorId: string): string | undefined {
  for (const dir of FIXTURE_DIRS) {
    const p = join(dir, `${connectorId}.ops.json`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** The captured index, or undefined when this connector has never been captured. */
export function loadOpIndex(connectorId: string): ConnectorOpIndex | undefined {
  // Reject anything that could escape the fixtures directory: connector ids arrive from
  // Dataverse payloads, which are customer-controlled input.
  if (!/^[a-z0-9_]+$/i.test(connectorId)) return undefined;
  if (cache.has(connectorId)) return cache.get(connectorId) ?? undefined;

  const p = fixturePath(connectorId);
  if (!p) {
    cache.set(connectorId, null);
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ConnectorOpIndex;
    cache.set(connectorId, parsed);
    return parsed;
  } catch (err) {
    // A corrupt fixture must not take the migration down with it.
    logger.warn({ connectorId, err: (err as Error).message }, 'connector op index unreadable');
    cache.set(connectorId, null);
    return undefined;
  }
}

/** Which connectors we hold an index for — used by diagnostics and the coverage report. */
export function capturedConnectorIds(): string[] {
  for (const dir of FIXTURE_DIRS) {
    if (!existsSync(dir)) continue;
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ops.json'))
      .map((f) => f.replace(/\.ops\.json$/, ''))
      .sort();
  }
  return [];
}
