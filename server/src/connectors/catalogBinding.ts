import {
  findCatalogOperationBySourceId, getCatalogConnector, listApprovedAlwaysOnOperations,
  type CatalogConnector, type CatalogOperation,
} from '../db/repos/connectorCatalog.js';
import type { BoundOperation, BoundParameter, VendorAuth } from './operationBinding.js';

/**
 * Resolve "Copilot Studio called operation X on connector Y" against the DYNAMIC catalog
 * (db/repos/connectorCatalog.ts) — populated ahead of time from the vendor's own published
 * docs, never from a live Power Platform swagger capture.
 *
 * This is additive, not a replacement: `operationBinding.ts`'s `bindOperation` (the existing
 * hand-maintained `VENDOR_BINDINGS` path) is untouched. A caller tries the catalog FIRST; a
 * miss here falls back to the existing path exactly as it works today. See
 * docs/connector-architecture-decisions.md and .claude/memory/decisions.md for why this is
 * deliberately a pilot scoped to one connector (`shared_office365users`) rather than a
 * wholesale replacement.
 */

export type CatalogBindingResult =
  /** Only ever returned for `lifecycle.status === 'approved'` — see `bindFromCatalog`. */
  | { status: 'bindable'; operation: BoundOperation; displayName: string }
  | { status: 'unsupported'; reason: string }
  /** Not an error — just "this connector/operation has no catalog entry yet", so the caller
   *  falls back to the existing VENDOR_BINDINGS path. */
  | { status: 'not-in-catalog' };

/** The small, closed set of auth KINDS this project already knows how to execute — matches
 *  `registry.ts`'s `AuthKind`. Mapping by kind, not by vendor, is what keeps this generic. */
const AUTH_KIND_TO_VENDOR_AUTH: Record<string, VendorAuth> = {
  'oauth2-client-credentials': 'aad-token',
  bearer: 'bearer-token',
  'basic-userpass': 'atlassian-basic',
  // Added for the Google connector catalog pilot. generic_rest.py's `_invoke` only special-
  // cases `op.auth === "aad-token"` (its own `_aad_header()`); anything else — including this
  // — falls through to `auth_header(fill)`, the generic function built once in adk_deploy.py
  // that already mints a Google service-account/DWD token for ANY connector whose registry
  // entry declares `authKind: 'google-service-account'` (Drive, Gmail, Calendar, Contacts,
  // Sheets, Tasks). Nothing new to build here — this one line is what lets the catalog path
  // reuse that already-proven minting code instead of inventing a second implementation.
  'google-service-account': 'google-oauth',
};

export async function bindFromCatalog(
  connectorId: string,
  sourceOperationId: string,
): Promise<CatalogBindingResult> {
  const op = await findCatalogOperationBySourceId(connectorId, sourceOperationId);
  if (!op) return { status: 'not-in-catalog' };

  // STRUCTURAL auth fact, checked first and unconditionally — independent of lifecycle
  // status, because no amount of "approved" can make an app-only credential satisfy an
  // operation that reads "whoever is currently signed in". Confirmed live, not assumed.
  if (op.auth.mode === 'delegated') {
    return {
      status: 'unsupported',
      reason:
        `${op.displayName} requires a real signed-in person (it reads "whoever is currently ` +
        'asking"). An app-only login has no "whoever" to answer with, so this cannot be ' +
        'reproduced under the current authentication setup.',
    };
  }

  // LIFECYCLE gate. Only 'approved' may bind — this is the enforcement that was missing:
  // 'candidate' used to fall through and deploy identically to 'approved'. Every other
  // value (including missing or unrecognized ones — a hand-edited or corrupted document
  // reading back something outside the known set) is treated as NOT ready, never assumed
  // safe. `op.lifecycle?.status` reads defensively: Mongo does not enforce the TS type at
  // the database level, so a malformed document is a real possibility, not a hypothetical.
  const status: unknown = op.lifecycle?.status;
  if (status === 'unsupported') {
    return {
      status: 'unsupported',
      reason: op.unsupportedReason ?? `${op.displayName} cannot be safely reproduced.`,
    };
  }
  if (status !== 'approved') {
    const binaryNote =
      op.response?.contentType === 'binary-image'
        ? ' Its response is also a binary image, not JSON, which the generic executor does not yet have a tested, safe way to return.'
        : '';
    const statusDetail =
      status === 'candidate'
        ? 'its catalog entry is marked "candidate" (not yet verified against the real API)'
        : status === undefined
          ? 'its catalog entry has no lifecycle status recorded'
          : `its catalog entry has an unrecognized lifecycle status ("${String(status)}")`;
    return {
      status: 'unsupported',
      reason: `${op.displayName} is not deployed yet — ${statusDetail}, so it is treated as not ready rather than assumed safe.${binaryNote}`,
    };
  }

  const connector = await getCatalogConnector(connectorId);
  if (!connector) return { status: 'not-in-catalog' };

  return buildBoundOperationResult(connectorId, sourceOperationId, op, connector);
}

