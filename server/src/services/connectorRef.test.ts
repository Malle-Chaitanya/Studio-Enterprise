import { describe, it, expect } from 'vitest';
import {
  connectorIdFromConnectionReference,
  connectorIdFromOperation,
  resolveConnectorId,
  connectorIdFromArmPath,
  connectionAuthModeFrom,
} from './connectorRef.js';

/**
 * The first real unit tests in this repo.
 *
 * Both functions under test have already caused a silent data-loss bug, which is why they
 * are first: a connector id that parses to `undefined` drops a whole capability with no
 * FidelityNote, and an auth mode read wrong turns per-user access into shared-credential
 * access without saying so.
 *
 * The payload strings marked "live" are verbatim from real Copilot Studio agents, captured
 * 2026-08-11 by spikes/_probe_connector_operation_schema.ts. Invented fixtures would only
 * prove the parser matches whatever shape the author imagined.
 */

describe('connectorIdFromConnectionReference', () => {
  it('reads a first-party connector id (live payload)', () => {
    expect(
      connectorIdFromConnectionReference(
        'crf37_Confluenceagent.shared_confluence.cbc262ecb6fe401294af380b08d029d6',
      ),
    ).toBe('shared_confluence');
  });

  it('reads a first-party id whose connection ref has a dashed suffix (live payload)', () => {
    expect(
      connectorIdFromConnectionReference(
        'crf37_DevHelpDeskAgent.shared_sharepointonline.shared-sharepointonl-0a728318-c54b-42b5-a054-732e262fffd9',
      ),
    ).toBe('shared_sharepointonline');
  });

  // The regression this function exists for. Before the fix this returned undefined, the
  // tool carried no connectorId, and the capability vanished from both the agent and the
  // report.
  it('names a CUSTOM connector instead of dropping it', () => {
    expect(
      connectorIdFromConnectionReference(
        'crf37_MyAgent.crf37_acmepayrollapi.9f2c1b7e4d5a4c0e8b3f1a2d6e7c8b90',
      ),
    ).toBe('crf37_acmepayrollapi');
  });

  it('normalises ids to lowercase so registry lookups are stable', () => {
    expect(connectorIdFromConnectionReference('contoso_Agent.Contoso_HRSystem.abc123')).toBe(
      'contoso_hrsystem',
    );
  });

  it('returns undefined rather than guessing when the reference is malformed', () => {
    expect(connectorIdFromConnectionReference('justonesegment')).toBeUndefined();
    expect(connectorIdFromConnectionReference('two.segments')).toBeUndefined();
    expect(connectorIdFromConnectionReference('')).toBeUndefined();
  });
});

describe('resolveConnectorId (topic-embedded actions)', () => {
  // The regression. Live strings from spikes/_dump_conn_refs.ts against
  // "Quality Evaluation Agent - Incident", 2026-08-12:
  //   raw ref: QMA.Incident.DVPluginConnection
  //   op:      PerformUnboundActionWithOrganization
  // The middle segment is the ENTITY. The old parser returned `incident`, which matched no
  // registry entry, so the operation bound to nothing and produced no note at all.
  it('resolves a solution-prefixed Dataverse reference by its operation family', () => {
    expect(resolveConnectorId('QMA.Incident.DVPluginConnection', 'PerformUnboundActionWithOrganization')).toEqual({
      connectorId: 'shared_commondataserviceforapps',
      confidence: 'inferred',
    });
    expect(resolveConnectorId('QMA.Incident.DVPluginConnection', 'GetItemWithOrganization').connectorId).toBe(
      'shared_commondataserviceforapps',
    );
  });

  it('never lets the entity name win over the operation', () => {
    expect(resolveConnectorId('QMA.Incident.DVPluginConnection', 'GetItemWithOrganization').connectorId).not.toBe(
      'incident',
    );
  });

  it('works when the reference is missing entirely', () => {
    expect(resolveConnectorId(undefined, 'ListRecordsWithOrganization')).toEqual({
      connectorId: 'shared_commondataserviceforapps',
      confidence: 'inferred',
    });
  });

  // An explicit `shared_*` id is the connector stating itself — it must outrank inference,
  // or a future hint regex could silently retarget a correctly-identified connector.
  it('prefers an explicit shared_* id over the operation family', () => {
    expect(
      resolveConnectorId('crf37_Agent.shared_confluence.abc123', 'GetItemWithOrganization'),
    ).toEqual({ connectorId: 'shared_confluence', confidence: 'exact' });
  });

  // Custom connectors still fall through to the middle segment, marked as the weaker
  // evidence it is, so they keep reaching the unsupported list and the report.
  it('still NAMES a custom connector, flagged as named-only', () => {
    expect(resolveConnectorId('crf37_MyAgent.crf37_acmepayrollapi.9f2c', 'CreatePayrollRun')).toEqual({
      connectorId: 'crf37_acmepayrollapi',
      confidence: 'named-only',
    });
  });

  it('reports unknown rather than guessing', () => {
    expect(resolveConnectorId(undefined, undefined)).toEqual({ confidence: 'unknown' });
    expect(resolveConnectorId('two.segments', 'SomeOperation')).toEqual({ confidence: 'unknown' });
  });

  it('only claims Dataverse for the WithOrganization suffix, not for a substring', () => {
    expect(connectorIdFromOperation('GetOrganizationProfile')).toBeUndefined();
    expect(connectorIdFromOperation('WithOrganizationDetails')).toBeUndefined();
    expect(connectorIdFromOperation('UpdateRecordWithOrganization')).toBe('shared_commondataserviceforapps');
  });
});

