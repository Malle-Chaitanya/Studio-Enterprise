/**
 * Connector Credentials — generic Secret Manager storage for any connector's
 * OAuth / API credentials.
 *
 * Secret name pattern: studio-enterprise-{connectorId}-{field}
 *   e.g. studio-enterprise-shared-salesforce-client-id
 */

import { upsertSecret, grantSecretAccess } from './secretManager.js';
import { logger } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectorCred {
  field: string;
  value: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the Secret Manager secret ID for one connector credential field.
 * Underscores in both connectorId and field are converted to dashes so the ID
 * is a valid SM resource name segment.
 *
 * Example:
 *   connectorSecretId('shared_salesforce', 'client_id')
 *   // → 'studio-enterprise-shared-salesforce-client-id'
 */
export function connectorSecretId(connectorId: string, field: string): string {
  const safeId = connectorId.replace(/_/g, '-');
  const safeField = field.replace(/_/g, '-');
  return `studio-enterprise-${safeId}-${safeField}`;
}

/**
 * Return the Secret Manager access URL for a secret (used in generated YAML).
 *
 * Returns:
 *   https://secretmanager.googleapis.com/v1/projects/{projectId}/secrets/{secretId}/versions/latest:access
 */
export function smSecretUrl(projectId: string, secretId: string): string {
  return (
    `https://secretmanager.googleapis.com/v1/projects/${projectId}` +
    `/secrets/${secretId}/versions/latest:access`
  );
}

/**
 * Return a map of field → secretId for a connector (without values).
 * Used to build the connector prompt context for Hermas.
 *
 * Example:
 *   getConnectorSecretIds('shared_salesforce', ['client_id', 'client_secret'])
 *   // → { client_id: 'studio-enterprise-shared-salesforce-client-id', ... }
 */
export function getConnectorSecretIds(
  connectorId: string,
  fields: string[],
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field, connectorSecretId(connectorId, field)]),
  );
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Store one connector's credentials as individual SM secrets, then grant the
 * Workflows SA secretAccessor on each secret.
 *
 * Returns the SM secret IDs that were written.
 */
export async function upsertConnectorCredentials(
  gcpToken: string,
  projectId: string,
  connectorId: string,
  creds: ConnectorCred[],
  workflowsSaEmail: string,
): Promise<{ secretIds: string[] }> {
  logger.info(
    { projectId, connectorId, fieldCount: creds.length },
    'upsertConnectorCredentials: start',
  );

  const secretIds: string[] = [];

  for (const { field, value } of creds) {
    const secretId = connectorSecretId(connectorId, field);
    await upsertSecret(gcpToken, projectId, secretId, value);
    await grantSecretAccess(gcpToken, projectId, secretId, workflowsSaEmail);
    secretIds.push(secretId);
  }

  logger.info({ projectId, connectorId, secretIds }, 'upsertConnectorCredentials: done');
  return { secretIds };
}