/**
 * Shared tail of both resolution paths below: URL/parameter/auth construction for an
 * already-gated, already-approved operation. `sourceOperationId` is the real extracted
 * Copilot id for the normal path, or the operation's own `operationKey` for an always-on one
 * (which has no source id at all — see `CatalogOperation.alwaysOnForConnector`).
 */
function buildBoundOperationResult(
  connectorId: string,
  sourceOperationId: string,
  op: CatalogOperation,
  connector: CatalogConnector,
): CatalogBindingResult {
  const urlTemplate = `${connector.baseUrl.replace(/\/$/, '')}${op.path}`;
  const parameters: BoundParameter[] = op.parameters.map((p): BoundParameter => ({
    name: p.name,
    in: p.in,
    required: p.required,
    type: p.type,
  }));
  const auth = AUTH_KIND_TO_VENDOR_AUTH[connector.authKind];
  if (!auth) {
    return {
      status: 'unsupported',
      reason: `${connector.displayName} declares an auth kind ("${connector.authKind}") this executor does not yet know how to run.`,
    };
  }

  return {
    status: 'bindable',
    displayName: op.displayName,
    operation: {
      connectorId,
      operationId: sourceOperationId,
      method: op.method,
      urlTemplate,
      parameters,
      auth,
      // Every Microsoft Graph operation in this catalog resolves to the same resource —
      // true because the catalog is keyed by real vendor identity, not by which Power
      // Platform proxy happened to carry it.
      aadResource: auth === 'aad-token' ? connector.baseUrl.replace(/^(https?:\/\/[^/]+).*/, '$1') : undefined,
      contextRequired: [],
      resultPath: op.response?.resultPath,
      pagination: op.response?.pagination,
      catalogVersion: op.catalogVersion,
      // Multi-call operations carry fully-resolved absolute URLs on each step already (see
      // the seed data), so no further prefixing happens here — passed through as-is.
      chain: op.chain,
    },
  };
}

/**
 * Every bonus capability this connector offers with no Microsoft source equivalent at all
 * (confirmed against the vendor's own published connector reference, not assumed) —
 * Gmail's labels, Calendar's check-availability, and similar. Unlike `bindFromCatalog`, this
 * is never matched against a migrated agent's extracted tool call; it is offered
 * unconditionally whenever the connector itself is configured for an agent, mirroring
 * exactly how a dedicated hand-written module's full function list always worked. Returns
 * one display name + bindable operation pair per always-on row (only APPROVED ones — see
 * `listApprovedAlwaysOnOperations`).
 */
export async function bindAlwaysOnOperations(
  connectorId: string,
): Promise<Array<{ displayName: string; operation: BoundOperation }>> {
  const connector = await getCatalogConnector(connectorId);
  if (!connector) return [];
  const ops = await listApprovedAlwaysOnOperations(connectorId);
  const out: Array<{ displayName: string; operation: BoundOperation }> = [];
  for (const op of ops) {
    const result = buildBoundOperationResult(connectorId, op.operationKey, op, connector);
    if (result.status === 'bindable') out.push(result);
  }
  return out;
}
