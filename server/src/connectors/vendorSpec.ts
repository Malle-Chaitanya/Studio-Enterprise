/**
 * Fetch what a vendor says its OWN API is, so a binding can be CONFIRMED instead of inferred.
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
 * All three stop being guesses the moment the vendor's own machine-readable API is consulted.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * WHICH API DOES A CONNECTOR BELONG TO?
 *
 * `googleCatalog.ts` answers that for ten apps, from a hand-curated APPS list in its
 * generator. That list is the real ceiling on "works for any Google connector": a customer
 * using one nobody added gets no binding at all, and nothing says why.
 *
 * So the answer is resolved from EVIDENCE when the list does not have it:
 *
 *   1. candidates, generated loosely   — the connector's id and display name against every
 *                                        name and title in Google's Discovery directory.
 *   2. verified strictly               — fetch each candidate and keep only one whose
 *                                        published methods actually match the paths THIS
 *                                        connector declares, in the customer's environment.
 *   3. remembered                      — the winning mapping is persisted, so the candidate
 *                                        fetches happen once ever, not once per migration.
 *
 * Loose generation is safe precisely because verification is strict: a wrong candidate
 * matches none of the connector's paths and is discarded. A candidate that matches nothing is
 * indistinguishable from no candidate, and both end as "no surface", which leaves the
 * connector exactly where it was.
 *
 * WHAT THIS STILL DOES NOT SOLVE, stated rather than papered over: candidates come from
 * NAMES, so a connector whose name does not resemble its API is not found.
 * `shared_googlegemini` targets the `generativelanguage` API, and no amount of string
 * similarity gets from one to the other. Those need a curated entry — the mechanism reduces
 * the list to the genuinely surprising cases instead of requiring one per app.
 *
 * SCOPE TODAY: Google, via Discovery. Microsoft Graph, Atlassian, HubSpot and Salesforce all
 * publish OpenAPI, and `VendorApiSurface` is what they would reduce to — so adding one is a
 * loader here, not a change to the binding logic.
 *
 * BEST-EFFORT, ALWAYS. Every failure path returns `undefined`, which puts the caller back on
 * the previous shape-based behaviour with `provenance: 'heuristic'`. A vendor's documentation
 * site being down must never fail a customer's migration. The one exception is a binding
 * marked `requireVendorSpec`, which refuses rather than falls back — and the stale-on-error
 * path below exists so that refusal is reserved for genuinely never having read the API,
 * not for one bad minute.
 */
import { logger } from '../logger.js';
import { GOOGLE_APPS } from './googleCatalog.js';
import {
  getCachedVendorSurface,
  getResolvedApiFor,
  putCachedVendorSurface,
  recordResolvedApi,
} from '../db/repos/vendorApiSurface.js';
import { SURFACE_SCHEMA_VERSION } from './operationBinding.js';
import type {
  ConnectorOpIndex,
  VendorApiMethod,
  VendorApiParameter,
  VendorApiSurface,
} from './operationBinding.js';

/** Google publishes breaking changes as new API versions, not in place, so a month is safe
 *  and keeps a migration from re-reading the same public document all day. */
const SURFACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DIRECTORY_URL = 'https://discovery.googleapis.com/discovery/v1/apis?preferred=true';
/** The vendor's docs are not on the critical path — fail fast and fall back rather than hold
 *  a migration open waiting for them. */
const FETCH_TIMEOUT_MS = 8_000;
/**
 * After this many consecutive fetch failures, stop trying for a while.
 *
 * `buildBoundToolSpecs` runs on the migration path and asks for a surface per connector. If
 * Google's documentation host is unreachable, an agent with ten connectors would otherwise
 * pay the full retry schedule ten times over before producing the same answer it would have
 * produced immediately. The breaker turns a slow outage into a fast one, which is the
 * difference between a migration that looks hung and one that reports honestly and moves on.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
/** Google's preferred directory has had 300+ entries for years. A response far below that is
 *  truncated or an error page that happened to parse, and memoising it would silently break
 *  resolution for the life of the process. */
