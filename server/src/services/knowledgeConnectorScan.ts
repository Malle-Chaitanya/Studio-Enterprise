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
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import type { DetectedConnector } from './thirdPartyConnectorScan.js';

interface BotKsComponent {
  botcomponentid: string;
  name: string;
  data?: string;
  content?: string;
  parentbotid?: string;
}

const KNOWLEDGE_CONNECTOR_KINDS: Record<string, string> = {
  confluence: 'shared_confluence',
  // extend here as more knowledge connectors are supported
};

/**
 * Scan knowledge source botcomponents for a set of agents in one Dataverse org.
 * Returns detected connectors that need credentials.
 */
export async function detectKnowledgeConnectors(
  orgUrl: string,
  dvToken: string,
  botIds: string[],
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
    const filter = `componenttype eq 16 and Microsoft.Dynamics.CRM.In(PropertyName='parentbotid',PropertyValues=[${ids}])`;
    const url = `${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(filter)}&$select=botcomponentid,name,data,content,parentbotid&$top=500`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${dvToken}`,
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
        },
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'knowledgeConnectorScan: knowledge source fetch failed');
        continue;
      }
      const json = await res.json() as { value?: BotKsComponent[] };
      allComponents.push(...(json.value ?? []));
    } catch (err) {
      logger.warn({ err }, 'knowledgeConnectorScan: fetch error, skipping chunk');
    }
  }

  // Parse each knowledge source's YAML/JSON to find the source kind.
  const connectorHits = new Map<string, { flowCount: number; flowNames: Set<string> }>();

  for (const comp of allComponents) {
    const raw = comp.data || comp.content || '';
    const normalized = raw.toLowerCase();

    for (const [kindKey, connectorId] of Object.entries(KNOWLEDGE_CONNECTOR_KINDS)) {
      if (normalized.includes(kindKey)) {
        const existing = connectorHits.get(connectorId) ?? { flowCount: 0, flowNames: new Set() };
        existing.flowCount++;
        if (comp.name) existing.flowNames.add(comp.name);
        connectorHits.set(connectorId, existing);
      }
    }
  }

  const results: DetectedConnector[] = [];
  for (const [connectorId, hit] of connectorHits) {
    const def = REGISTRY_BY_ID.get(connectorId);
    if (!def) continue;
    results.push({
      connectorId,
      def,
      flowCount: hit.flowCount,
      flowNames: [...hit.flowNames],
    });
  }

  return results;
}
