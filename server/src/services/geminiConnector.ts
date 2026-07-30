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

/** Strip a known secret value out of provider response text before it's ever
 *  logged, persisted, or returned to a client. */
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
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
  await geminiWriteLimiter.acquire();
  const res = await fetch(`${HOST(location)}/projects/${project}/locations/${location}:setUpDataConnector`, {
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
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    // Google's validation errors can echo back the request body it rejected —
    // never let the submitted secret ride along into logs, the session
    // record, or the API response that reaches the browser.
    const text = redactSecret(raw, creds.clientSecret);
    logger.warn({ status: res.status, collectionId }, 'setUpDataConnector (SharePoint) failed');
    return { started: false, error: `${res.status}: ${text.slice(0, 300)}` };
  }
  const json = (await res.json()) as { name?: string };
  return { started: true, operationName: json.name };
}

export interface ConnectorOperationStatus {
  done: boolean;
  error?: string;
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
  location: string,
  saToken: string,
  operationName: string,
): Promise<ConnectorOperationStatus | null> {
  const res = await fetch(`${HOST(location)}/${operationName}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { done?: boolean; error?: { message?: string } };
  return { done: Boolean(json.done), error: json.error?.message };
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
