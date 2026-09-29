import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { ConnectorOpIndex } from '../../connectors/operationBinding.js';

/**
 * The pre-populated connector catalog: one row per connector, capturing what that
 * connector CAN do in general — not tied to any one customer's environment.
 *
 * Deliberately separate from `connectorOpIndexes` (db/repos/connectorOpIndex.ts), which is
 * a PER-CUSTOMER, per-environment cache scoped by `{scope, environmentId, connectorId}` —
 * that collection answers "what does THIS customer's copy of this connector look like right
 * now". This one answers "what does this connector look like, generally" and is filled in
 * ahead of a specific customer needing it, so a detected connector can be matched against it
 * immediately instead of waiting on a live per-environment capture.
 *
 * Not customer data: a connector's own operation list is the same fact for every customer who
 * has it (Dropbox's API doesn't change per customer), so this collection carries no
 * `appUserId`/`scope` — same treatment as the committed swagger fixtures already are.
 *
 * Collection: connectorCatalog.
 */

const COLL = 'connectorCatalog';

export interface ConnectorCatalogEntry {
  connectorId: string;
  displayName: string;
  /** 'microsoft-first-party' | 'third-party' | 'custom' — which pilot bucket this belongs to. */
  source: string;
  operationCount: number;
  index: ConnectorOpIndex;
  capturedAt: Date;
  /** Where this row's data came from, for the report: a live Power Platform capture vs.
   *  promoted from an existing per-customer capture already on file. */
  capturedFrom: string;
}

export async function getCatalogEntry(connectorId: string): Promise<ConnectorCatalogEntry | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<ConnectorCatalogEntry>(COLL).findOne({ connectorId });
  } catch (e) {
    logger.warn(`getCatalogEntry read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function listCatalogEntries(): Promise<ConnectorCatalogEntry[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB).collection<ConnectorCatalogEntry>(COLL).find({}).toArray();
  } catch (e) {
    logger.warn(`listCatalogEntries read failed: ${(e as Error).message}`);
    return [];
  }
}

export async function putCatalogEntry(
  connectorId: string,
  index: ConnectorOpIndex,
  source: string,
  capturedFrom: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<ConnectorCatalogEntry>(COLL)
      .updateOne(
        { connectorId },
        {
          $set: {
            connectorId,
            displayName: index.displayName || connectorId,
            source,
            operationCount: index.operationCount,
            index,
            capturedAt: new Date(),
            capturedFrom,
          },
        },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putCatalogEntry persist failed: ${(e as Error).message}`);
  }
}
