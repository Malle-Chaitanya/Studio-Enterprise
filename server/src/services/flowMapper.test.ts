import { describe, it, expect } from 'vitest';
import { translateFlow, integrationNameForFlow } from './flowMapper.js';
import type { FlowIR } from '../types.js';

// Fixtures below mirror the REAL shapes this session extracted live from Deal Desk's
// 4 flows (see the flow probe dumps) — not invented action graphs.

function draftFollowUpEmailFixture(): FlowIR {
  return {
    id: 'flow-1',
    name: 'DraftFollwUpEMail',
    trigger: {
      type: 'Request',
      kind: 'Skills',
      inputSchema: [
        { name: 'text', displayName: 'ClientName', dataType: 'string', required: true },
        { name: 'text_1', displayName: 'NewLimit', dataType: 'string', required: true },
      ],
    },
    actions: [
      {
        id: 'Respond_to_the_agent',
        type: 'Response',
        runAfter: { Compose: ['Succeeded'] },
        raw: {},
        response: {
          statusCode: 200,
          bodyTemplate: { emaildraft: "@{outputs('Compose')}" },
          schema: { properties: { emaildraft: { title: 'EmailDraft' } } },
        },
      },
      {
        id: 'Compose',
        type: 'Compose',
        runAfter: {},
        raw: {},
        compose: { template: "Hello @{triggerBody()?['text']}, new limit @{triggerBody()?['text_1']}." },
      },
    ],
    connectionReferences: [],
    unmapped: [],
  };
}

describe('translateFlow — fully-mappable Compose + Response (real DraftFollowUpEmail shape)', () => {
  const result = translateFlow(draftFollowUpEmailFixture(), { integrationName: integrationNameForFlow('DraftFollwUpEMail') });

  it('reports a fully mapped fidelity summary', () => {
    expect(result.fidelityNotes[0]).toMatchObject({ status: 'mapped' });
  });

  it('uses the trigger field DISPLAY NAME (not the raw WDL key) as the parameter key', () => {
    const names = (result.integrationDefinition as { triggerConfigs: { inputVariables: { names: string[] } }[] })
      .triggerConfigs[0].inputVariables.names;
    expect(names).toEqual(['ClientName', 'NewLimit']);
  });

  it('produces two taskConfigs (Compose -> Response) wired via nextTasks', () => {
    const tasks = (result.integrationDefinition as { taskConfigs: { taskId: string; task: string; displayName: string; nextTasks?: { taskId: string }[] }[] }).taskConfigs;
    expect(tasks).toHaveLength(2);
    const compose = tasks.find((t) => t.displayName === 'Compose' || t.task === 'FieldMappingTask');
    expect(compose?.nextTasks?.length).toBeGreaterThan(0);
  });
});

