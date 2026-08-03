import { logger } from '../logger.js';
import { geminiWriteLimiter } from './rateLimiter.js';

/**
 * Discovery Engine federated-connector creation (Gemini's native SharePoint/
 * OneDrive connectors — the `reconnect` knowledge strategy). Unlike every
 * other executor in this pipeline, this one needs credentials CloudFuze does
 * not hold: a customer-specific Entra app registration (Client ID, Secret,
 * Tenant ID, Instance URI) that the customer's Microsoft admin creates and
 * grants Graph read permissions to.
 *
 * CloudFuze's own multi-tenant Dataverse app registration (auth/microsoft.ts,
 * MS_CLIENT_ID/MS_CLIENT_SECRET) CANNOT be reused here — its secret is shared
 * across every tenant that has ever consented to it. Google's connector
 * stores and uses whatever credential it's given independently, forever, on
 * Google's own infrastructure — handing it our shared secret would let one
 * customer's connector reach any other customer's tenant. See
 * .claude/rules/security-rules.md's multi-tenant isolation rule.
 *
 * There is currently no session/UI field to collect these per-customer
 * credentials — this module is the executor only, ready to call once that
 * input exists (a new pre-flight step, distinct from the initial "connect
 * Microsoft" sign-in).
 *
 * SharePoint's request shape below is VERIFIED against Google's live docs
 * (docs.cloud.google.com/gemini/enterprise/docs/connectors/ms-sharepoint,
 * fetched 2026). OneDrive's `dataSource` identifier is NOT published in those
 * docs — see setUpOneDriveConnector below; do not guess it.
 */

const HOST = (location: string) => `https://${location}-discoveryengine.googleapis.com/v1alpha`;

/**
 * Non-regional base host — confirmed against discovery_v1alpha.json's own
 * `baseUrl`/`rootUrl` ("https://discoveryengine.googleapis.com/", no location
 * prefix at all). `setUpDataConnector` itself is a write call that's
 * documented as region-routed (HOST(location) above, confirmed working — it
 * returns a real operation name). But *reading back* a resource whose full
 * path already NAMES its own location (`operations/{id}` under
 * `.../locations/global/...`, or a Collection under the same path) doesn't
 * need a region-prefixed hostname on top of that — confirmed live: polling
 * `getConnectorOperation` via the region-prefixed host 404'd immediately on a
 * freshly-created operation, not just after it aged out.
 */
const GLOBAL_HOST = 'https://discoveryengine.googleapis.com/v1alpha';

/** Strip a known secret value out of provider response text before it's ever
 *  logged, persisted, or returned to a client. */
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same 429/503 backoff every other Discovery Engine write path uses (see
 * geminiDataStore.ts's withBackoff) — kept as its own copy per that file's
 * convention (no shared/exported backoff helper exists in this codebase).
 */
async function withBackoff(fn: () => Promise<Response>, { retries = 6, baseMs = 1000, maxMs = 30000 } = {}): Promise<Response> {
  let attempt = 0;
  for (;;) {
    await geminiWriteLimiter.acquire();
    const res = await fn();
    if (res.status !== 429 && res.status !== 503) return res;
    if (res.status === 429) {
      const body = await res.clone().text().catch(() => '');
      if (/RESOURCE_EXHAUSTED|quota exceeded/i.test(body)) {
        logger.warn('Discovery Engine HARD quota (RESOURCE_EXHAUSTED) — not retrying');
        return res;
      }
    }
    if (attempt >= retries) return res;
    const retryAfter = res.headers.get('retry-after');
    let base: number;
    if (retryAfter) {
      const secs = Number(retryAfter);
      base = Number.isFinite(secs) ? secs * 1000 : Math.max(0, new Date(retryAfter).getTime() - Date.now());
    } else {
      base = Math.min(maxMs, baseMs * 2 ** attempt);
    }
    const wait = Math.round(base / 2 + Math.random() * (base / 2)); // equal jitter
    logger.warn({ status: res.status, attempt, wait }, 'Discovery Engine rate limited; backing off');
    await sleep(wait);
    attempt++;
  }
}

export interface SharePointConnectorCreds {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  /** SharePoint site URL, e.g. "https://contoso.sharepoint.com/sites/policies". */
  instanceUri: string;
}

export interface SetUpConnectorResult {
  started: boolean;
  operationName?: string;
  error?: string;
  /**
   * True when Google rejected the call with 409/ALREADY_EXISTS — since
   * collectionId is a deterministic hash of the site URL (connectorCollectionId
   * in knowledgePlanner.ts), re-submitting the SAME site naturally retries the
   * SAME collection name. Confirmed live: this is the expected, correct
   * behavior of the idempotent design, not a real error — the caller should
   * look up the existing collection's data stores instead of treating this as
   * failure (same 409-as-idempotent convention as createDataStore in
   * geminiDataStore.ts).
   */
  alreadyExists?: boolean;
}

/**
 * Create (or start creating — this is a long-running operation) a SharePoint
 * Online federated connector + its dedicated collection. `collectionId` must
 * be new or already this connector's own collection — `setUpDataConnector`
 * provisions the collection and the connector together in one call.
 */
export async function setUpSharePointConnector(
  project: string,
  location: 'global' | 'us' | 'eu',
  saToken: string,
  collectionId: string,
  collectionDisplayName: string,
  creds: SharePointConnectorCreds,
): Promise<SetUpConnectorResult> {
  const res = await withBackoff(() =>
    fetch(`${HOST(location)}/projects/${project}/locations/${location}:setUpDataConnector`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collectionId,
        collectionDisplayName,
        dataConnector: {
          dataSource: 'sharepoint_federated_search',
          params: {
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            instance_uri: creds.instanceUri,
            tenant_id: creds.tenantId,
          },
          entities: [{ entityName: 'file' }],
          refreshInterval: '7200s',
          connectorType: 'THIRD_PARTY_FEDERATED',
          connectorModes: ['FEDERATED'],
        },
      }),
    }),
  );
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    // Google's validation errors can echo back the request body it rejected —
    // never let the submitted secret ride along into logs, the session
    // record, or the API response that reaches the browser.
    const text = redactSecret(raw, creds.clientSecret);
    if (res.status === 409 || /ALREADY_EXISTS|already exists/i.test(text)) {
      return { started: false, alreadyExists: true };
    }
    logger.warn({ status: res.status, collectionId }, 'setUpDataConnector (SharePoint) failed');
    return { started: false, error: `${res.status}: ${text.slice(0, 300)}` };
  }
  const json = (await res.json()) as { name?: string };
  return { started: true, operationName: json.name };
}

