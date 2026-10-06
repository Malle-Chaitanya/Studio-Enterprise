import { describe, it, expect } from 'vitest';
import { distil, distilOriginalSwagger } from './captureOpIndex.js';

/**
 * What a connector's swagger says about an ARGUMENT, and whether it survives the capture.
 *
 * These assert the half of the index that was being dropped on the floor: descriptions,
 * enums, defaults and `$ref` body shapes. Measured before this existed, across the twelve
 * committed fixtures: 0 of 4,174 parameters carried a description and 385 of 1,134
 * operations declared a body typed as the bare word `object`. Every one of those facts was
 * in the swagger we had already fetched.
 *
 * `distil()` (the Power Apps proxy document) and `distilOriginalSwagger()` (a custom
 * connector's own upload) now share ONE parameter reader, so the shape assertions below
 * hold for both by construction — which is the point of having de-duplicated it. The two
 * are still both exercised, because what they do NOT share is handing it the `definitions`
 * map, and a `$ref` that silently resolves to nothing looks exactly like a vendor that
 * documents no fields.
 */

/** A Power Apps swagger, in the envelope `captureOpIndex` receives it in. */
function powerAppsBody(swagger: Record<string, unknown>): Record<string, unknown> {
  return { properties: { displayName: 'Test Connector', swagger } };
}

