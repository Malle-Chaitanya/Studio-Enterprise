import { describe, it, expect } from 'vitest';
import {
  parseToolInputs,
  parseOutputSchema,
  parseMcpBinding,
  parseFlowId,
  parseAiPluginRef,
} from './toolPayload.js';

/**
 * The payloads below reproduce the STRUCTURES observed live on 2026-08-12
 * (docs/verification-ledger.md §1.12) with neutral names and values. Customer business
 * logic — table names, filters, prompt text — is not committed to this repo, and the
 * parser cares about shape, not content.
 *
 * This is a multi-tenant product, so several cases here are deliberately about payloads
 * this tenant does NOT produce: unknown input kinds, a missing allow-list, absent blocks.
 * Those are the shapes that will show up first at a customer.
 */

const CONNECTOR_TOOL = `kind: TaskDialog
inputs:
  - kind: ManualTaskInput
    propertyName: organization
    value: current

  - kind: ManualTaskInput
    propertyName: entityName
    value: sample_jobs

  - kind: ManualTaskInput
    propertyName: "'$filter'"
    value: =Concatenate("status eq '", Global.SelectedValue, "'")

  - kind: ManualTaskInput
    propertyName: "'$top'"
    value: 1

  - kind: AutomaticTaskInput
    propertyName: SearchTerm
    description: What to search for
    entity: StringPrebuiltEntity

modelDisplayName: Get Job
modelDescription: Fetch a job by status.
outputs:
  - propertyName: value
    name: Records
    description: Matching rows

action:
  kind: InvokeConnectorTaskAction
  connectionReference: pub_Agent.shared_commondataserviceforapps.abc123
  connectionProperties:
    mode: Invoker

  operationId: ListRecordsWithOrganization
  dynamicOutputSchema:
    kind: Record
    properties:
      value:
        order: 0
        type:
          kind: Table
          properties:
            sample_jobid:
              order: 0
              type: String
            sample_stage:
              order: 1
              type: Number

outputMode: All
`;

describe('parseToolInputs — the arguments the author bound', () => {
  const inputs = parseToolInputs(CONNECTOR_TOOL);

  it('reads every input, fixed and model-filled alike', () => {
    expect(inputs.map((i) => i.name)).toEqual([
      'organization',
      'entityName',
      '$filter',
      '$top',
      'SearchTerm',
    ]);
  });

  it('unquotes OData property names so they match the swagger parameter', () => {
    // The payload writes them as "'$filter'" — two layers of quoting.
    expect(inputs.find((i) => i.name === '$filter')).toBeTruthy();
  });

  it('separates pinned values from what the model fills', () => {
    expect(inputs.find((i) => i.name === 'entityName')).toMatchObject({
      source: 'fixed',
      value: 'sample_jobs',
    });
    expect(inputs.find((i) => i.name === 'SearchTerm')).toMatchObject({
      source: 'model',
      entity: 'StringPrebuiltEntity',
      description: 'What to search for',
    });
  });

  // A Power Fx value copied through as a literal would send the word "Concatenate" to the
  // vendor. Flagging it is what lets the caller demote it instead.
  it('flags a Power Fx expression rather than treating it as a literal', () => {
    const filter = inputs.find((i) => i.name === '$filter')!;
    expect(filter.source).toBe('fixed');
    expect(filter.isExpression).toBe(true);
    expect(inputs.find((i) => i.name === 'entityName')!.isExpression).toBeUndefined();
  });

  it('preserves an input kind it does not recognise instead of dropping it', () => {
    const odd = parseToolInputs(`inputs:
  - kind: SomeFutureTaskInput
    propertyName: mystery
    value: 7
`);
    expect(odd).toHaveLength(1);
    expect(odd[0]).toMatchObject({ name: 'mystery', source: 'unknown', rawKind: 'SomeFutureTaskInput' });
  });

  it('returns nothing for a tool with no inputs, and does not throw', () => {
    expect(parseToolInputs('kind: TaskDialog\naction:\n  kind: InvokeFlowTaskAction\n')).toEqual([]);
    expect(parseToolInputs('')).toEqual([]);
  });
});

describe('parseOutputSchema — the declared result shape', () => {
  it('flattens nested columns and keeps their path', () => {
    const fields = parseOutputSchema(CONNECTOR_TOOL);
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('value');
    expect(paths).toContain('value.sample_jobid');
    expect(fields.find((f) => f.path === 'value.sample_stage')?.type).toBe('Number');
  });

  it('is empty, not an error, when the tool declares no schema', () => {
    expect(parseOutputSchema('kind: TaskDialog\n')).toEqual([]);
  });
});

describe('parseMcpBinding — an MCP server and what it was allowed to do', () => {
  const MCP_TOOL = `kind: TaskDialog
modelDisplayName: Issue Server
modelDescription: Issue Server
action:
  kind: InvokeExternalAgentTaskAction
  connectionReference: pub_Agent.shared_jira.def456
  connectionProperties:
    mode: Invoker

  operationDetails:
    kind: ModelContextProtocolMetadata
    operationId: mcp_IssueManagement
    tools:
      kind: UseSpecificTools
      tools:
        - GetCurrentUser
        - ListIssues
        - ListProjects
`;

  it('reads the operation and the allow-listed tools', () => {
    const mcp = parseMcpBinding(MCP_TOOL)!;
    expect(mcp.operationId).toBe('mcp_IssueManagement');
    expect(mcp.toolSelection).toBe('specific');
    expect(mcp.tools).toEqual(['GetCurrentUser', 'ListIssues', 'ListProjects']);
  });

  // Migrating an MCP server without its allow-list would give the agent MORE tools than the
  // source had. So an absent list must never widen to "all".
  it('reports an absent selection as unknown, never as all', () => {
    const mcp = parseMcpBinding(`action:
  kind: InvokeExternalAgentTaskAction
  operationDetails:
    kind: ModelContextProtocolMetadata
    operationId: mcp_Thing
`)!;
    expect(mcp.toolSelection).toBe('unknown');
    expect(mcp.tools).toBeUndefined();
  });

  it('is undefined for a tool that is not an MCP server', () => {
    expect(parseMcpBinding(CONNECTOR_TOOL)).toBeUndefined();
  });
});

describe('parseFlowId / parseAiPluginRef', () => {
  it('reads the flow id a tool invokes', () => {
    expect(parseFlowId('action:\n  kind: InvokeFlowTaskAction\n  flowId: 11111111-2222-3333-4444-555555555555\n'))
      .toBe('11111111-2222-3333-4444-555555555555');
  });

  it('reads the plugin identity from entityKey', () => {
    const ref = parseAiPluginRef(`action:
  kind: InvokeAIPluginTaskAction
  entityKey: aiplugin.name=aiplugin_UpdateArticle,operationid=aiplugin_UpdateArticle
`)!;
    expect(ref.name).toBe('aiplugin_UpdateArticle');
    expect(ref.operationId).toBe('aiplugin_UpdateArticle');
  });

  it('ignores an entityKey that is not a plugin', () => {
    expect(parseAiPluginRef('action:\n  entityKey: something.else=1\n')).toBeUndefined();
  });

  it('returns undefined rather than throwing on an empty payload', () => {
    expect(parseFlowId('')).toBeUndefined();
    expect(parseAiPluginRef('')).toBeUndefined();
  });
});
