import { describe, it, expect } from 'vitest';
import { buildBoundToolSpecs } from './boundToolSpec.js';
import type { AgentIR } from '../types.js';

/**
 * A query argument written in terms of COLUMN NAMES is only answerable if you know them.
 *
 * In Copilot the author picked fields from a table the product displayed. The migrated tool
 * had the same list all along — extraction captures it as `outputSchema` — and dropped it, so
 * the deployed model wrote `$filter` from the words in the question. Live 2026-10-14 it sent
 * `cr88d_name` at a table whose name column is `cr88d_clientname` and Dataverse answered
 * 0x80060888. These tests keep the list attached to the arguments that need it.
 */
const ir = (outputSchema: Array<{ name: string; type: string; path: string }>): AgentIR => ({
  sourceId: 'a1',
  name: 'Credit desk',
  instructions: 'x',
  description: 'd',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  topics: [],
  knowledgeSources: [],
  unmapped: [],
  agentTools: [{
    name: 'Microsoft Dataverse - List rows from selected environment',
    displayName: 'GetClientProfile',
    kind: 'connector',
    connectorId: 'shared_commondataserviceforapps',
    operationId: 'ListRecordsWithOrganization',
    inputs: [
      { name: 'organization', source: 'fixed', value: 'https://org1.crm.dynamics.com' },
      { name: 'entityName', source: 'fixed', value: 'cr88d_clientcreditfacilities' },
      { name: '$filter', source: 'model', value: null },
    ],
    outputSchema,
  }],
} as unknown as AgentIR);

const ROWS = [
  { name: 'value', type: 'Table', path: 'value' },
  { name: 'cr88d_clientname', type: 'String', path: 'value.cr88d_clientname' },
  { name: 'cr88d_email', type: 'String', path: 'value.cr88d_email' },
  { name: '_createdby_value', type: 'String', path: 'value._createdby_value' },
];

const filterArg = async (schema: typeof ROWS) => {
  const build = await buildBoundToolSpecs(ir(schema), undefined, {});
  const spec = [...build.byConnector.values()].flat()[0];
  return spec?.modelArgs.find((a) => a.name === '$filter');
};

describe('bound tool arguments carry the table columns', () => {
  it('names the real columns on $filter', async () => {
    const a = await filterArg(ROWS);
    expect(a?.description).toContain('cr88d_clientname');
    expect(a?.description).toContain('cr88d_email');
    // The instruction matters as much as the list: a model handed names with no rule still
    // reaches for a plausible-sounding one.
    expect(a?.description).toMatch(/do not invent/i);
  });

  it('leaves out the platform columns nobody filters on', async () => {
    // `_createdby_value` and friends are envelope, not the author's table. Listing forty of
    // them pushes the real columns out of view, which is the same failure by another route.
    const a = await filterArg(ROWS);
    expect(a?.description).not.toContain('_createdby_value');
  });

  it('says nothing when extraction captured no schema', async () => {
    // Silence is correct here. Inventing a column list would be worse than the guess it
    // replaces, because the model would trust it.
    const a = await filterArg([{ name: 'value', type: 'Table', path: 'value' }]);
    expect(a?.description ?? '').not.toMatch(/Columns on this table/);
  });
});
