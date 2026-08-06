import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Which third-party connectors a customer has configured, and where each
 * credential field lives in Secret Manager.
 *
 * WHY THIS EXISTS: credential state used to be recorded only on the session plan
 * (`plan.savedConnectors`), and `migrationSessions` has a TTL — so a customer who
 * configured Jira and Confluence lost that record on the next sign-in and had to
 * re-enter everything, even though the secrets were still sitting in Secret
 * Manager. Connector setup is a per-customer asset that outlives a session and is
 * reused across migrations, so it belongs in its own collection.
 *
 * SECURITY: this collection stores secret *ids and field names only* — never a
 * credential value. Values live exclusively in Secret Manager, and the deployed
 * agent's tools resolve them per call. Nothing here is sensitive on its own.
 *
 * Collection: connectorCredentials (unique per {appUserId, connectorId}).
 */

const COLL = 'connectorCredentials';

export interface ConnectorCredentialRecord {
  connectorId: string;
  /** Credential field keys that have been supplied (e.g. ['api_token','email']). */
  fields: string[];
  /** field key → Secret Manager secret id. No values, ever. */
  secretIds: Record<string, string>;
  /** The Google Cloud project the secrets live in. */
  project: string;
  updatedAt?: Date;
}

/** Record that a connector's credentials are stored, replacing any prior record. */
export async function upsertConnectorCredential(
  appUserId: string,
  record: ConnectorCredentialRecord,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection(COLL)
      .updateOne(
        { appUserId, connectorId: record.connectorId },
        {
          $set: {
            appUserId,
            connectorId: record.connectorId,
            fields: record.fields,
            secretIds: record.secretIds,
            project: record.project,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`upsertConnectorCredential persist failed: ${(e as Error).message}`);
  }
}

/** Every connector this customer has configured. Scoped by appUserId. */
export async function listConnectorCredentials(appUserId: string): Promise<ConnectorCredentialRecord[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB)
      .collection(COLL)
      .find<ConnectorCredentialRecord>({ appUserId })
      .sort({ updatedAt: -1 })
      .toArray();
  } catch (e) {
    logger.warn(`listConnectorCredentials read failed: ${(e as Error).message}`);
    return [];
  }
}

/** One connector's stored credential metadata, or null if never configured. */
export async function getConnectorCredential(
  appUserId: string,
  connectorId: string,
): Promise<ConnectorCredentialRecord | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB)
      .collection(COLL)
      .findOne<ConnectorCredentialRecord>({ appUserId, connectorId });
  } catch (e) {
    logger.warn(`getConnectorCredential read failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Forget our record of a connector's credentials. Does NOT delete the Secret
 * Manager secrets — destroying a customer's secret material is a separate,
 * irreversible action that must be explicit, not a side effect of "remove from
 * this list".
 */
export async function deleteConnectorCredential(appUserId: string, connectorId: string): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).deleteOne({ appUserId, connectorId });
  } catch (e) {
    logger.warn(`deleteConnectorCredential failed: ${(e as Error).message}`);
  }
}
