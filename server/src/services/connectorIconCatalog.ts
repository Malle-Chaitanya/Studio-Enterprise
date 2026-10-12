import { clientCredsToken } from '../auth/microsoft.js';
import { POWERAPPS_AUDIENCE } from '../connectors/captureOpIndex.js';
import { logger } from '../logger.js';
import {
  putIconCatalog,
  readIconCatalog,
  type ConnectorIconEntry,
} from '../db/repos/connectorIcons.js';

/**
 * Official connector icons, read from the cache and refreshed OFF the request path.
 *
 * The rule this module exists to keep: looking up an icon must never make a page slower.
 * An icon is decoration — a connector with none still configures and migrates identically,
 * and the UI already degrades through a traced mark to a tinted initials tile. So the
 * read is a single indexed `findOne` and nothing here is ever awaited for the network.
 * When the cache is missing or stale the refresh is fired and dropped; the request that
 * noticed is served from whatever was already there (possibly nothing), and the NEXT load
 * has the icons. That is why `iconsFor` has no fetching branch at all.
 *
 * Why one list call and not one call per connector: the Connectors step shows every
 * connector an agent uses, and capturing them individually would be N round trips on a
 * screen the prod logs already show being hit ten times per visit. The catalog list
 * returns all ~1300 in one request, so the refresh costs exactly one call per environment
 * per day no matter how many connectors are on screen.
 */

/** A day. Microsoft re-pins these urls on connector releases, not hourly. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Refreshes already running, by `scope|environmentId`.
 *
 * Without this the ten repeat loads of the Connectors step the prod logs show would each
 * start their own catalog fetch against Microsoft — ten identical calls racing to write
 * the same document.
 */
const inFlight = new Set<string>();

export interface IconCatalogCtx {
  tenantId: string;
  environmentId: string;
  scope: string;
}

/**
 * The icons we already hold for this environment. Cheap, cacheable, and safe to call on
 * every request: one projected `findOne`, no network, `{}` on anything unexpected.
 *
 * Deliberately returns a stale catalog rather than nothing. A url that Microsoft has since
 * re-pinned 404s in the browser, and `ConnectorMark`'s `onError` drops to the same mark it
 * would have shown anyway — strictly better than blanking every icon the moment a cache
 * passes its TTL.
 */
export async function iconsFor(ctx: IconCatalogCtx): Promise<Record<string, ConnectorIconEntry>> {
  // The repo already swallows its own errors, so this catch is for the case it cannot
  // cover: the read rejecting before its try block is reached, or a future caller wiring
  // a different store in. `iconsFor` promises it never throws, and the caller is a request
  // handler that must not 500 over an icon — the promise has to hold here, not upstream.
  let cached: Awaited<ReturnType<typeof readIconCatalog>> = null;
  try {
    cached = await readIconCatalog(ctx.scope, ctx.environmentId);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'icon catalog read failed — serving no icons');
    return {};
  }
  const stale = !cached || Date.now() - cached.capturedAt.getTime() > TTL_MS;
  if (stale) void refreshIconCatalog(ctx);
  return cached?.icons ?? {};
}

/**
 * Fetch the environment's connector catalog and store every icon it states.
 *
 * Read-only against Power Apps, app-only token, the same audience `captureOpIndex` already
 * mints for. Never throws: a failure here must leave the UI exactly as it was, not break a
 * screen over decoration.
 */
export async function refreshIconCatalog(ctx: IconCatalogCtx): Promise<void> {
  const key = `${ctx.scope}|${ctx.environmentId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const token = await clientCredsToken(ctx.tenantId, POWERAPPS_AUDIENCE);
    const url =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/apis` +
      `?api-version=2016-11-01&$filter=${encodeURIComponent(`environment eq '${ctx.environmentId}'`)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      logger.debug({ status: res.status }, 'connector icon catalog unavailable');
      return;
    }
    const rows = ((await res.json()) as {
      value?: Array<{ name?: string; properties?: { iconUri?: unknown; iconBrandColor?: unknown } }>;
    }).value ?? [];

    const icons: Record<string, ConnectorIconEntry> = {};
    for (const row of rows) {
      const id = typeof row.name === 'string' ? row.name : '';
      const uri = row.properties?.iconUri;
      if (!id || typeof uri !== 'string' || !uri) continue;
      // https only. The url is handed straight to the browser as an <img src>, and this is
      // the one place to refuse anything that is not a plain remote image — the catalog is
      // Microsoft's, but it is still a remote document we did not write.
      if (!uri.startsWith('https://')) continue;
      const brand = row.properties?.iconBrandColor;
      icons[id] = {
        uri,
        brand: typeof brand === 'string' && brand ? brand : undefined,
      };
    }
    if (!Object.keys(icons).length) return;
    await putIconCatalog(ctx.scope, ctx.environmentId, icons);
    logger.info({ environmentId: ctx.environmentId, icons: Object.keys(icons).length },
      'refreshed official connector icon catalog');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'connector icon catalog refresh failed');
  } finally {
    inFlight.delete(key);
  }
}
