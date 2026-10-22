import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { ChainStep, OpIndexParameter } from '../../connectors/operationBinding.js';

/**
 * The dynamic-connector catalog: a connector's real, callable API shape, captured AHEAD OF
 * TIME from the vendor's own published documentation — never from Microsoft's Power Platform
 * connector wrapper, and never captured live during a customer's migration.
 *
 * WHY THIS EXISTS. Today, a connector's real API shape (`operationBinding.ts`'s
 * `VENDOR_BINDINGS`) is a hand-maintained TypeScript table — a developer has to read the
 * vendor's docs and type an entry in, by hand, for every connector. Confirmed live on
 * `shared_office365users`: a real engineer wrote that entry by hand on 2026-10-10. This
 * catalog replaces that with DATA: populate it once per connector (a one-time curation task,
 * not per customer and not per migration), and every later migration just looks it up.
 *
 * Scope: deliberately UNSCOPED (no appUserId/environment key) — see the comment on this
 * collection's creation in db/mongo.ts for the full justification. A connector's own
 * published API shape is a vendor fact, true identically for every customer; it is NOT the
 * same thing as "which connectors this customer has installed" (connectorOpIndexes), which
 * does stay scoped.
 */

const CONNECTORS = 'connectors';
const OPERATIONS = 'connectorOperations';

export interface CatalogConnector {
  /** Matches `registry.ts`'s `ConnectorDef.id` (e.g. "shared_office365users"). */
  connectorId: string;
  displayName: string;
  vendor: string;
  apiFamily: string;
  baseUrl: string;
  /** Where this connector's shape was sourced from — a URL to the vendor's own published
   *  spec/docs, so a reviewer can re-check it rather than trust it blindly. */
  specSourceUrl?: string;
  authKind: string;
  /** 'candidate' until a real test run has proven it; never used to gate execution here —
   *  gating happens per OPERATION (see CatalogOperation.lifecycle), since a connector can
   *  have some proven operations and some not. */
  status: 'candidate' | 'approved';
  catalogVersion: number;
  updatedAt: Date;
}

export interface CatalogOperationAuth {
  /** 'delegated' means this operation needs a real signed-in person — an app-only
   *  (tenant+client+secret) credential can never satisfy it, no matter what permission is
   *  granted. Confirmed live for Microsoft Graph's `/me`-style endpoints. */
  mode: 'app-only' | 'delegated';
  requiredPermissions: string[];
  requiresAdminConsent?: boolean;
}

export interface CatalogOperationResponse {
  /** Field in the response body holding the list, for collection-returning operations
   *  (e.g. Microsoft Graph's `value`). Absent for single-object responses. */
  resultPath?: string;
  pagination?: { strategy: 'next-link-field'; field: string };
  /** Absent means ordinary JSON. Set for operations whose response is not text at all
   *  (e.g. a user's photo) — the generic executor must not try to JSON-parse these. */
  contentType?: 'binary-image';
}

export interface CatalogOperation {
  connectorId: string;
  /** Our own stable key for this operation, e.g. "get_user". Never a display name — see
   *  docs/connector-architecture-decisions.md and the worked example in this conversation
   *  for why a display name is not a reliable identifier. */
  operationKey: string;
  displayName: string;
  method: string;
  /** The REAL vendor path (e.g. "/users/{userId}") — never a Power Platform proxy path. */
  path: string;
  parameters: OpIndexParameter[];
  auth: CatalogOperationAuth;
  response?: CatalogOperationResponse;
  /** A multi-call operation — see `ChainStep`'s own doc (operationBinding.ts) for why this
   *  exists: some real vendor operations are not expressible as one HTTP call (resolve-by-
   *  path, create-with-content). Absent for every ordinary single-call operation. */
  chain?: ChainStep[];
  /**
   * The name(s) Microsoft Copilot Studio itself uses for this operation (e.g. "GetUserV2").
   * This is the join key: a migrated agent's `AgentToolIR.operationId` is one of these, not
   * our own `operationKey` — see `findCatalogOperationBySourceId`. Empty when
   * `alwaysOnForConnector` is true — there is no source operation id to join on for those.
   */
  sourceOperationIds: string[];
  /**
   * True for an operation with NO Microsoft source equivalent at all — confirmed by checking
   * the vendor's own published connector reference directly, not assumed — so there is no
   * `sourceOperationIds` entry to ever match against a migrated agent's extracted tool calls.
   * Offered unconditionally whenever this connector is configured for an agent, the same way
   * a dedicated hand-written module's "bonus" functions always were (e.g. Gmail's labels,
   * Calendar's check-availability) — a real capability beyond strict source-fidelity
   * reproduction, not something this architecture is pretending is reproduced from Copilot.
   */
  alwaysOnForConnector?: boolean;
  lifecycle: {
    status: 'candidate' | 'approved' | 'unsupported';
  };
  /** Required when status is 'unsupported' — shown to the customer verbatim, never silently
   *  dropped. E.g. the raw-HTTP-passthrough case: "could call any address, cannot safely be
   *  auto-rebuilt." */
  unsupportedReason?: string;
  catalogVersion: number;
  updatedAt: Date;
}

export async function putCatalogConnector(rec: Omit<CatalogConnector, 'updatedAt'>): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<CatalogConnector>(CONNECTORS)
      .updateOne(
        { connectorId: rec.connectorId },
        { $set: { ...rec, updatedAt: new Date() } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putCatalogConnector failed: ${(e as Error).message}`);
  }
}

export async function getCatalogConnector(connectorId: string): Promise<CatalogConnector | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<CatalogConnector>(CONNECTORS).findOne({ connectorId });
  } catch (e) {
    logger.warn(`getCatalogConnector read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function putCatalogOperation(rec: Omit<CatalogOperation, 'updatedAt'>): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<CatalogOperation>(OPERATIONS)
      .updateOne(
        { connectorId: rec.connectorId, operationKey: rec.operationKey },
        { $set: { ...rec, updatedAt: new Date() } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putCatalogOperation failed: ${(e as Error).message}`);
  }
}

export async function listCatalogOperations(connectorId: string): Promise<CatalogOperation[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB).collection<CatalogOperation>(OPERATIONS).find({ connectorId }).toArray();
  } catch (e) {
    logger.warn(`listCatalogOperations read failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Every APPROVED operation with no Microsoft source equivalent at all, for this connector —
 * see `CatalogOperation.alwaysOnForConnector`. Unlike `findCatalogOperationBySourceId`, this
 * is never keyed on a migrated agent's extracted tool call; it answers "what bonus
 * capabilities should this connector offer unconditionally", the same question a dedicated
 * hand-written module's full function list always answered.
 */
export async function listApprovedAlwaysOnOperations(connectorId: string): Promise<CatalogOperation[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB)
      .collection<CatalogOperation>(OPERATIONS)
      .find({ connectorId, alwaysOnForConnector: true, 'lifecycle.status': 'approved' })
      .toArray();
  } catch (e) {
    logger.warn(`listApprovedAlwaysOnOperations read failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The actual lookup a migration uses: "Copilot Studio called this operation `GetUserV2` on
 * `shared_office365users` — what is that, really?" Matches on `sourceOperationIds`, never on
 * a display name or a guess.
 */
export async function findCatalogOperationBySourceId(
  connectorId: string,
  sourceOperationId: string,
): Promise<CatalogOperation | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB)
      .collection<CatalogOperation>(OPERATIONS)
      .findOne({ connectorId, sourceOperationIds: sourceOperationId });
  } catch (e) {
    logger.warn(`findCatalogOperationBySourceId read failed: ${(e as Error).message}`);
    return null;
  }
}
