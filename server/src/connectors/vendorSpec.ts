/**
 * Fetch what a vendor says its OWN API is, so a binding can be confirmed instead of inferred.
 *
 * WHY. `operationBinding.ts` decides whether a Copilot connector operation maps to a real
 * vendor call by reasoning about the PATH's shape — strip `/{connectionId}`, recognise a
 * dataset abstraction, recognise a polling trigger, assume the rest is the vendor's. Shape
 * cannot distinguish three things that are all live in the catalogue right now:
 *
 *   /users/me/calendarList/1          a Power Platform FILTER convention, not a path. Bound
 *                                     verbatim it returns the calendar whose id is "1" — a
 *                                     wrong answer rather than an error.
 *   /m8/feeds/contacts/default/full   GData. Google retired it in 2022. Perfect shape,
 *                                     nothing behind it.
 *   /eventstarted/calendars/{id}/...  a trigger the hand-written `/^\/trigger\d*\//` regex
 *                                     does not match, because an enumeration of shapes
 *                                     someone has seen is always one shape behind.
 *
 * All three stop being guesses the moment the vendor's own machine-readable API is consulted:
 * a method either is or is not in it.
 *
 * SCOPE TODAY: Google, via the Discovery service. Microsoft Graph, Atlassian, HubSpot and
 * Salesforce all publish OpenAPI, and `VendorApiSurface` is the shape they would reduce to —
 * so adding one is a new loader here, not a change to the binding logic.
 *
 * BEST-EFFORT, ALWAYS. Every failure returns `undefined`, which puts the caller back on the
 * previous shape-based behaviour with `provenance: 'heuristic'`. A vendor's documentation
 * site being down must never fail a customer's migration. The one exception is a binding
 * marked `requireVendorSpec`, which refuses rather than falls back — see that flag.
 */
import { logger } from '../logger.js';
import { GOOGLE_APPS } from './googleCatalog.js';
import { getCachedVendorSurface, putCachedVendorSurface } from '../db/repos/vendorApiSurface.js';
import type { VendorApiMethod, VendorApiSurface } from './operationBinding.js';

/** Google publishes breaking changes with new API versions, not in place, so a month is
 *  safe and keeps a migration from re-fetching the same public document all day. */
const SURFACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DIRECTORY_URL = 'https://discovery.googleapis.com/discovery/v1/apis?preferred=true';
/** The vendor's docs are not on the critical path — fail fast and fall back rather than
 *  hold a migration open waiting for them. */
const FETCH_TIMEOUT_MS = 15_000;

/** In-process memo, so one migration run fetching twenty connectors does not re-read Mongo
 *  twenty times for the same API. Cleared only by a restart, which is the right lifetime for
 *  a document that changes a few times a year. */
const memo = new Map<string, VendorApiSurface | undefined>();
let directory: Map<string, string> | undefined;

async function getJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      logger.debug({ url, status: res.status }, 'vendor API description not available');
      return undefined;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    logger.debug({ url, err: (e as Error).message }, 'vendor API description fetch failed');
    return undefined;
  }
}

/** api name -> its Discovery document URL. Fetched once per process. */
async function discoveryDirectory(): Promise<Map<string, string> | undefined> {
  if (directory) return directory;
  const body = await getJson(DIRECTORY_URL);
  if (!body) return undefined;
  const map = new Map<string, string>();
  for (const item of (body.items as Array<Record<string, unknown>>) ?? []) {
    const name = String(item.name ?? '');
    const url = String(item.discoveryRestUrl ?? '');
    // `preferred=true` already filters to one version per API, so the first entry wins and
    // a later duplicate is never a different version of the same thing.
    if (name && url && !map.has(name)) map.set(name, url);
  }
  directory = map;
  return map;
}

/**
 * Flatten a Discovery document into the methods a binding check compares against.
 *
 * `baseUrl` + a method's `path` IS the full URL, by Discovery's own contract — and only the
 * full URL is comparable, because Google splits the two halves differently per API:
 *
 *   tasks     baseUrl https://tasks.googleapis.com/             path tasks/v1/lists/{tasklist}/tasks
 *   calendar  baseUrl https://www.googleapis.com/calendar/v3/   path calendars/{calendarId}/events
 *
 * Comparing bare paths refuses Google Tasks, which works in production. Methods nest under
 * `resources` (drive.files.list, gmail.users.messages.get), so the walk has to recurse.
 */
function flatten(api: string, doc: Record<string, unknown>): VendorApiSurface {
  const base = String(doc.baseUrl ?? doc.rootUrl ?? '').replace(/\/$/, '');
  const methods: VendorApiMethod[] = [];
  const walk = (node: Record<string, unknown>) => {
    for (const m of Object.values((node.methods ?? {}) as Record<string, Record<string, unknown>>)) {
      // `flatPath` spells out what the templated `path` collapses — `{+name}` and
      // `v1/{name=projects/*/x}` match different things, so prefer the explicit one.
      const path = String(m.flatPath ?? m.path ?? '');
      if (!path) continue;
      methods.push({
        id: String(m.id ?? ''),
        httpMethod: String(m.httpMethod ?? 'GET'),
        url: `${base}/${path.replace(/^\//, '')}`,
      });
    }
    for (const sub of Object.values((node.resources ?? {}) as Record<string, Record<string, unknown>>)) {
      walk(sub);
    }
  };
  walk(doc);
  return { api, methods };
}

/** Which published API a connector's operations should be checked against, or undefined when
 *  we have no description for that vendor and the shape heuristic stays in charge. */
function apiNameFor(connectorId: string): string | undefined {
  return GOOGLE_APPS.find((a) => a.id === connectorId)?.api;
}

/**
 * The vendor's published API for this connector, or `undefined` when there is none to be had.
 *
 * Client-agnostic by construction: nothing here reads a tenant, an environment or a
 * credential. The answer is the same for every customer, which is why it is cached once
 * rather than per migration.
 */
export async function resolveVendorApiSurface(connectorId: string): Promise<VendorApiSurface | undefined> {
  const api = apiNameFor(connectorId);
  if (!api) return undefined;
  if (memo.has(api)) return memo.get(api);

  const cached = await getCachedVendorSurface(api, SURFACE_TTL_MS);
  if (cached) {
    memo.set(api, cached);
    return cached;
  }

  const dir = await discoveryDirectory();
  const docUrl = dir?.get(api);
  if (!docUrl) {
    // Not in Discovery at all. That is itself a finding — the API this connector targets is
    // retired or was never a Google API — but it is reported by the binding, not here:
    // `requireVendorSpec` turns the absence into a named refusal, and without that flag the
    // connector keeps its previous behaviour.
    logger.info({ connectorId, api }, 'vendor publishes no API description for this connector');
    memo.set(api, undefined);
    return undefined;
  }
  const doc = await getJson(docUrl);
  if (!doc) {
    // NOT memoised: a transient fetch failure must not pin this API to "unavailable" for the
    // life of the process, which would silently downgrade every later migration in it.
    return undefined;
  }
  const surface = flatten(api, doc);
  memo.set(api, surface);
  await putCachedVendorSurface(api, surface);
  logger.info({ connectorId, api, methods: surface.methods.length }, 'read the vendor published API');
  return surface;
}

/** Test seam: drop the in-process memo and the directory. Never called by app code. */
export function __resetVendorSpecCache(): void {
  memo.clear();
  directory = undefined;
}
