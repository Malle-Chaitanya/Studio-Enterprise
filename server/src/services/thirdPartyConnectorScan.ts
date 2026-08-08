/**
 * Scans Power Automate flows (PA flows, category=5) in Dataverse for
 * third-party connector references. Returns one entry per unique connector
 * found across all flows in the environment.
 *
 * Only connectors with entries in the CONNECTOR_REGISTRY are returned —
 * Microsoft connectors ARE returned here too (this is the ACTION path; a
 * SharePoint/OneDrive *document* knowledge source is a separate concern,
 * handled by knowledgeClassifier.ts, not this registry).
 */

import { REGISTRY_BY_ID } from '../connectors/registry.js';
import type { ConnectorDef } from '../connectors/registry.js';

export interface DetectedConnector {
  connectorId: string;
  /** Absent when `unsupported` — we found the connector but have no way to call it. */
  def?: ConnectorDef;
  flowCount: number;
  flowNames: string[];
  /**
   * True when the flow uses a connector with no registry entry. Surfaced rather than
   * dropped: a customer whose agent depends on an unsupported connector must see that
   * in the report, not get a clean summary that quietly omits it.
   */
  unsupported?: boolean;
  /** Which selected agents actually use this connector. Empty when unknown. */
  agentNames?: string[];
  /**
   * 'certain'  — Copilot Studio named the connector structurally (kind enum, shared_*
   *              api name, or a connection reference).
   * 'heuristic'— inferred from user-editable text on a generic
   *              FederatedStructuredSearchSource, which the enum does not identify.
   * The UI must not present a heuristic hit as a requirement.
   */
  confidence?: 'certain' | 'heuristic';
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
  // Connector api names found in flows that have no registry entry — reported, never
  // silently dropped.
  const unsupportedMap = new Map<string, { flowCount: number; flowNames: string[] }>();

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

      // Two skips used to live here, both wrong for the ACTION path:
      //
      // 1. A SKIP_CONNECTOR_IDS list (since removed) dropped every Microsoft connector.
      //    That existed for the KNOWLEDGE path — SharePoint/OneDrive *documents* migrate
      //    as data stores, so they must not also be treated as knowledge connectors. But
      //    "send a Teams message" or "read a Planner task" is an ACTION, and those need a
      //    live Graph tool. Skipping by id made every Microsoft action connector invisible
      //    to the UI, so no credentials were ever collected for them. Now: skip only ids
      //    we have no registry entry for, since a registry entry IS the statement that we
      //    can call it.
      //
      // 2. Unknown ids were dropped silently, so a customer using a connector we do not
      //    support got a clean-looking report with no mention of it. That is a fidelity
      //    lie. Unknown ids are now returned with `unsupported: true` so the caller can
      //    report them honestly.
      if (!REGISTRY_BY_ID.has(apiName)) {
        const seen = unsupportedMap.get(apiName);
        if (seen) {
          seen.flowCount++;
          if (!seen.flowNames.includes(flow.name)) seen.flowNames.push(flow.name);
        } else {
          unsupportedMap.set(apiName, { flowCount: 1, flowNames: [flow.name] });
        }
        continue;
      }

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

  // Unsupported connectors ride along with no def, flagged so the UI can show them
  // as "detected, cannot migrate" and the report can record them as lost.
  for (const [connectorId, { flowCount, flowNames }] of unsupportedMap) {
    results.push({ connectorId, flowCount, flowNames, unsupported: true });
  }

  // Sort by flow count descending (most-used connectors first)
  results.sort((a, b) => b.flowCount - a.flowCount);
  return results;
}
