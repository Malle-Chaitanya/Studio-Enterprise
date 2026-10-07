import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { VendorApiSurface } from '../../connectors/operationBinding.js';

/**
 * A vendor's own published API description — Google's Discovery document today, an OpenAPI
 * document for the other vendors later — plus which connectors were resolved to it.
 *
 * NOT MIGRATION-SCOPED, AND DELIBERATELY SO. Every other cache in this directory is keyed by
 * `appUserId` or by a credential scope, because it holds something belonging to one customer:
 * which connectors they installed, what their agents look like, what they ran. This holds the
 * vendor's public catalogue of its own API. It is identical for every tenant, contains
 * nothing a customer gave us, and is fetched from a public endpoint with no credential.
 * Keying it per customer would re-fetch the same public document once per tenant and store N
 * identical copies.
 *
 * The rule it must not break: nothing customer-derived may ever be written here. The only
 * writer is `connectors/vendorSpec.ts`, and the only things it writes are a response from the
 * vendor's documentation endpoint and the connector ids that resolved to it. A connector id
 * is a Microsoft catalogue identifier (`shared_googledrive`), not customer data — but a
 * CUSTOM connector's id is derived from a customer's own display name, so those are excluded
 * at the writer, not here. See `isSharedConnectorId` in vendorSpec.ts.
 *
 * Collection: vendorApiSurfaces.
 */

const COLL = 'vendorApiSurfaces';

interface CachedSurface {
  /** Discovery api name — `calendar`, `people`, `tasks`. The cache key. */
  api: string;
  surface: VendorApiSurface;
  fetchedAt: Date;
  /**
   * First-party connector ids proven to resolve to this API, so the resolution is done once
   * ever rather than once per process. Only ids that passed path verification land here.
   */
  resolvedFor?: string[];
}

/**
 * The cached surface for an API.
 *
 * `maxAgeMs` of `Number.POSITIVE_INFINITY` asks for the row at any age. That is the
 * stale-on-error path: a surface a month past its refresh is still a far better answer than
 * refusing every operation because the vendor's documentation host happened to be down, and
 * APIs do not vanish between one fetch and the next.
 */
export async function getCachedVendorSurface(
  api: string,
  maxAgeMs: number,
): Promise<VendorApiSurface | null> {
  if (!isDbConnected()) return null;
  try {
    const row = await getDb(config.CSGE_DB).collection<CachedSurface>(COLL).findOne({ api });
    if (!row) return null;
    if (Number.isFinite(maxAgeMs) && Date.now() - new Date(row.fetchedAt).getTime() > maxAgeMs) return null;
    return row.surface;
  } catch (e) {
    logger.warn(`getCachedVendorSurface read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Which API a connector was previously proven to map to, or null. Skips candidate
 *  generation and its fetches entirely on every run after the first. */
export async function getResolvedApiFor(connectorId: string): Promise<string | null> {
  if (!isDbConnected()) return null;
  try {
    const row = await getDb(config.CSGE_DB)
      .collection<CachedSurface>(COLL)
      .findOne({ resolvedFor: connectorId }, { projection: { api: 1 } });
    return row?.api ?? null;
  } catch (e) {
    logger.warn(`getResolvedApiFor read failed: ${(e as Error).message}`);
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

/** Record that `connectorId` verified against `api`. `$addToSet` so a re-resolution is
 *  idempotent and two migrations racing cannot duplicate the id. */
export async function recordResolvedApi(api: string, connectorId: string): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<CachedSurface>(COLL)
      .updateOne({ api }, { $addToSet: { resolvedFor: connectorId } });
  } catch (e) {
    logger.warn(`recordResolvedApi persist failed: ${(e as Error).message}`);
  }
}
