/**
 * Guards for the two ways a Confluence knowledge source can silently lose its migration.
 *
 * Both were found by review on 2026-08-13, before the routing change that would have
 * triggered them, and both are invisible at runtime: the agent deploys, reports success,
 * and simply cannot reach Confluence.
 *
 *  1. `agentConnectorIds` adds `shared_confluence` ONLY for the `confluence-crawler`
 *     strategy. Any future rerouting of these sources (to `rebuild-as-tool`, say) drops
 *     the connector from the agent's set, the orchestrator's per-agent filter removes the
 *     Confluence spec, and the agent ships with neither a data store NOR a tool.
 *  2. `aclLossItems` only fires for indexing strategies. Rerouting away from those turns
 *     off the acknowledgement gate that tells the customer Confluence permissions do not
 *     survive — while a live tool actually reads MORE than the crawl did.
 *
 * These tests do not forbid the reroute. They make it impossible to do it in one place
 * and forget the other two.
 */
import { describe, it, expect } from 'vitest';
import { agentConnectorIds } from './connectorToolBuilder.js';
import { aclLossItems } from './aclDisclosure.js';
import type { AgentIR } from '../types.js';

/** Minimal IR carrying one Confluence knowledge source. */
function irWithConfluence(strategy: string): AgentIR {
  return {
    sourceId: 'test-bot',
    name: 'test',
    displayName: 'Test',
    knowledgeSources: [
      {
        id: 'ks1',
        name: 'Engineering, Demo Company Wiki',
        kind: 'FederatedStructuredSearchSource',
        confluenceSpaceNames: ['Engineering', 'Demo Company Wiki'],
        classification: { strategy },
      },
    ],
    agentTools: [],
  } as unknown as AgentIR;
}

describe('a Confluence knowledge source keeps its connector and its disclosure', () => {
  it('wires shared_confluence for the crawl strategy', () => {
    expect(agentConnectorIds(irWithConfluence('confluence-crawler')).has('shared_confluence')).toBe(true);
  });

  it('discloses ACL loss for the crawl strategy', () => {
    const items = aclLossItems(irWithConfluence('confluence-crawler'));
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).toMatch(/confluence/i);
  });

  it('whatever strategy a Confluence source carries, it is either connected or disclosed — never neither', () => {
    // The real invariant. A source routed to a live tool must still bring its connector
    // (or it cannot call anything) and must still disclose (or the customer is not told
    // that a shared identity now reads their Confluence). Failing BOTH is the silent
    // regression; this asserts that combination can never ship.
    for (const strategy of ['confluence-crawler', 'rebuild-as-tool', 'manual-review']) {
      const ir = irWithConfluence(strategy);
      const connected = agentConnectorIds(ir).has('shared_confluence');
      const disclosed = aclLossItems(ir).length > 0;
      expect(
        connected || disclosed,
        `strategy "${strategy}" leaves a Confluence source with no connector AND no disclosure`,
      ).toBe(true);
    }
  });
});