const MIN_DIRECTORY_SIZE = 50;
/** Candidate docs fetched per unknown connector. Bounded because this runs inside a
 *  migration: three is enough for a name match to land and cheap enough to be invisible. */
const MAX_CANDIDATES = 3;
/** Share of a connector's paths that must resolve before we believe the API is the right one.
 *  Deliberately low — shared_googlecontacts is a genuine mix of live People API paths and
 *  retired GData ones, so demanding a majority would reject the correct answer. One match is
 *  too weak (a single `/v1/{id}` matches half of Google), two is the floor. */
const MIN_MATCH_RATIO = 0.2;
const MIN_MATCHES = 2;

/** In-process memo, so one migration fetching twenty connectors does not re-read Mongo twenty
 *  times for the same API. Cleared only by a restart, the right lifetime for a document that
 *  changes a few times a year. */
const memo = new Map<string, VendorApiSurface | undefined>();
let directory: Map<string, { url: string; title: string }> | undefined;
let consecutiveFailures = 0;
let breakerUntil = 0;

/**
 * A first-party connector id, i.e. one from Microsoft's published catalogue.
 *
 * A CUSTOM connector's id is derived from the display name its author typed
 * (`shared_get-20crm-20objects-20from-20hubspot-5fdd…`), which is the customer's own
 * business naming. `vendorApiSurfaces` is a cross-tenant cache, so only first-party ids may
 * be written into it — see that repo's header.
 */
function isSharedConnectorId(connectorId: string): boolean {
  return /^shared_[a-z0-9]+$/i.test(connectorId);
}

/**
 * One GET, retried on the failures that are worth retrying.
 *
 * 429 and 5xx are transient by definition and a single one must not downgrade every
 * `requireVendorSpec` connector in the run. 4xx other than 429 is a verdict, not a blip, and
 * retrying it just adds latency to a result that will not change.
 */
async function getJson(url: string, attempts = 3): Promise<Record<string, unknown> | undefined> {
  if (Date.now() < breakerUntil) return undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        consecutiveFailures = 0;
        return (await res.json()) as Record<string, unknown>;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === attempts) {
        // A 404 is a VERDICT, not an outage: this API simply is not published. Counting it
        // towards the breaker would let a few retired APIs silence verification for every
        // connector in the run.
        if (retryable) noteFailure();
        logger.debug({ url, status: res.status }, 'vendor API description not available');
        return undefined;
      }
    } catch (e) {
      if (attempt === attempts) {
        noteFailure();
        logger.debug({ url, err: (e as Error).message }, 'vendor API description fetch failed');
        return undefined;
      }
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
  }
  return undefined;
}

/** Trip the breaker once failures stop looking like bad luck. Reset by any success. */
function noteFailure(): void {
  if (++consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFailures = 0;
    logger.warn(
      { cooldownMs: BREAKER_COOLDOWN_MS },
      'vendor API descriptions unreachable - pausing verification so it cannot stall a migration',
    );
  }
}

/** api name -> {discovery doc url, title}. Fetched once per process. */
async function discoveryDirectory(): Promise<Map<string, { url: string; title: string }> | undefined> {
  if (directory) return directory;
  const body = await getJson(DIRECTORY_URL);
  if (!body) return undefined;
  const map = new Map<string, { url: string; title: string }>();
  for (const item of (body.items as Array<Record<string, unknown>>) ?? []) {
    const name = String(item.name ?? '');
    const url = String(item.discoveryRestUrl ?? '');
    // `preferred=true` already filters to one version per API, so the first entry wins and a
    // later duplicate is never a different version of the same thing.
    if (name && url && !map.has(name)) map.set(name, { url, title: String(item.title ?? name) });
  }
  if (map.size < MIN_DIRECTORY_SIZE) {
    logger.warn({ size: map.size }, 'Google Discovery directory looks truncated - not caching it');
    return undefined;
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
/**
 * Discovery's parameter block -> our shape.
 *
 * `location` is Discovery's own word for where the value goes, and it only ever says `path`
 * or `query` — a Discovery method's body is described separately, by `request`. Anything
 * else is treated as a query parameter rather than dropped, because dropping it would make
 * the verifier call a real parameter invented.
 */
function readVendorParams(block: unknown): VendorApiParameter[] {
  const out: VendorApiParameter[] = [];
  if (!block || typeof block !== 'object') return out;
  for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
    const p = (raw ?? {}) as Record<string, unknown>;
    out.push({
      name,
      in: p.location === 'path' ? 'path' : 'query',
      required: p.required === true,
      type: String(p.type ?? 'string'),
      ...(Array.isArray(p.enum) ? { enum: (p.enum as unknown[]).map(String) } : {}),
    });
  }
  return out;
}

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
        parameters: readVendorParams(m.parameters),
        hasBody: Boolean(m.request),
      });
    }
    for (const sub of Object.values((node.resources ?? {}) as Record<string, Record<string, unknown>>)) {
      walk(sub);
    }
  };
  walk(doc);
  return {
    api,
    methods,
    commonParameters: readVendorParams(doc.parameters),
    schemaVersion: SURFACE_SCHEMA_VERSION,
  };
}

