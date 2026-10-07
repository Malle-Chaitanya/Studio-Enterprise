import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIR } from '../types.js';
import type { ConnectorOpIndex } from './operationBinding.js';

/**
 * Whether what the swagger knows about an argument reaches the deployed tool.
 *
 * `buildBoundToolSpecs` is the last place the descriptive half of a parameter can be lost:
 * everything after it is Python reading `modelArgs`. The capture tests prove the facts are
 * read; these prove they survive the trip, and that the AUTHOR's own wording still wins
 * where they wrote one — a maker who renamed an argument for their users described the
 * behaviour their agent actually had.
 *
 * `resolveOpIndex` is mocked because the real one reaches Power Apps, then Mongo, then the
 * committed fixtures. None of those is the thing under test.
 */
vi.mock('./captureOpIndex.js', () => ({
  resolveOpIndex: vi.fn(),
}));

const { resolveOpIndex } = await import('./captureOpIndex.js');
const { buildBoundToolSpecs } = await import('./boundToolSpec.js');

const INDEX: ConnectorOpIndex = {
  connectorId: 'shared_hubspotcrm',
  displayName: 'HubSpot CRM',
  proxyHost: 'example.azure-apihub.net',
  proxyBasePath: '/apim/hubspotcrm',
  securityDefinitions: {},
  connectionAuth: {},
  operationCount: 1,
  operations: {
    CompaniesList: {
      method: 'GET',
      path: '/{connectionId}/crm/v3/objects/companies',
      summary: 'List companies',
      parameters: [
        { name: 'connectionId', in: 'path', required: true, type: 'string', visibility: 'internal' },
        {
          name: 'limit',
          in: 'query',
          required: false,
          type: 'integer',
          description: 'The maximum number of results to display per page.',
          default: 10,
        },
        {
          name: 'archived',
          in: 'query',
          required: false,
          type: 'string',
          description: 'Whether to return only results that have been archived.',
          enum: ['true', 'false'],
        },
        {
          name: 'body',
          in: 'body',
          required: false,
          type: 'object',
          description: 'The company to create.',
          schema: {
            type: 'object',
            required: ['properties'],
            properties: { properties: { type: 'object', description: 'Company property values.' } },
          },
        },
      ],
    },
  },
};

function agent(tool: Partial<NonNullable<AgentIR['agentTools']>[number]>): AgentIR {
  return {
    agentTools: [
      {
        name: 'HubSpot - List companies',
        kind: 'connector',
        connectorId: 'shared_hubspotcrm',
        operationId: 'CompaniesList',
        ...tool,
      },
    ],
  } as unknown as AgentIR;
}

beforeEach(() => {
  vi.mocked(resolveOpIndex).mockResolvedValue(INDEX);
});

describe('buildBoundToolSpecs — descriptive facts reach the deployed tool', () => {
  it('carries the swagger description, enum and default onto every model argument', async () => {
    const { byConnector } = await buildBoundToolSpecs(agent({}), undefined);
    const spec = byConnector.get('shared_hubspotcrm')?.[0];
    const byName = new Map((spec?.modelArgs ?? []).map((a) => [a.name, a]));

    expect(byName.get('limit')?.description).toBe('The maximum number of results to display per page.');
    expect(byName.get('limit')?.default).toBe(10);
    expect(byName.get('archived')?.enum).toEqual(['true', 'false']);
    expect(byName.get('body')?.schema?.required).toEqual(['properties']);
  });

  it("prefers the author's own wording for an argument over the connector's", async () => {
    const ir = agent({
      inputs: [{ name: 'limit', source: 'model', description: 'How many companies to fetch for this report.' }],
    } as never);
    const { byConnector } = await buildBoundToolSpecs(ir, undefined);
    const limit = byConnector.get('shared_hubspotcrm')?.[0].modelArgs.find((a) => a.name === 'limit');
    expect(limit?.description).toBe('How many companies to fetch for this report.');
    // The swagger's other facts still ride along — the author overrode the prose, not the
    // vendor's contract.
    expect(limit?.default).toBe(10);
  });

  it('drops the proxy plumbing rather than describing it to the model', async () => {
    const { byConnector } = await buildBoundToolSpecs(agent({}), undefined);
    const names = byConnector.get('shared_hubspotcrm')?.[0].modelArgs.map((a) => a.name);
    expect(names).not.toContain('connectionId');
  });

  it('leaves a pinned argument out of the signature, descriptions and all', async () => {
    const ir = agent({ inputs: [{ name: 'limit', source: 'pinned', value: '5' }] } as never);
    const { byConnector } = await buildBoundToolSpecs(ir, undefined);
    const spec = byConnector.get('shared_hubspotcrm')?.[0];
    expect(spec?.fixedArgs.limit).toEqual({ in: 'query', value: '5' });
    expect(spec?.modelArgs.map((a) => a.name)).not.toContain('limit');
  });
});