const JIRA_LIKE = {
  host: 'example.azure-apihub.net',
  basePath: '/apim/test',
  paths: {
    '/{connectionId}/3/search': {
      get: {
        operationId: 'SearchIssues',
        summary: 'Search issues',
        parameters: [
          { name: 'connectionId', in: 'path', required: true, type: 'string', 'x-ms-visibility': 'internal' },
          {
            name: 'jql',
            in: 'query',
            required: false,
            type: 'string',
            description: 'A JQL expression that selects the issues to return.',
          },
          {
            name: 'order',
            in: 'query',
            required: false,
            type: 'string',
            enum: ['asc', 'desc'],
            default: 'desc',
          },
          { name: 'maxResults', in: 'query', required: false, type: 'integer', default: 50 },
        ],
      },
    },
    '/{connectionId}/3/issue': {
      post: {
        operationId: 'CreateIssue',
        summary: 'Create issue',
        parameters: [
          {
            name: 'body',
            in: 'body',
            required: true,
            description: 'The issue to create.',
            schema: { $ref: '#/definitions/IssueCreate' },
          },
        ],
      },
    },
  },
  definitions: {
    IssueCreate: {
      type: 'object',
      required: ['fields'],
      properties: {
        fields: { $ref: '#/definitions/IssueFields' },
        historyMetadata: { type: 'string', description: 'Free-form audit note.' },
      },
    },
    IssueFields: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line title.' },
        labels: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function params(index: ReturnType<typeof distil>, operationId: string) {
  const op = index?.operations[operationId];
  if (!op) throw new Error(`no operation ${operationId}`);
  return new Map(op.parameters.map((p) => [p.name, p]));
}

describe('distil — what the model is told about an argument', () => {
  it('keeps the swagger description, which no Copilot agent stores per argument', () => {
    const byName = params(distil('shared_test', powerAppsBody(JIRA_LIKE)), 'SearchIssues');
    expect(byName.get('jql')?.description).toBe('A JQL expression that selects the issues to return.');
  });

  it('keeps enums and defaults', () => {
    const byName = params(distil('shared_test', powerAppsBody(JIRA_LIKE)), 'SearchIssues');
    expect(byName.get('order')?.enum).toEqual(['asc', 'desc']);
    expect(byName.get('order')?.default).toBe('desc');
    expect(byName.get('maxResults')?.default).toBe(50);
  });

  it('leaves description unset rather than empty, so a consumer fallback can fire', () => {
    const byName = params(distil('shared_test', powerAppsBody(JIRA_LIKE)), 'SearchIssues');
    // `connectionId` documents nothing. An empty string here would defeat every
    // `description || name` fallback downstream and show the model a blank.
    expect(byName.get('connectionId')).not.toHaveProperty('description');
  });

  it('resolves a $ref body into a real shape instead of the word "object"', () => {
    const byName = params(distil('shared_test', powerAppsBody(JIRA_LIKE)), 'CreateIssue');
    const body = byName.get('body');
    expect(body?.schema?.type).toBe('object');
    expect(body?.schema?.required).toEqual(['fields']);
    // Nested through a second $ref — the shape the model actually has to fill.
    expect(body?.schema?.properties?.fields.properties?.summary.description).toBe('One-line title.');
    expect(body?.schema?.properties?.fields.properties?.labels.items?.type).toBe('string');
    expect(body?.schema?.truncated).toBeUndefined();
  });
});

describe('distil — bounded expansion', () => {
  it('stops at a $ref cycle and says the shape is partial', () => {
    const recursive = {
      host: 'h',
      basePath: '/',
      paths: {
        '/{connectionId}/x': {
          post: {
            operationId: 'Recursive',
            parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Node' } }],
          },
        },
      },
      definitions: {
        Node: {
          type: 'object',
          properties: { name: { type: 'string' }, child: { $ref: '#/definitions/Node' } },
        },
      },
    };
    const byName = params(distil('shared_test', powerAppsBody(recursive)), 'Recursive');
    const schema = byName.get('body')?.schema;
    expect(schema?.properties?.name.type).toBe('string');
    // The cycle ends the branch, and the cut is announced — a body missing a field must
    // never read as a body that has no such field.
    expect(schema?.properties?.child.truncated).toBe(true);
    expect(schema?.truncated).toBe(true);
  });

  it('expands the same sub-object in two sibling fields', () => {
    // The cycle guard tracks the current BRANCH, not every ref visited. Tracking it
    // globally blanked the second sibling, which is indistinguishable from a vendor that
    // does not document the field.
    const siblings = {
      host: 'h',
      basePath: '/',
      paths: {
        '/{connectionId}/x': {
          post: {
            operationId: 'Siblings',
            parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pair' } }],
          },
        },
      },
      definitions: {
        Pair: {
          type: 'object',
          properties: { from: { $ref: '#/definitions/Person' }, to: { $ref: '#/definitions/Person' } },
        },
        Person: { type: 'object', properties: { email: { type: 'string' } } },
      },
    };
    const schema = params(distil('shared_test', powerAppsBody(siblings)), 'Siblings').get('body')?.schema;
    expect(schema?.properties?.from.properties?.email.type).toBe('string');
    expect(schema?.properties?.to.properties?.email.type).toBe('string');
  });

  it('caps a wide schema and admits the cut', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 120; i++) wide[`field${i}`] = { type: 'string' };
    const body = {
      host: 'h',
      basePath: '/',
      paths: {
        '/{connectionId}/x': {
          post: {
            operationId: 'Wide',
            parameters: [{ name: 'body', in: 'body', required: true, schema: { type: 'object', properties: wide } }],
          },
        },
      },
    };
    const schema = params(distil('shared_test', powerAppsBody(body)), 'Wide').get('body')?.schema;
    expect(Object.keys(schema?.properties ?? {})).toHaveLength(40);
    expect(schema?.truncated).toBe(true);
  });

  it('resolves an unknown $ref to a partial object rather than dropping the parameter', () => {
    const dangling = {
      host: 'h',
      basePath: '/',
      paths: {
        '/{connectionId}/x': {
          post: {
            operationId: 'Dangling',
            parameters: [
              // OpenAPI 3 spelling, which these Swagger 2.0 documents never use. Guessed
              // at, it would become a body shape we invented.
              { name: 'body', in: 'body', required: true, schema: { $ref: '#/components/schemas/Thing' } },
            ],
          },
        },
      },
    };
    const body = params(distil('shared_test', powerAppsBody(dangling)), 'Dangling').get('body');
    expect(body).toBeDefined();
    expect(body?.schema).toEqual({ type: 'object', truncated: true });
  });
});

describe('distilOriginalSwagger — the same reader, a different document', () => {
  it('reads descriptions and $ref bodies from a custom connector definition', () => {
    const result = distilOriginalSwagger('shared_custom', 'Custom', {
      host: 'api.vendor.com',
      basePath: '/v1',
      schemes: ['https'],
      securityDefinitions: { k: { type: 'apiKey', in: 'header', name: 'Authorization' } },
      paths: {
        '/deals': {
          post: {
            operationId: 'CreateDeal',
            description: 'Create a deal.',
            parameters: [
              { name: 'dealId', in: 'query', required: true, type: 'string', description: 'The deal id.' },
              { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Deal' } },
            ],
          },
        },
      },
      definitions: { Deal: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } } },
    });
    const op = result?.index.operations.CreateDeal;
    const byName = new Map((op?.parameters ?? []).map((p) => [p.name, p]));
    expect(byName.get('dealId')?.description).toBe('The deal id.');
    expect(byName.get('body')?.schema?.required).toEqual(['amount']);
    expect(byName.get('body')?.schema?.properties?.amount.type).toBe('number');
    // The resolved schema also corrects the type, which used to default to `object`.
    expect(byName.get('body')?.type).toBe('object');
  });
});