export interface ConnectorOperationStatus {
  done: boolean;
  error?: string;
  /**
   * True when the STATUS CHECK ITSELF failed (network error, bad operation
   * name, permission issue on the operations.get call) — distinct from
   * Google reporting a real operation failure via `error` with `done: true`.
   * Without this, a broken status check and a genuinely-still-running
   * operation looked identical (`{ done: false }`), so a real error would
   * silently render as "still provisioning" forever with no way to tell.
   */
  checkFailed?: boolean;
}

/**
 * Poll the long-running `setUpDataConnector` operation. `done: true` with no
 * `error` means Google finished provisioning the collection/connector/data
 * store — it does NOT by itself mean the agent can search it yet. Google's
 * docs describe the remaining step as console-driven ("create an app, connect
 * it to the data store, authorize Gemini Enterprise to access Microsoft
 * SharePoint") without a documented REST equivalent, so that step is NOT
 * automated here — verify it manually in Cloud Console rather than assuming
 * `done: true` means "usable."
 */
export async function getConnectorOperation(
  saToken: string,
  operationName: string,
): Promise<ConnectorOperationStatus> {
  const url = `${GLOBAL_HOST}/${operationName}`;
  try {
    logger.info({ url }, 'getConnectorOperation: fetching');
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, url, operationName }, 'getConnectorOperation: status check failed');
      return { done: false, checkFailed: true, error: `${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as { done?: boolean; error?: { message?: string } };
    return { done: Boolean(json.done), error: json.error?.message };
  } catch (err) {
    logger.warn({ err, operationName }, 'getConnectorOperation: request threw');
    return { done: false, checkFailed: true, error: (err as Error).message };
  }
}

/**
 * Once a connector's setup operation is `done`, `SetUpDataConnector` has
 * already created a DataStore per source entity (confirmed against
 * discovery_v1alpha.json: `DataConnectorSourceEntity.dataStore`, "Output only.
 * The full resource name of the associated data store for the source entity
 * ... When the connector is initialized by the SetUpDataConnector method, a
 * DataStore is automatically created for each source entity."). This reads
 * those data store ids back off the Collection resource so the caller can
 * attach them to an engine with the existing attachDataStoreToEngine
 * (geminiDataStore.ts) — no separate create-data-store call needed here.
 */
/**
 * The connector's own lifecycle state (Collection.dataConnector.realtimeState
 * in discovery_v1alpha.json), despite the "realtime" name — its enum
 * descriptions cover the WHOLE connector lifecycle ("being set up",
 * "successfully set up and awaiting next sync run", "in error", etc.), not
 * just real-time sync specifically. This is the fallback ground truth used
 * whenever getConnectorOperation's own status check fails for any reason
 * (including the region-prefixed-host bug fixed alongside this — see
 * GLOBAL_HOST — kept as a fallback regardless, since it's independently
 * useful ground truth, not just a workaround for that one bug).
 */
export type ConnectorRealtimeState =
  | 'STATE_UNSPECIFIED'
  | 'CREATING'
  | 'ACTIVE'
  | 'FAILED'
  | 'RUNNING'
  | 'WARNING'
  | 'INITIALIZATION_FAILED'
  | 'UPDATING';

export async function getConnectorDataStores(
  project: string,
  location: string,
  saToken: string,
  collectionId: string,
): Promise<{ dataStoreIds: string[]; realtimeState?: ConnectorRealtimeState; error?: string }> {
  const res = await fetch(`${GLOBAL_HOST}/projects/${project}/locations/${location}/collections/${collectionId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) {
    return { dataStoreIds: [], error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  const json = (await res.json()) as {
    dataConnector?: { entities?: { dataStore?: string }[]; realtimeState?: ConnectorRealtimeState };
  };
  const dataStoreIds = (json.dataConnector?.entities ?? [])
    .map((e) => e.dataStore?.split('/').pop())
    .filter((id): id is string => Boolean(id));
  return { dataStoreIds, realtimeState: json.dataConnector?.realtimeState };
}

/**
 * OneDrive federated connector — NOT implemented. Google's docs confirm
 * SharePoint's `dataSource` ("sharepoint_federated_search") and params shape
 * but do not publish OneDrive's `dataSource` string in the fetched pages.
 * Verify it (Cloud Console network trace while creating a OneDrive connector,
 * or Google support) before implementing. Throws rather than guessing, so a
 * caller fails loudly instead of shipping an unverified wire value.
 */
export function setUpOneDriveConnector(): never {
  throw new Error(
    'OneDrive connector dataSource is not verified against Google docs — see geminiConnector.ts header. ' +
      'Confirm the exact dataSource value before implementing.',
  );
}
