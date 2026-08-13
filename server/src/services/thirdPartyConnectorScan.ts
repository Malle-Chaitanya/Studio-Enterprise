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

import type { ConnectorReadiness } from '../connectors/operationBinding.js';
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
  /**
   * The exact connector operations the agent invokes, e.g. `ListIssues`,
   * `GetIssue_V2`. Knowing an agent "uses Jira" does not let anyone rebuild it —
   * Jira exposes dozens of operations and an agent selects specific ones. Only
   * populated by the agent-action path; Power Automate flows do not expose it here.
   */
  operations?: string[];
  /**
   * Whether each operation this agent uses can actually be reproduced against the vendor's
   * API, decided from the captured swagger index rather than from whether someone wrote a
   * registry entry. This is the customer-facing "will this migrate without errors?" answer,
   * and it is attached at detection time so it appears BEFORE a run, not in the report
   * after one. Absent when we hold no captured index for the connector.
   */
  readiness?: ConnectorReadiness;
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
 * Who owns a specific connector reference — NOT the same as who owns the parent
 * bot/agent. Two people can edit one agent; the bot's single `ownerid` does not
 * reflect who set up a LATER-added connector. `connectionreference` carries its own
 * `owninguser`, independent of the bot — see docs/connector-architecture-decisions.md
 * §12.5. This is a Microsoft/Dataverse identity, a hint for the Google-identity
 * matching in driveIdentityResolution.ts — never the actual Google account the
 * connector authenticated to (that is confirmed unfetchable, same doc, §12.2 row 1).
 *
 * VERIFIED against real tenants 2026-08-13: resolved correctly (owner ==
 * erik@filefuze.co) for real SharePoint/Office365 connection references on
 * orga243378d.crm.dynamics.com. The KEY finding from that test: only the NESTED
 * `connection.connectionReferenceLogicalName` value resolves — the dictionary key a
 * flow's clientdata uses (e.g. `shared_sharepointonline`) is never itself a real
 * logical name, so callers should query on the nested value, not the key.
 */
export interface ConnectionReferenceOwner {
  connectionReferenceLogicalName: string;
  ownerEmail: string;
  ownerName: string;
}

/**
 * Look up the owning user of ONE connection reference, by its logical name (the
 * nested `connection.connectionReferenceLogicalName` value read out of a flow's
 * clientdata — see summarizeFlows below). Returns null on any failure or if the
 * reference has no user owner (e.g. team-owned) — best-effort, never throws, matching
 * this project's extraction conventions.
 */
export async function getConnectionReferenceOwner(
  dvOrgUrl: string,
  dvToken: string,
  connectionReferenceLogicalName: string,
): Promise<ConnectionReferenceOwner | null> {
  const filter = encodeURIComponent(`connectionreferencelogicalname eq '${connectionReferenceLogicalName}'`);
  const select = 'connectionreferenceid,connectionreferencelogicalname';
  const expand = 'owninguser($select=fullname,internalemailaddress,domainname)';
  const url = `${dvOrgUrl}/api/data/v9.2/connectionreferences?$filter=${filter}&$select=${select}&$expand=${expand}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${dvToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      value?: Array<{ owninguser?: { fullname?: string; internalemailaddress?: string; domainname?: string } }>;
    };
    const row = json.value?.[0];
    const owner = row?.owninguser;
    const ownerEmail = owner?.internalemailaddress || owner?.domainname;
    if (!owner || !ownerEmail) return null;
    return {
      connectionReferenceLogicalName,
      ownerEmail,
      ownerName: owner.fullname ?? ownerEmail,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch and parse Power Automate flows from Dataverse, extract unique
 * third-party connector API names.
 */
/**
 * Fetch every Power Automate flow (category=5) in this environment, paged rather than
 * $top=100'd — a tenant with more than a page of flows would have had the rest
 * dropped silently, under-reporting which connectors the customer actually depends on.
 * Shared by detectThirdPartyConnectors and findConnectionReferenceLogicalNames so both
 * paginate identically.
 */
async function fetchPaFlows(dvOrgUrl: string, dvToken: string): Promise<PaFlow[]> {
  let url: string | null = `${dvOrgUrl}/api/data/v9.2/workflows?$filter=category eq 5&$select=workflowid,name,clientdata`;
  const flows: PaFlow[] = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${dvToken}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=100' },
    });
    if (!res.ok) return flows; // e.g. no PA flows license — return what we have, not an error
    const json = await res.json() as { value?: PaFlow[]; '@odata.nextLink'?: string };
    flows.push(...(json.value ?? []));
    url = json['@odata.nextLink'] ?? null;
  }
  return flows;
}

export async function detectThirdPartyConnectors(
  dvOrgUrl: string,
  dvToken: string,
): Promise<DetectedConnector[]> {
  return summarizeFlows(await fetchPaFlows(dvOrgUrl, dvToken));
}

/**
 * Every DISTINCT connection reference logical name this environment's flows use for
 * one connector — the nested `connection.connectionReferenceLogicalName` value, NOT
 * the dictionary key a flow's clientdata stores it under (confirmed live 2026-08-13:
 * the key, e.g. `shared_googledrive`, is never itself a resolvable logical name — see
 * getConnectionReferenceOwner's doc comment). Feeds driveIdentityResolution.ts's
 * environment-wide suggestion; environment-scoped because Microsoft's app-only API has
 * no reliable way to attribute one connection reference to one specific agent (see
 * docs/connector-architecture-decisions.md §12.2 row 1).
 */
export async function findConnectionReferenceLogicalNames(
  dvOrgUrl: string,
  dvToken: string,
  connectorId: string,
): Promise<string[]> {
  const flows = await fetchPaFlows(dvOrgUrl, dvToken);
  const names = new Set<string>();
  for (const flow of flows) {
    if (!flow.clientdata) continue;
    let parsed: {
      connectionReferences?: Record<string, ConnectionReference>;
      properties?: { connectionReferences?: Record<string, ConnectionReference> };
    };
    try {
      parsed = JSON.parse(flow.clientdata) as typeof parsed;
    } catch {
      continue;
    }
    const refs = parsed.properties?.connectionReferences ?? parsed.connectionReferences;
    if (!refs || typeof refs !== 'object') continue;
    for (const ref of Object.values(refs)) {
      if (ref.api?.name !== connectorId) continue;
      const logicalName = ref.connection?.connectionReferenceLogicalName;
      if (logicalName) names.add(logicalName);
    }
  }
  return [...names];
}

/** Group the flows' connection references into per-connector counts. */
function summarizeFlows(flows: PaFlow[]): DetectedConnector[] {

  // Map: connectorId → { flowCount, flowNames }
  const connectorMap = new Map<string, { flowCount: number; flowNames: string[] }>();
  // Connector api names found in flows that have no registry entry — reported, never
  // silently dropped.
  const unsupportedMap = new Map<string, { flowCount: number; flowNames: string[] }>();

  for (const flow of flows) {
    if (!flow.clientdata) continue;
    let parsed: {
      connectionReferences?: Record<string, ConnectionReference>;
      properties?: { connectionReferences?: Record<string, ConnectionReference> };
    };
    try {
      parsed = JSON.parse(flow.clientdata) as typeof parsed;
    } catch {
      continue;
    }

    // Two real clientdata shapes exist across flow types: some flows carry
    // connectionReferences at the top level, others (e.g. Copilot Studio's own
    // system child flows) nest everything under `properties`. Checking only one
    // silently missed every flow using the other shape — confirmed live against
    // org32322095.crm.dynamics.com, where all 116 flows use the nested form.
    const refs = parsed.properties?.connectionReferences ?? parsed.connectionReferences;
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
