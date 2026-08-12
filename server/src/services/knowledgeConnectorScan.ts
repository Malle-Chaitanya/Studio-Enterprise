/**
 * Scans Dataverse botcomponents (knowledge sources, componenttype 16) for
 * specific agents and returns which knowledge connectors need credentials.
 *
 * Separate from thirdPartyConnectorScan because:
 *  - PA flows → connector references (flow connectors)
 *  - KnowledgeSourceConfiguration YAML → source.kind (knowledge connectors)
 * Both need credentials from the user; only the detection path differs.
 */

import { logger } from '../logger.js';
import { readinessForCustomer } from '../connectors/readiness.js';
import type { CaptureContext } from '../connectors/captureOpIndex.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import type { DetectedConnector } from './thirdPartyConnectorScan.js';

interface BotKsComponent {
  /** Owning agent — lets us attribute a connector to the agent that needs it. */
  _parentbotid_value?: string;
  /** Carries the human description, which names the product for federated sources. */
  description?: string;
  /** e.g. `crf37_Confluenceagent.topic...` — also names the product. */
  schemaname?: string;
  botcomponentid: string;
  name: string;
  data?: string;
  content?: string;
  parentbotid?: string;
}

/**
 * Copilot Studio's own `kind:` enum for a knowledge source → the connector it implies.
 * These are STRUCTURAL: the enum is emitted by the product, not typed by a person, so a
 * match here is a fact rather than a guess.
 */
const SOURCE_KIND_TO_CONNECTOR: Record<string, string> = {
  sharepointsearchsource: 'shared_sharepointonline',
  sharepointknowledgesource: 'shared_sharepointonline',
  onedrivesearchsource: 'shared_onedrive',
  dataversestructuredsearchsource: '', // Dataverse — migrated as a snapshot, no credentials
  publicsitesearchsource: '',          // public website — no credentials
};

/**
 * Product names to look for ONLY inside a FederatedStructuredSearchSource, which is the
 * generic kind Copilot Studio uses for every federated connector. The enum says
 * "federated" and nothing more, so the product identity has to come from
 * `skillConfiguration` / `schemaname` / `description` — all of which a user can edit or
 * misspell (one source in the test tenant reads "confulence"). Any match here is
 * therefore reported as a HEURISTIC, never as fact.
 */
const FEDERATED_TEXT_HINTS: Record<string, string> = {
  confluence: 'shared_confluence',
  jira: 'shared_jira',
  servicenow: 'shared_servicenow',
  zendesk: 'shared_zendesk',
  salesforce: 'shared_salesforce',
};

/**
 * Scan knowledge source botcomponents for a set of agents in one Dataverse org.
 * Returns detected connectors that need credentials.
 */
