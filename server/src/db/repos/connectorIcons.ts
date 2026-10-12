import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Microsoft's own official connector icons, cached per environment.
 *
 * Every connector in the Power Platform catalog carries `properties.iconUri` — measured
 * 2026-10-12 across a live environment: 1309 of 1309 (100%) have one, 1272 (97.2%) also
 * carry `iconBrandColor`. That is the authoritative art for first-party AND third-party
 * connectors alike, and it is the only source that covers connectors nobody has ever seen.
 * `registry.ts` has declared an `iconUrl` field for exactly this since it was written and
 * not one of its 49 entries ever filled it, so every tile fell through to a hand-traced
 * mark or a two-letter tile — including several that were visibly the wrong brand.
 *
 * ONE DOCUMENT PER ENVIRONMENT, not one per connector. The whole catalog arrives in a
 * single list call, so splitting it into 1300 rows would turn one write into 1300 and one
 * read into an `$in` over a collection that only ever gets read whole. At roughly 130 bytes
 * an entry the document lands near 170KB, well inside Mongo's 16MB limit.
 *
 * SCOPE: keyed by `{scope, environmentId}`, the same pairing `connectorOpIndexes` uses.
 * Which connectors a customer has installed is their business, not another customer's.
 *
 * Collection: connectorIconCatalog.
 */

const COLL = 'connectorIconCatalog';

export interface ConnectorIconEntry {
  /** Microsoft's own CDN url for the connector's icon. */
  uri: string;
  /** `iconBrandColor`, when the catalog states one — absent on ~3% of connectors. */
  brand?: string;
}

export interface CachedIconCatalog {
  scope: string;
  environmentId: string;
  icons: Record<string, ConnectorIconEntry>;
  capturedAt: Date;
}

/**
 * Read the cached catalog. Never fetches, never throws, never blocks on the network — the
 * caller is on a request path and an icon is decoration. A miss returns `null` and the UI
 * keeps the fallback chain it has always had.
 */
export async function readIconCatalog(
  scope: string,
  environmentId: string,
): Promise<{ icons: Record<string, ConnectorIconEntry>; capturedAt: Date } | null> {
  if (!isDbConnected()) return null;
  try {
    const row = await getDb(config.CSGE_DB)
      .collection<CachedIconCatalog>(COLL)
      .findOne({ scope, environmentId }, { projection: { icons: 1, capturedAt: 1 } });
    if (!row?.icons) return null;
    return { icons: row.icons, capturedAt: new Date(row.capturedAt) };
  } catch (e) {
    logger.warn(`readIconCatalog failed: ${(e as Error).message}`);
    return null;
  }
}

export async function putIconCatalog(
  scope: string,
  environmentId: string,
  icons: Record<string, ConnectorIconEntry>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<CachedIconCatalog>(COLL)
      .updateOne(
        { scope, environmentId },
        { $set: { scope, environmentId, icons, capturedAt: new Date() } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putIconCatalog persist failed: ${(e as Error).message}`);
  }
}