describe('translateFlow — chained Compose->Compose reference resolves generically', () => {
  it('a second Compose referencing outputs(firstCompose) resolves once the first is translated', () => {
    const flow: FlowIR = {
      id: 'flow-2',
      name: 'ChainedCompose',
      trigger: { type: 'Request', kind: 'Skills', inputSchema: [{ name: 'text', displayName: 'Name', dataType: 'string', required: true }] },
      actions: [
        { id: 'Compose', type: 'Compose', runAfter: {}, raw: {}, compose: { template: "Hi @{triggerBody()?['text']}" } },
        { id: 'Compose_1', type: 'Compose', runAfter: { Compose: ['Succeeded'] }, raw: {}, compose: { template: "@{outputs('Compose')} — done." } },
        {
          id: 'Respond',
          type: 'Response',
          runAfter: { Compose_1: ['Succeeded'] },
          raw: {},
          response: { statusCode: 200, bodyTemplate: { out: "@{outputs('Compose_1')}" }, schema: { properties: { out: { title: 'Out' } } } },
        },
      ],
      connectionReferences: [],
      unmapped: [],
    };
    const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    expect(result.fidelityNotes[0]).toMatchObject({ status: 'mapped' });
    const tasks = (result.integrationDefinition as { taskConfigs: unknown[] }).taskConfigs;
    expect(tasks).toHaveLength(3);
  });

  it('translates formatDateTime(utcNow(), <fmt>) via a synthetic date-format pre-task (real GenerateAmendmentDocument shape)', () => {
    // Confirmed live 2026-09-08: this exact expression, in this exact position (a Compose
    // step other steps depend on), silently killed a real customer's whole document-
    // generation flow — 1 of 3 steps translated, the other 2 lost because they transitively
    // depended on this one. WDL string literals use SINGLE quotes (the tokenizer only
    // recognizes `'...'` — see flowExpression.ts's tokenize()); double quotes here would
    // silently fail to parse as a string at all and is a different bug, not this one.
    const flow: FlowIR = {
      id: 'flow-3',
      name: 'DateFormatFlow',
      trigger: { type: 'Request', kind: 'Skills', inputSchema: [] },
      actions: [
        { id: 'Compose', type: 'Compose', runAfter: {}, raw: {}, compose: { template: "@{formatDateTime(utcNow(), 'MM/dd/yyyy')}" } },
        { id: 'Compose_1', type: 'Compose', runAfter: { Compose: ['Succeeded'] }, raw: {}, compose: { template: "@{outputs('Compose')} done." } },
        {
          id: 'Respond',
          type: 'Response',
          runAfter: { Compose_1: ['Succeeded'] },
          raw: {},
          response: { statusCode: 200, bodyTemplate: { out: "@{outputs('Compose_1')}" }, schema: { properties: { out: { title: 'Out' } } } },
        },
      ],
      connectionReferences: [],
      unmapped: [],
    };
    const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    expect(result.fidelityNotes).toEqual([{ component: 'flow:DateFormatFlow', status: 'mapped', detail: 'All 3 step(s) translated.' }]);

    const def = result.integrationDefinition as {
      triggerConfigs: { startTasks: { taskId: string }[] }[];
      taskConfigs: { taskId: string; task: string; nextTasks?: { taskId: string }[] }[];
    };
    // 3 real actions + 1 synthetic JavaScriptTask for the date format = 4.
    expect(def.taskConfigs).toHaveLength(4);
    const dateTask = def.taskConfigs.find((t) => t.task === 'JavaScriptTask');
    expect(dateTask).toBeDefined();

    // The graph must START at the synthetic pre-task, not at Compose's own task — Compose
    // has no real predecessor, so without this the date-format step would never run at all.
    expect(def.triggerConfigs[0].startTasks).toEqual([{ taskId: dateTask!.taskId }]);
    // ...and the pre-task must chain into exactly one next task (Compose's own), not dangle.
    expect(dateTask!.nextTasks?.length).toBe(1);
    const composeTask = def.taskConfigs.find((t) => t.taskId === dateTask!.nextTasks?.[0]?.taskId);
    expect(composeTask?.task).toBe('FieldMappingTask');
  });

  it('formats known .NET date tokens without guessing at unrecognized ones', () => {
    // Deliberately testing the PURE formatting logic's token coverage, not the graph wiring
    // (covered above) — a wrong date format is a silent correctness bug a customer would
    // only notice by reading a generated document closely, so this is worth locking down
    // directly rather than trusting it by inspection.
    const flow: FlowIR = {
      id: 'flow-4',
      name: 'DateTokenFlow',
      trigger: { type: 'Request', kind: 'Skills', inputSchema: [] },
      actions: [
        { id: 'Compose', type: 'Compose', runAfter: {}, raw: {}, compose: { template: "@{formatDateTime(utcNow(), 'yyyy-MM-dd')}" } },
      ],
      connectionReferences: [],
      unmapped: [],
    };
    const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    const def = result.integrationDefinition as { taskConfigs: { task: string; parameters: { script?: { value: { stringValue: string } } } }[] };
    const script = def.taskConfigs.find((t) => t.task === 'JavaScriptTask')!.parameters.script!.value.stringValue;
    // The script must reference UTC getters (matching utcNow()'s own semantics) — a local-
    // time getter here would silently produce a different date depending on the server's
    // timezone, a correctness bug worse than an honest gap.
    expect(script).toContain('getUTCFullYear');
    expect(script).toContain('getUTCMonth');
    expect(script).toContain('getUTCDate');
    expect(script).not.toContain('getFullYear()'); // no bare (non-UTC) getters
  });
});

describe('translateFlow — blocked Teams connector is reported honestly, never silently attempted', () => {
  it('gates PostMessageToConversation as lost with the real verified reason, and cascades to the Response', () => {
    const flow: FlowIR = {
      id: 'flow-4',
      name: 'Postoteams',
      trigger: { type: 'Request', kind: 'Skills', inputSchema: [{ name: 'text', displayName: 'DocumentText', dataType: 'string', required: true }] },
      actions: [
        {
          id: 'Post_message_in_a_chat_or_channel',
          type: 'OpenApiConnection',
          runAfter: {},
          raw: {},
          connector: { connectionReferenceName: 'shared_teams', operationId: 'PostMessageToConversation', parameters: { recipient: 'erik@filefuze.co' } },
        },
        {
          id: 'Respond_to_the_agent',
          type: 'Response',
          runAfter: { Post_message_in_a_chat_or_channel: ['Succeeded'] },
          raw: {},
          response: {
            statusCode: 200,
            bodyTemplate: { postconfirmation: "@{outputs('Post_message_in_a_chat_or_channel')?['body/messageLink']}" },
            schema: { properties: { postconfirmation: { title: 'PostConfirmation' } } },
          },
        },
      ],
      connectionReferences: [{ name: 'shared_teams', connectorId: 'shared_teams' }],
      unmapped: [],
    };
    const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    const byComponent = Object.fromEntries(result.fidelityNotes.map((n) => [n.component, n]));
    expect(byComponent['flow:Postoteams'].status).toBe('partial');
    expect(byComponent['flow:Postoteams:Post_message_in_a_chat_or_channel'].status).toBe('lost');
    expect(byComponent['flow:Postoteams:Post_message_in_a_chat_or_channel'].detail).toMatch(/application-only/i);
    // The Response step still emits an OUT parameter (empty) rather than vanishing entirely.
    const params = (result.integrationDefinition as { integrationParameters: { key: string; inputOutputType: string }[] }).integrationParameters;
    expect(params.some((p) => p.key === 'PostConfirmation' && p.inputOutputType === 'OUT')).toBe(true);
  });
});