/** Placeholders collapse to `{}` so a connector's `{calendarId}` and a vendor's `{+name}`
 *  compare equal. Mirrors `pathSegments` in operationBinding.ts; kept local so this module
 *  stays importable without pulling the binding logic in. */
function segments(path: string): string[] {
  return path.replace(/\{[^}]*\}/g, '{}').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}

function samePath(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === '{}' || b[i] === '{}' || s.toLowerCase() === b[i].toLowerCase());
}

/**
 * How much of this connector's own surface the candidate API actually accounts for.
 *
 * Compared as a SUFFIX of the method URL rather than against a declared base, because at this
 * point there is no trusted base URL — finding the right API is the whole question. A path
 * that is the tail of some published method URL is strong evidence; one that matches nothing
 * anywhere is strong evidence against.
 */
function matchScore(index: ConnectorOpIndex, surface: VendorApiSurface): { matched: number; total: number } {
  const methodSegs = surface.methods.map((m) => segments(new URL(m.url).pathname));
  const paths = Object.values(index.operations).map((o) => o.path.replace(/^\/\{connectionId\}/, ''));
  let matched = 0;
  for (const p of paths) {
    const want = segments(p);
    // Too short to mean anything: `/search` or `/v1/{id}` is the tail of half of Google.
    if (want.length < 2) continue;
    const hit = methodSegs.some((m) => m.length >= want.length && samePath(want, m.slice(m.length - want.length)));
    if (hit) matched++;
  }
  return { matched, total: paths.length };
}

/** Loose candidates, ranked. Verification decides; this only has to put the right answer in
 *  the first few. */