export async function detectKnowledgeConnectors(
  orgUrl: string,
  dvToken: string,
  botIds: string[],
  /** botId → agent name, so the UI can say WHICH agent needs each connector rather
   *  than showing one undifferentiated list. */
  botNames?: Map<string, string>,
  /**
   * Lets readiness be answered from the CUSTOMER'S own connector definitions instead of a
   * capture of ours. Optional so offline and test callers still work — without it the
   * answer falls back to the committed fixtures, which is a different tenant's view.
   */
  captureCtx?: CaptureContext,
): Promise<DetectedConnector[]> {
  if (botIds.length === 0) return [];

  const base = orgUrl.replace(/\/$/, '');
  // Dataverse OData: filter by componenttype 16 (knowledge source) and parent bot
  // OData `in` filter supports up to ~50 values; chunk if needed.
  const chunks: string[][] = [];
  for (let i = 0; i < botIds.length; i += 40) {
    chunks.push(botIds.slice(i, i + 40));
  }

  const allComponents: BotKsComponent[] = [];
  for (const chunk of chunks) {
    const ids = chunk.map((id) => `'${id}'`).join(',');
    // componenttype 9 (topics) as well as 16 (knowledge sources): a connector can be used
    // as a TOOL inside a topic — `kind: ConnectorTool` with an explicit connectorId — and
    // that is invisible to a knowledge-source-only scan. The "confluence agent" in the test
    // tenant has exactly this shape and appeared to have no connectors at all.
    const filter = `(componenttype eq 16 or componenttype eq 9) and Microsoft.Dynamics.CRM.In(PropertyName='parentbotid',PropertyValues=[${ids}])`;
    // Paged, not capped: a truncated component list here means a connector the agent really
    // uses is never detected, so the UI never asks for its credentials and the tool fails at
    // run time with nothing in the report explaining why.
    let url: string | null =
      `${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(filter)}&$select=botcomponentid,name,data,content,description,schemaname,_parentbotid_value`;
    try {
      while (url) {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${dvToken}`,
            Accept: 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
            Prefer: 'odata.maxpagesize=500',
          },
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'knowledgeConnectorScan: knowledge source fetch failed');
          break;
        }
        const json = await res.json() as { value?: BotKsComponent[]; '@odata.nextLink'?: string };
        allComponents.push(...(json.value ?? []));
        url = json['@odata.nextLink'] ?? null;
      }
    } catch (err) {
      logger.warn({ err }, 'knowledgeConnectorScan: fetch error, skipping chunk');
    }
  }

  // Two-tier detection.
  //
  // Tier 1 — STRUCTURAL: the `kind:` enum, and any `shared_*` api name that appears in
  // a connection reference or an InvokeConnectorTaskAction. Both are emitted by Copilot
  // Studio itself, so a hit is certain.
  //
  // Tier 2 — HEURISTIC: for FederatedStructuredSearchSource the enum reveals nothing
  // beyond "federated", so we fall back to product names in skillConfiguration /
  // schemaname / description. Those fields are user-editable, so these hits are marked
  // `heuristic` and must be presented to the customer as "we think", not "you need".
  const connectorHits = new Map<
    string,
    {
      flowCount: number;
      flowNames: Set<string>;
      agentNames: Set<string>;
      certain: boolean;
      operations: Set<string>;
    }
  >();

  const record = (connectorId: string, comp: BotKsComponent, certain: boolean, operation?: string): void => {
    if (!connectorId) return; // sources that need no credentials (Dataverse, public site)
    const existing = connectorHits.get(connectorId)
      ?? { flowCount: 0, flowNames: new Set<string>(), agentNames: new Set<string>(), certain: false, operations: new Set<string>() };
    existing.flowCount++;
    existing.certain = existing.certain || certain;
    if (comp.name) existing.flowNames.add(comp.name);
    if (operation) existing.operations.add(operation);
    const owner = comp._parentbotid_value;
    if (owner && botNames?.get(owner)) existing.agentNames.add(botNames.get(owner)!);
    connectorHits.set(connectorId, existing);
  };

  for (const comp of allComponents) {
    const data = comp.data || comp.content || '';

    // On an agent action the operation sits alongside the connection reference, so
    // capture it in the same pass — it is the difference between "needs Jira
    // credentials" and "calls ListIssues, GetIssue_V2, …".
    const operationId = /^\s*operationId:\s*(\S+)\s*$/m.exec(data)?.[1];

    // Tier 1a — api names appearing structurally (connection references, connector actions).
    for (const m of data.matchAll(/\bshared_[a-z0-9_]+/gi)) {
      record(m[0].toLowerCase(), comp, true, operationId);
    }

    // Tier 1b — the source kind enum.
    const kindMatch = /source:\s*[\s\S]*?\bkind:\s*([A-Za-z0-9_]+)/.exec(data);
    const sourceKind = kindMatch?.[1]?.toLowerCase() ?? '';
    if (sourceKind && sourceKind in SOURCE_KIND_TO_CONNECTOR) {
      record(SOURCE_KIND_TO_CONNECTOR[sourceKind], comp, true);
      continue;
    }

    // Tier 2 — federated sources only.
    if (sourceKind === 'federatedstructuredsearchsource') {
      const haystack = [comp.data, comp.content, comp.description, comp.schemaname]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      for (const [hint, connectorId] of Object.entries(FEDERATED_TEXT_HINTS)) {
        if (haystack.includes(hint)) {
          record(connectorId, comp, false);
          break;
        }
      }
    }
  }

  const results: DetectedConnector[] = [];
  for (const [connectorId, hit] of connectorHits) {
    const def = REGISTRY_BY_ID.get(connectorId);
    // A connector with no registry entry is one we cannot CALL — it is not one the
    // customer does not have. Dropping it here produced a clean-looking report that
    // never mentioned it: "Enterprise Migration Knowledge" uses shared_hubspotcrmv2
    // and shared_cdataconnectai, and neither appeared anywhere in the UI or the
    // report (live 2026-08-07). thirdPartyConnectorScan already calls this exact
    // behaviour a fidelity lie and returns `unsupported: true`; this scanner now
    // does the same instead of contradicting it.
    results.push({
      connectorId,
      def,
      flowCount: hit.flowCount,
      flowNames: [...hit.flowNames],
      agentNames: [...hit.agentNames],
      // 'certain' when Copilot Studio itself named the connector; 'heuristic' when we
      // inferred it from editable text on a generic federated source.
      confidence: hit.certain ? 'certain' : 'heuristic',
      unsupported: def ? undefined : true,
      // The exact operations this agent invokes. "Uses Jira" is not enough to rebuild
      // an agent — Jira exposes dozens of operations and this one chose five.
      operations: hit.operations.size ? [...hit.operations].sort() : undefined,
      // Whether we can actually reproduce those operations, decided from the captured
      // swagger rather than from whether a registry entry happens to exist. A connector
      // can be `unsupported` (no registry entry) and still fully bindable — Dataverse is
      // exactly that case — so the two flags are answering different questions and both
      // are reported.
      readiness: await readinessForCustomer(
        connectorId,
        hit.operations.size ? [...hit.operations] : undefined,
        captureCtx,
      ),
    });
  }

  return results;
}
