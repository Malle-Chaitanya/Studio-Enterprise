import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * One row per (customer, Microsoft tenant) — tracks that CloudFuze has
 * already onboarded a tenant's Entra app so a NEW SharePoint/OneDrive site
 * under that same tenant can auto-provision a connector without asking the
 * admin again. The plaintext client secret is NEVER stored here — only the
 * GCP Secret Manager version reference (see services/secretManager.ts and
 * .claude/memory/decisions.md, 2026-08-03).
 */
export interface EntraAppCredential {
  appUserId: string;
  tenantId: string;
  clientId: string; // non-secret — fine to store
  /** Secret Manager resource name: projects/{project}/secrets/{id}/versions/{version}. NEVER the plaintext. */
  secretName: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'entraAppCredentials';

/** Look up an already-onboarded tenant's stored credential reference. */
export async function getEntraAppCredential(appUserId: string, tenantId: string): Promise<EntraAppCredential | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<EntraAppCredential>(COLL).findOne({ appUserId, tenantId });
  } catch (e) {
    logger.warn(`getEntraAppCredential read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Upsert the credential reference after a successful Secret Manager write. */
export async function upsertEntraAppCredential(
  appUserId: string,
  tenantId: string,
  clientId: string,
  secretName: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    await getDb(config.CSGE_DB)
      .collection<EntraAppCredential>(COLL)
      .updateOne(
        { appUserId, tenantId },
        { $set: { clientId, secretName, updatedAt: now }, $setOnInsert: { appUserId, tenantId, createdAt: now } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`upsertEntraAppCredential persist failed: ${(e as Error).message}`);
  }
}
