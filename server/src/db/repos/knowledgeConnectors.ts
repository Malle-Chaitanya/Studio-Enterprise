import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * One row per (customer, connector kind, site) — replaces the old
 * `Session.sharepointConnector` singleton, which could only ever track ONE
 * SharePoint site per whole migration session. A customer with agents
 * referencing several distinct SharePoint sites needs several of these.
 *
 * The client secret is NEVER stored here — either it was a one-shot value
 * used directly in the setUpDataConnector call (new tenant, no stored
 * credential yet), or it came from Secret Manager via entraAppCredentials.ts
 * (already-onboarded tenant). Either way, nothing secret lands in Mongo.
 */
export interface KnowledgeConnector {
  appUserId: string;
  kind: 'sharepoint' | 'onedrive';
  siteUrl: string; // the instanceUri — natural key alongside appUserId+kind
  collectionId: string;
  tenantId: string;
  clientId: string; // non-secret
  operationName?: string;
  status: 'pending' | 'done' | 'failed';
  error?: string;
  /** Filled in once getConnectorDataStores (geminiConnector.ts) succeeds. */
  dataStoreIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'knowledgeConnectors';

export async function getKnowledgeConnector(
  appUserId: string,
  kind: KnowledgeConnector['kind'],
  siteUrl: string,
): Promise<KnowledgeConnector | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<KnowledgeConnector>(COLL).findOne({ appUserId, kind, siteUrl });
  } catch (e) {
    logger.warn(`getKnowledgeConnector read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function listKnowledgeConnectors(appUserId: string): Promise<KnowledgeConnector[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB).collection<KnowledgeConnector>(COLL).find({ appUserId }).toArray();
  } catch (e) {
    logger.warn(`listKnowledgeConnectors read failed: ${(e as Error).message}`);
    return [];
  }
}

/** Upsert on (appUserId, kind, siteUrl) — re-running setup for the same site updates in place. */
export async function upsertKnowledgeConnector(
  row: Omit<KnowledgeConnector, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    const { appUserId, kind, siteUrl, ...rest } = row;
    await getDb(config.CSGE_DB)
      .collection<KnowledgeConnector>(COLL)
      .updateOne(
        { appUserId, kind, siteUrl },
        { $set: { ...rest, updatedAt: now }, $setOnInsert: { appUserId, kind, siteUrl, createdAt: now } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`upsertKnowledgeConnector persist failed: ${(e as Error).message}`);
  }
}

export async function markKnowledgeConnectorStatus(
  appUserId: string,
  kind: KnowledgeConnector['kind'],
  siteUrl: string,
  patch: Partial<Pick<KnowledgeConnector, 'status' | 'error' | 'dataStoreIds'>>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<KnowledgeConnector>(COLL)
      .updateOne({ appUserId, kind, siteUrl }, { $set: { ...patch, updatedAt: new Date() } });
  } catch (e) {
    logger.warn(`markKnowledgeConnectorStatus persist failed: ${(e as Error).message}`);
  }
}

/**
 * Forget a stored connector so the next setup for this site starts
 * completely fresh — for re-testing, or when a customer rotates their Entra
 * secret and the old (now-invalid) connector needs to be redone. Does NOT
 * delete anything on Google's side — this only clears our own tracking row;
 * the actual Collection/DataConnector resource is left in place in Google
 * Cloud (deleting that is a separate, real, irreversible action a customer
 * should do deliberately, not something a "reset" button should do silently).
 */
export async function deleteKnowledgeConnector(
  appUserId: string,
  kind: KnowledgeConnector['kind'],
  siteUrl: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection<KnowledgeConnector>(COLL).deleteOne({ appUserId, kind, siteUrl });
  } catch (e) {
    logger.warn(`deleteKnowledgeConnector persist failed: ${(e as Error).message}`);
  }
}
