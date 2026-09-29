import { logger } from '../logger.js';
import { config } from '../config.js';
import { captureOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import type { ConnectorOpIndex } from '../connectors/operationBinding.js';
import {
  getConnector,
  listConnectorIdsOlderThan,
  listOperationsFor,
  putConnector,
  putConnectorOperations,
  toRegistryRecords,
  type ConnectorOperationRecord,
} from '../db/repos/connectorRegistry.js';
import { callAI, agentLlmConfigured } from '../agent/callAI.js';

/**
 * How long a captured connector is trusted before the sweep re-checks it live. Matches
 * the TTL captureOpIndex already uses for a per-customer cached capture (captureOpIndex.ts)
 * — a connector's own shape changes rarely, so re-fetching more often than that buys
 * nothing but load on Microsoft's API.
 */
const REFRESH_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export function connectorRegistryRefreshConfigured(): boolean {
  return Boolean(config.CONNECTOR_REGISTRY_TENANT_ID && config.CONNECTOR_REGISTRY_ENV_ID && config.CONNECTOR_REGISTRY_SCOPE);
}

/**
 * Background sweep: this is the "cron job that keeps the registry fresh" half of the
 * design — the DB (`connectors` + `connectorOperations`) is populated once by the
 * `_prep_populate_*` spikes, then this sweep re-reads each connector's live swagger from
 * the same reference environment on a schedule and updates the stored operations/auth
 * when Microsoft has actually changed them. A connector whose spec hasn't moved just gets
 * its `capturedAt` bumped, so it drops out of the "due" list without a wasted rewrite.
 *
 * Best-effort and per-connector isolated — a capture failure for one connector (Microsoft's
 * API is briefly down, or that connector was uninstalled from the reference environment)
 * must never stop the rest of the sweep or crash the server, same posture as every other
 * background job in this codebase (see services/groundingRecheck.ts).
 */
export async function runConnectorRegistryRefresh(): Promise<void> {
  if (!connectorRegistryRefreshConfigured()) return;
  const ctx: CaptureContext = {
    tenantId: config.CONNECTOR_REGISTRY_TENANT_ID!,
    environmentId: config.CONNECTOR_REGISTRY_ENV_ID!,
    scope: config.CONNECTOR_REGISTRY_SCOPE!,
  };

  const cutoff = new Date(Date.now() - REFRESH_AFTER_MS);
  const due = await listConnectorIdsOlderThan(cutoff);
  if (!due.length) return;

  logger.info(`connector registry refresh: ${due.length} connector(s) due for a freshness check`);
  for (const connectorId of due) {
    try {
      await refreshOne(connectorId, ctx);
    } catch (e) {
      logger.warn(`connector registry refresh failed for ${connectorId}: ${(e as Error).message}`);
    }
  }
}

interface OpDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * `prior` came back from Mongo, `live` is a fresh in-memory capture that has never
 * touched the database — and the mongodb driver's BSON serializer writes an `undefined`
 * field as an explicit `null`, while a plain in-memory object simply omits that key. Left
 * unnormalized, every parameter with an unset optional field (e.g. `visibility`) compares
 * as "changed" on every single sweep cycle even when nothing upstream moved at all —
 * confirmed live: Dropbox's `ListFolder` `id` parameter round-tripped to
 * `visibility: null` in storage, `visibility: undefined` (key omitted) fresh from
 * capture, and falsely flagged as changed until this normalization was added.
 */
function normalizeParams(params: OpIndexParameterLike[]): OpIndexParameterLike[] {
  return params.map((p) => ({ ...p, visibility: p.visibility ?? null }));
}

interface OpIndexParameterLike {
  name: string;
  in: string;
  required: boolean;
  type: string;
  visibility?: string | null;
}

/** Same undefined-vs-null Mongo round-trip issue as normalizeParams, applied to an auth
 *  entry's optional fields (identityProvider, resource, scopes). */
function normalizeAuthMap(
  map: Record<string, { type?: string; identityProvider?: string | null; resource?: string | null; scopes?: string[] | null }> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(map ?? {})) {
    out[key] = {
      type: val.type ?? null,
      identityProvider: val.identityProvider ?? null,
      resource: val.resource ?? null,
      scopes: val.scopes ?? null,
    };
  }
  return out;
}

