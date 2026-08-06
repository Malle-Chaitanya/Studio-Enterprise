/**
 * Scans Power Automate flows (PA flows, category=5) in Dataverse for
 * third-party connector references. Returns one entry per unique connector
 * found across all flows in the environment.
 *
 * Only connectors with entries in the CONNECTOR_REGISTRY are returned —
 * MS-native connectors (Teams, SharePoint, etc.) are in SKIP_CONNECTOR_IDS
 * and excluded because they use a separate Azure App Registration path.
 */

import { REGISTRY_BY_ID, SKIP_CONNECTOR_IDS } from '../connectors/registry.js';
import type { ConnectorDef } from '../connectors/registry.js';

export interface DetectedConnector {
  connectorId: string;
  def: ConnectorDef;
  flowCount: number;
  flowNames: string[];
}

interface PaFlow {
  workflowid: string;
  name: string;
  clientdata?: string;
}

interface ConnectionReference {
  api?: { name?: string };
  connection?: { connectionReferenceLogicalName?: string };
}

/**
 * Fetch and parse Power Automate flows from Dataverse, extract unique
 * third-party connector API names.
 */
export async function detectThirdPartyConnectors(
  dvOrgUrl: string,
  dvToken: string,
): Promise<DetectedConnector[]> {
  // category eq 5 = Power Automate modern flows
  const url = `${dvOrgUrl}/api/data/v9.2/workflows?$filter=category eq 5&$select=workflowid,name,clientdata&$top=100`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${dvToken}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    // If this fails (e.g. no PA flows license), return empty — not an error.
    return [];
  }

  const json = await res.json() as { value?: PaFlow[] };
  const flows: PaFlow[] = json.value ?? [];

  // Map: connectorId → { flowCount, flowNames }
  const connectorMap = new Map<string, { flowCount: number; flowNames: string[] }>();

  for (const flow of flows) {
    if (!flow.clientdata) continue;
    let parsed: { connectionReferences?: Record<string, ConnectionReference> };
    try {
      parsed = JSON.parse(flow.clientdata) as typeof parsed;
    } catch {
      continue;
    }

    const refs = parsed.connectionReferences;
    if (!refs || typeof refs !== 'object') continue;

    for (const ref of Object.values(refs)) {
      const apiName = ref.api?.name ?? ref.connection?.connectionReferenceLogicalName;
      if (!apiName) continue;

      // Skip MS-native connectors (handled separately)
      if (SKIP_CONNECTOR_IDS.has(apiName)) continue;
      // Skip if not in our registry
      if (!REGISTRY_BY_ID.has(apiName)) continue;

      const existing = connectorMap.get(apiName);
      if (existing) {
        existing.flowCount++;
        if (!existing.flowNames.includes(flow.name)) {
          existing.flowNames.push(flow.name);
        }
      } else {
        connectorMap.set(apiName, { flowCount: 1, flowNames: [flow.name] });
      }
    }
  }

  const results: DetectedConnector[] = [];
  for (const [connectorId, { flowCount, flowNames }] of connectorMap) {
    const def = REGISTRY_BY_ID.get(connectorId);
    if (def) {
      results.push({ connectorId, def, flowCount, flowNames });
    }
  }

  // Sort by flow count descending (most-used connectors first)
  results.sort((a, b) => b.flowCount - a.flowCount);
  return results;
}