function candidateApis(
  connectorId: string,
  displayName: string,
  dir: Map<string, { url: string; title: string }>,
): string[] {
  const stem = connectorId.replace(/^shared_/, '').toLowerCase();
  const words = new Set(
    `${stem} ${displayName}`.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && w !== 'google'),
  );
  const scored: Array<{ api: string; score: number }> = [];
  for (const [api, meta] of dir) {
    const title = meta.title.toLowerCase().replace(/\s*api$/, '');
    let score = 0;
    if (stem === api) score += 100;
    else if (stem.startsWith(api) || api.startsWith(stem)) score += 60;
    if (title && (stem === title.replace(/\s+/g, '') || words.has(title))) score += 50;
    for (const w of words) if (api.includes(w) || title.includes(w)) score += 10;
    if (score > 0) scored.push({ api, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES).map((s) => s.api);
}

/** Fetch + flatten one API, preferring a cached copy and falling back to a STALE one rather
 *  than nothing. Returns undefined only when we have never successfully read it. */
async function loadSurface(api: string): Promise<VendorApiSurface | undefined> {
  const fresh = await getCachedVendorSurface(api, SURFACE_TTL_MS);
  // An in-date row captured by an older build is NOT usable as-is: it is missing fields a
  // newer consumer needs (declared parameters, today), and those come back as `undefined`,
  // which reads as "the vendor declares none" rather than "we never looked". Treat it as a
  // miss so it refetches. The stale path below still accepts it, because for plain binding
  // an old surface is complete.
  if (fresh && (fresh.schemaVersion ?? 0) >= SURFACE_SCHEMA_VERSION) return fresh;

  const dir = await discoveryDirectory();
  const docUrl = dir?.get(api)?.url;
  const doc = docUrl ? await getJson(docUrl) : undefined;
  if (!doc) {
    // STALE BEATS NOTHING. A surface past its refresh window still describes an API that
    // almost certainly still exists, and for a `requireVendorSpec` binding the alternative is
    // refusing every operation because a documentation host had a bad minute. Refusal is for
    // never having read the API at all.
    const stale = await getCachedVendorSurface(api, Number.POSITIVE_INFINITY);
    if (stale) {
      logger.warn({ api }, 'using a stale vendor API description - refresh failed');
      return stale;
    }
    return undefined;
  }
  const surface = flatten(api, doc);
  await putCachedVendorSurface(api, surface);
  return surface;
}

/**
 * The vendor's published API for this connector, or `undefined` when there is none to be had.
 *
 * Client-agnostic by construction: nothing here reads a tenant, an environment or a
 * credential. `index` is the connector's operations as captured from the CUSTOMER's own
 * environment, and is used only as evidence for which API a connector belongs to — passing
 * it is what lets a connector nobody curated resolve itself.
 */
export async function resolveVendorApiSurface(
  connectorId: string,
  index?: ConnectorOpIndex,
): Promise<VendorApiSurface | undefined> {
  // 1. Curated. Ten apps whose mapping a human already established.
  const curated = GOOGLE_APPS.find((a) => a.id === connectorId)?.api;
  if (curated) {
    if (memo.has(curated)) return memo.get(curated);
    const s = await loadSurface(curated);
    // Only a SUCCESS is memoised. Memoising a transient failure would pin this API to
    // "unavailable" for the life of the process and silently downgrade every later migration
    // in it.
    if (s) memo.set(curated, s);
    return s;
  }

  if (!isSharedConnectorId(connectorId)) return undefined;

  // 2. Resolved before, by this or any other tenant. The cache is the vendor's public
  //    catalogue, so one customer's resolution is correct for all of them.
  const known = await getResolvedApiFor(connectorId);
  if (known) {
    if (memo.has(known)) return memo.get(known);
    const s = await loadSurface(known);
    if (s) memo.set(known, s);
    return s;
  }

  // 3. Resolve from evidence. Needs the connector's own operations to verify against —
  //    without them there is nothing to be right or wrong about, so we do not guess.
  if (!index || !Object.keys(index.operations).length) return undefined;
  const dir = await discoveryDirectory();
  if (!dir) return undefined;

  let best: { surface: VendorApiSurface; matched: number } | undefined;
  for (const api of candidateApis(connectorId, index.displayName || connectorId, dir)) {
    const surface = await loadSurface(api);
    if (!surface) continue;
    const { matched, total } = matchScore(index, surface);
    if (matched >= MIN_MATCHES && matched / Math.max(total, 1) >= MIN_MATCH_RATIO) {
      if (!best || matched > best.matched) best = { surface, matched };
    }
  }
  if (!best) {
    // Honest end state: no published API accounts for this connector's paths. The connector
    // keeps its previous behaviour, and a `requireVendorSpec` binding refuses by name rather
    // than binding something unverified.
    logger.info({ connectorId }, 'no published Google API matches this connector\'s own paths');
    return undefined;
  }
  memo.set(best.surface.api, best.surface);
  await recordResolvedApi(best.surface.api, connectorId);
  logger.info(
    { connectorId, api: best.surface.api, matchedPaths: best.matched },
    'resolved a connector to a published vendor API from its own operations',
  );
  return best.surface;
}

/** Test seam: drop the in-process memo and the directory. Never called by app code. */
export function __resetVendorSpecCache(): void {
  memo.clear();
  directory = undefined;
  consecutiveFailures = 0;
  breakerUntil = 0;
}