function diffOperations(prior: ConnectorOperationRecord[], live: ConnectorOpIndex): OpDiff {
  const priorIds = new Set(prior.map((p) => p.operationId));
  const liveIds = new Set(Object.keys(live.operations));
  const added = [...liveIds].filter((id) => !priorIds.has(id));
  const removed = [...priorIds].filter((id) => !liveIds.has(id));
  const changed: string[] = [];
  for (const p of prior) {
    const l = live.operations[p.operationId];
    if (!l) continue;
    if (
      l.method !== p.method ||
      l.path !== p.path ||
      JSON.stringify(normalizeParams(l.parameters)) !== JSON.stringify(normalizeParams(p.parameters))
    ) {
      changed.push(p.operationId);
    }
  }
  return { added, removed, changed };
}

async function refreshOne(connectorId: string, ctx: CaptureContext): Promise<void> {
  const existing = await getConnector(connectorId);
  // Only refreshes connectors this registry already tracks — adding a NEW connector to
  // the registry is still a deliberate curation decision (which category, is it really
  // Microsoft's own service), made once via the `_prep_populate_*` scripts, not something
  // this sweep should decide unattended.
  if (!existing) return;

  const [priorOps, live] = await Promise.all([listOperationsFor(connectorId), captureOpIndex(connectorId, ctx)]);
  if (!live) {
    logger.debug(`connector registry refresh: ${connectorId} not reachable from the reference environment this cycle — leaving stored data as-is`);
    return;
  }

  const diff = diffOperations(priorOps, live);
  const authChanged = JSON.stringify(normalizeAuthMap(existing.authParameters)) !== JSON.stringify(normalizeAuthMap(live.connectionAuth));
  const changed = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0 || authChanged;

  if (!changed) {
    // Nothing moved — bump capturedAt only, so it drops off the "due" list without a
    // pointless operations rewrite.
    await putConnector({ ...existing, capturedAt: new Date() });
    return;
  }

  const { connector, operations } = toRegistryRecords(
    connectorId,
    existing.publisher,
    existing.isMicrosoftOwnService,
    existing.category ?? '',
    live,
  );
  await putConnector(connector);
  await putConnectorOperations(connectorId, operations);

  const summary = await summarizeChange(connectorId, diff, authChanged);
  logger.info(`connector registry refresh: ${connectorId} updated — ${summary}`);
}

/**
 * A one-line human-readable changelog for the update just written. The LLM's role here is
 * strictly descriptive — it never decides whether to write the change (the mechanical diff
 * above already decided that) and never touches the DB; it only turns a raw diff into a
 * sentence a human skimming logs can read at a glance. Falls back to the mechanical count
 * when no instruction LLM is configured, or if the call itself fails — a missing log
 * sentence is never worth blocking or retrying the actual registry update over.
 */
async function summarizeChange(connectorId: string, diff: OpDiff, authChanged: boolean): Promise<string> {
  const mechanical =
    `+${diff.added.length} new, -${diff.removed.length} removed, ~${diff.changed.length} changed operation(s)` +
    (authChanged ? ', auth shape changed' : '');
  if (!agentLlmConfigured()) return mechanical;
  try {
    const res = await callAI(
      [
        {
          role: 'system',
          content:
            'You write one short, factual sentence summarizing an API connector spec change for an engineering log. No speculation, no fixing, just what changed.',
        },
        {
          role: 'user',
          content:
            `Connector ${connectorId}. ${mechanical}. ` +
            `Added operation ids: ${diff.added.join(', ') || 'none'}. ` +
            `Removed operation ids: ${diff.removed.join(', ') || 'none'}. ` +
            `Changed operation ids: ${diff.changed.join(', ') || 'none'}.`,
        },
      ],
      [],
      { maxTokens: 120 },
    );
    return res.content?.trim() || mechanical;
  } catch (e) {
    logger.debug(`connector registry refresh: LLM summary failed, using mechanical diff instead: ${(e as Error).message}`);
    return mechanical;
  }
}
