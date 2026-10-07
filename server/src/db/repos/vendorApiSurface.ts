import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { VendorApiSurface } from '../../connectors/operationBinding.js';

/**
 * A vendor's own published API description — Google's Discovery document today, an OpenAPI
 * document for the other vendors later.
 *
 * NOT MIGRATION-SCOPED, AND DELIBERATELY SO. Every other cache in this directory is keyed by
 * `appUserId` or by a credential scope, because it holds something that belongs to one
 * customer: which connectors they installed, what their agents look like, what they ran.
 * This holds Google's public catalogue of its own API. It is identical for every tenant,
 * contains nothing a customer gave us, and is fetched from a public endpoint with no
 * credential at all. Keying it per customer would mean re-fetching the same public document
 * once per tenant and storing N identical copies.
 *
 * The rule it must not break: nothing customer-derived may ever be written here. The only
 * writer is `services/vendorSpec.ts`, and the only thing it writes is a response from the
 * vendor's own documentation endpoint.
 *
 * Collection: vendorApiSurfaces.
 */

const COLL = 'vendorApiSurfaces';

interface CachedSurface {
  /** Discovery api name — `calendar`, `people`, `tasks`. The cache key. */
  api: string;
  surface: VendorApiSurface;
  fetchedAt: Date;
}

export async function getCachedVendorSurface(
  api: string,
  maxAgeMs: number,
): Promise<VendorApiSurface | null> {
  if (!isDbConnected()) return null;
  try {
    const row = await getDb(config.CSGE_DB).collection<CachedSurface>(COLL).findOne({ api });
    if (!row) return null;
    // A stale surface is worse than none here, in one specific direction: a method the
    // vendor has since RETIRED would still read as confirmed, which is exactly the
    // false-confidence this whole check exists to remove.
    if (Date.now() - new Date(row.fetchedAt).getTime() > maxAgeMs) return null;
    return row.surface;
  } catch (e) {
    logger.warn(`getCachedVendorSurface read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function putCachedVendorSurface(api: string, surface: VendorApiSurface): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<CachedSurface>(COLL)
      .updateOne({ api }, { $set: { api, surface, fetchedAt: new Date() } }, { upsert: true });
  } catch (e) {
    logger.warn(`putCachedVendorSurface persist failed: ${(e as Error).message}`);
  }
}
