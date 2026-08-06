/**
 * Utilities for constructing Secret Manager secret IDs for connector credentials.
 * Naming convention: studio-enterprise-{connectorId}-{field}
 * (underscores → dashes to comply with SM naming rules)
 */

/** Build a Secret Manager secret ID for a connector credential field. */
export function connectorSecretId(connectorId: string, field: string): string {
  const safeId = connectorId.replace(/_/g, '-').toLowerCase();
  const safeField = field.replace(/_/g, '-').toLowerCase();
  return `studio-enterprise-${safeId}-${safeField}`;
}