describe('ConnectorTool rows (the flat shape)', () => {
  // Verbatim from "Hubspot agentt", captured 2026-08-12 by spikes/_probe_thin_agent.ts.
  // The agent is FOUR of these and nothing else, and extracted as thinContent — the
  // product reported "nothing authored to migrate" about an agent made entirely of
  // HubSpot calls.
  const ARM =
    '/providers/Microsoft.PowerApps/apis/shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b';
  const REF =
    'cr88d_hubspotagentt_XSK2Qk.cr.shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b';

  it('takes the connector straight from the ARM path', () => {
    expect(resolveConnectorId(REF, 'GetDeals', ARM)).toEqual({
      connectorId: 'shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b',
      confidence: 'exact',
    });
  });

  it('outranks every other signal, including the operation family', () => {
    expect(
      resolveConnectorId('QMA.Incident.DVPluginConnection', 'GetItemWithOrganization', ARM).connectorId,
    ).toBe('shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b');
  });

  it('ignores an ARM path that is not a connector resource', () => {
    expect(connectorIdFromArmPath('/providers/Microsoft.PowerApps/flows/abc')).toBeUndefined();
    expect(connectorIdFromArmPath(undefined)).toBeUndefined();
    expect(connectorIdFromArmPath('')).toBeUndefined();
  });

  // The truncation bug. `shared_get` is not a connector — it is the first hyphen-free
  // slice of one, so the tool was reported unsupported under a name that does not exist.
  it('keeps hyphens in a custom connector id instead of truncating at the first one', () => {
    expect(connectorIdFromConnectionReference(REF)).toBe(
      'shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b',
    );
    expect(connectorIdFromConnectionReference(REF)).not.toBe('shared_get');
  });

  it('does not change first-party ids by allowing hyphens', () => {
    expect(
      connectorIdFromConnectionReference('crf37_Confluenceagent.shared_confluence.cbc262ecb6fe401294af380b08d029d6'),
    ).toBe('shared_confluence');
    expect(
      connectorIdFromConnectionReference(
        'crf37_DevHelpDeskAgent.shared_sharepointonline.shared-sharepointonl-0a728318-c54b-42b5-a054-732e262fffd9',
      ),
    ).toBe('shared_sharepointonline');
  });

  // A ConnectorTool states authMode flat. Reading it as "unknown" would migrate a
  // per-end-user tool under our one service credential without saying so.
  it('reads the flat authMode as Invoker', () => {
    const row = ['kind: ConnectorTool', 'authMode: Invoker', `connectorId: ${ARM}`, 'operationId: GetDeals'].join('\n');
    expect(connectionAuthModeFrom(row)).toBe('invoker');
  });

  it('still reads the nested connectionProperties shape', () => {
    const nested = ['kind: InvokeConnectorTaskAction', 'connectionProperties:', '  mode: Invoker'].join('\n');
    expect(connectionAuthModeFrom(nested)).toBe('invoker');
  });
});

describe('connectionAuthModeFrom', () => {
  // Live payload shape: both connector tools found in the test tenant were Invoker.
  const invoker = [
    'kind: TaskDialog',
    'modelDisplayName: Get pages',
    '',
    'action:',
    '  kind: InvokeConnectorTaskAction',
    '  connectionReference: crf37_Confluenceagent.shared_confluence.cbc262ec',
    '  connectionProperties:',
    '    mode: Invoker',
    '',
    '  operationId: GetPages',
  ].join('\n');

  it('detects per-end-user auth (live payload)', () => {
    expect(connectionAuthModeFrom(invoker)).toBe('invoker');
  });

  it('detects a shared maker connection', () => {
    expect(connectionAuthModeFrom(invoker.replace('mode: Invoker', 'mode: maker'))).toBe('maker');
  });

  it('is case-insensitive on the mode value', () => {
    expect(connectionAuthModeFrom(invoker.replace('mode: Invoker', 'mode: INVOKER'))).toBe(
      'invoker',
    );
  });

  // undefined and 'maker' are NOT the same thing downstream: one is "the payload did not
  // say", the other is a positive statement about a shared connection. Collapsing them
  // would let an unknown auth mode be reported as safe.
  it('returns undefined when the payload says nothing about auth', () => {
    expect(connectionAuthModeFrom('kind: TaskDialog\noperationId: GetPages')).toBeUndefined();
    expect(connectionAuthModeFrom('')).toBeUndefined();
  });

  // The regex has a 200-char window between connectionProperties and mode. A `mode:` far
  // away belongs to something else and must not be picked up.
  it('does not attribute a distant unrelated mode to connectionProperties', () => {
    const far = 'connectionProperties:\n' + '  filler: x\n'.repeat(40) + '  mode: Invoker\n';
    expect(connectionAuthModeFrom(far)).toBeUndefined();
  });
});