describe('translateFlow — Excel Table connector + Query filter (real GetRateSheetBand shape)', () => {
  it('binds GetItems to the real Graph Tables endpoint and compiles the where-clause into JS', () => {
    const flow: FlowIR = {
      id: 'flow-5',
      name: 'GetRateSheetBand',
      trigger: { type: 'Request', kind: 'Skills', inputSchema: [{ name: 'number', displayName: 'NewLimit', dataType: 'number', required: true }] },
      actions: [
        {
          id: 'List_rows_present_in_a_table',
          type: 'OpenApiConnection',
          runAfter: {},
          raw: {},
          connector: {
            connectionReferenceName: 'shared_excelonlinebusiness',
            operationId: 'GetItems',
            parameters: { source: 'me', drive: 'driveId123', file: 'fileId456', table: '{TABLE-GUID}' },
          },
        },
        {
          id: 'Filter_array',
          type: 'Query',
          runAfter: { List_rows_present_in_a_table: ['SUCCEEDED'] },
          raw: {
            inputs: {
              from: "@outputs('List_rows_present_in_a_table')?['body/value']",
              where: "@and(lessOrEquals(int(item()['Limit Band Min']), triggerBody()['number']), greater(int(item()['Limit Band Max']), triggerBody()['number']))",
            },
          },
        },
        {
          id: 'Respond_to_the_agent',
          type: 'Response',
          runAfter: { Filter_array: ['SUCCEEDED'] },
          raw: {},
          response: { statusCode: 200, bodyTemplate: { matchingrows: "@{body('Filter_array')}" }, schema: { properties: { matchingrows: { title: 'MatchingRows' } } } },
        },
      ],
      connectionReferences: [{ name: 'shared_excelonlinebusiness', connectorId: 'shared_excelonlinebusiness' }],
      unmapped: [],
    };
    const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    expect(result.fidelityNotes[0]).toMatchObject({ status: 'mapped' });
    expect(result.authConfigsNeeded).toEqual([{ connectorId: 'shared_excelonlinebusiness', connectionReferenceName: 'shared_excelonlinebusiness', authConfigName: 'ms_graph' }]);
    const tasks = (result.integrationDefinition as { taskConfigs: { task: string; parameters: Record<string, { value?: { stringValue?: string } }> }[] }).taskConfigs;
    const restTask = tasks.find((t) => t.task === 'GenericRestV2Task')!;
    expect(restTask.parameters.url.value?.stringValue).toContain("workbook/tables('%7BTABLE-GUID%7D')/range");
    const jsTask = tasks.find((t) => t.task === 'JavaScriptTask')!;
    const script = jsTask.parameters.script.value?.stringValue as string;
    expect(script).toContain('__num(row["Limit Band Min"])');
    expect(script).toContain('event.getParameter("NewLimit")');
    // NewLimit's WDL type is "number" -> DOUBLE_VALUE, matching Copilot's own untyped Number field.
    const params = (result.integrationDefinition as { integrationParameters: { key: string; dataType: string }[] }).integrationParameters;
    expect(params.find((p) => p.key === 'NewLimit')?.dataType).toBe('DOUBLE_VALUE');
  });
});

describe('translateFlow — unrecognized connector operation is needs-review, never silently guessed', () => {
  it('an operation with no known Graph binding and no known block reports needs-review', () => {
    const flow: FlowIR = {
      id: 'flow-6',
      name: 'UnknownConnectorFlow',
      trigger: { type: 'Request', kind: 'Skills', inputSchema: [] },
      actions: [
        {
          id: 'Do_something',
          type: 'OpenApiConnection',
          runAfter: {},
          raw: {},
          connector: { connectionReferenceName: 'shared_something', operationId: 'DoSomething', parameters: {} },
        },
      ],
      connectionReferences: [{ name: 'shared_something', connectorId: 'shared_something' }],
      unmapped: [],
    };
    const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
    const note = result.fidelityNotes.find((n) => n.component === 'flow:UnknownConnectorFlow:Do_something')!;
    expect(note.status).toBe('needs-review');
    expect(note.detail).toMatch(/no known REST binding/i);
  });
});
