import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * WHICH Google identity one specific source agent's connector should impersonate.
 *
 * WHY THIS EXISTS: the Drive service account key is shared across a whole migration
 * (one key can impersonate anyone in the domain), but WHICH person's Drive an agent
 * should use is NOT shared — Erik's Copilot agent used Erik's Drive, Alex's used
 * Alex's. A single migration-wide "impersonate_email" (the earlier, simpler shape)
 * silently pointed every Drive-connected agent at the same person regardless of whose
 * Drive it actually needed. See docs/connector-architecture-decisions.md §12.5.
 *
 * `status` is never silently 'confirmed' by the system — only the admin confirming it
 * (or explicitly accepting a suggestion) sets that. A hint from Microsoft's side
 * (connectionreference owner) is a Microsoft identity, not proof of the Google account,
 * so it is stored as 'suggested' until a human accepts it.
 */
export interface AgentConnectorIdentity {
  appUserId: string;
  sourceId: string;
  connectorId: string;
  impersonateEmail: string;
  status: 'confirmed' | 'suggested' | 'needs-review';
  /** Why this email was suggested, shown to the admin verbatim — never invented. */
  suggestionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'agentConnectorIdentity';

export async function getAgentConnectorIdentity(
  appUserId: string,
  sourceId: string,
  connectorId: string,
): Promise<AgentConnectorIdentity | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<AgentConnectorIdentity>(COLL).findOne({ appUserId, sourceId, connectorId });
  } catch (e) {
    logger.warn(`getAgentConnectorIdentity read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Every identity assignment recorded for this customer, for the SelectData/Connectors screen. */
export async function listAgentConnectorIdentities(
  appUserId: string,
  connectorId?: string,
): Promise<AgentConnectorIdentity[]> {
  if (!isDbConnected()) return [];
  try {
    const filter = connectorId ? { appUserId, connectorId } : { appUserId };
    return await getDb(config.CSGE_DB).collection<AgentConnectorIdentity>(COLL).find(filter).toArray();
  } catch (e) {
    logger.warn(`listAgentConnectorIdentities read failed: ${(e as Error).message}`);
    return [];
  }
}

export async function upsertAgentConnectorIdentity(
  appUserId: string,
  sourceId: string,
  connectorId: string,
  fields: { impersonateEmail: string; status: AgentConnectorIdentity['status']; suggestionReason?: string },
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    await getDb(config.CSGE_DB).collection<AgentConnectorIdentity>(COLL).updateOne(
      { appUserId, sourceId, connectorId },
      {
        $set: { ...fields, appUserId, sourceId, connectorId, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`upsertAgentConnectorIdentity persist failed: ${(e as Error).message}`);
  }
}
