/**
 * Connector Scanner — scans a list of FlowIR objects and returns unique connectors
 * with their auth type, flow counts, and Google equivalent info.
 */

import type { FlowIR } from '../types.js';
import { CONNECTOR_REGISTRY, isDataverseConnector } from './connectorRegistry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectorAuthType =
  | 'ms-graph'
  | 'dataverse'
  | 'oauth2'
  | 'apikey'
  | 'basic'
  | 'unknown';

export interface ScannedConnector {
  connectorId: string;
  displayName: string;
  authType: ConnectorAuthType;
  flowCount: number;
  flowNames: string[];
  hasGoogleEquivalent: boolean;
  googleEquivalent: string | null;
  credentialsNeeded: string[];
}

// ── Auth-type resolution ──────────────────────────────────────────────────────

const MS_GRAPH_CONNECTORS = new Set([
  'shared_teams',
  'shared_sharepointonline',
  'shared_office365',
  'shared_outlook',
  'shared_onedrive',
  'shared_planner',
  'shared_excelonline',
]);

function resolveAuthType(connectorId: string): ConnectorAuthType {
  if (isDataverseConnector(connectorId)) return 'dataverse';
  if (MS_GRAPH_CONNECTORS.has(connectorId)) return 'ms-graph';
  return 'unknown';
}

function resolveCredentialsNeeded(authType: ConnectorAuthType): string[] {
  switch (authType) {
    case 'ms-graph':
      return ['ms_refresh_token'];
    case 'dataverse':
      return [];
    default:
      return ['client_id', 'client_secret', 'refresh_token'];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a list of FlowIR objects and return unique connectors with metadata.
 * Connectors are deduped by apiName; flowCount and flowNames track usage.
 */
export function scanConnectors(flows: FlowIR[]): ScannedConnector[] {
  // Map connectorId -> { flowNames, entry }
  const map = new Map<
    string,
    { flowNames: Set<string>; displayName: string }
  >();

  for (const flow of flows) {
    for (const connector of flow.connectors) {
      const id = connector.apiName;
      const existing = map.get(id);
      if (existing) {
        existing.flowNames.add(flow.name);
      } else {
        map.set(id, {
          flowNames: new Set([flow.name]),
          displayName: connector.displayName,
        });
      }
    }
  }

  const results: ScannedConnector[] = [];

  for (const [connectorId, { flowNames, displayName }] of map) {
    const authType = resolveAuthType(connectorId);
    const credentialsNeeded = resolveCredentialsNeeded(authType);
    const registryEntry = CONNECTOR_REGISTRY[connectorId];

    results.push({
      connectorId,
      displayName: registryEntry?.displayName ?? displayName,
      authType,
      flowCount: flowNames.size,
      flowNames: Array.from(flowNames),
      hasGoogleEquivalent: registryEntry?.googleEquivalent != null,
      googleEquivalent: registryEntry?.googleEquivalent ?? null,
      credentialsNeeded,
    });
  }

  return results;
}
