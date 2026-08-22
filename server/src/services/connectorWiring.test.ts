import { describe, it, expect } from 'vitest';
import { agentConnectorIds } from './connectorToolBuilder.js';
import { classifyKnowledgeSource } from './knowledgeClassifier.js';
import type { AgentIR, KnowledgeSourceIR } from '../types.js';

/**
 * Which connectors get wired onto an agent decides what it can DO. Wire one it never had and
 * the agent gains live API access its Copilot original lacked; miss one it did have and a
 * knowledge source silently answers nothing while the run reports it served.
 *
 * Both happened on a single real agent ("Knowledge Assistant", live 2026-08-21), from the same
 * function, in opposite directions — see the comments in `agentConnectorIds`. These tests pin
 * the rule that fixes both: the classifier states the connector a source needs, and nobody
 * downstream re-derives it from prose or from a raw Copilot `kind`.
 */

const agent = (sources: Partial<KnowledgeSourceIR>[]): AgentIR =>
  ({
    name: 'Test Agent',
    displayName: 'Test Agent',
    description: '',
    instructions: '',
    agentTools: [],
    topics: [],
    knowledgeSources: sources as KnowledgeSourceIR[],
    unmapped: {},
  }) as unknown as AgentIR;

/** Build a source the way the pipeline does — through the real classifier, not by hand. */
function classified(kind: string, opts?: { description?: string; references?: string[]; name?: string }): KnowledgeSourceIR {
  return {
    kind,
    name: opts?.name ?? 'src',
    classification: classifyKnowledgeSource({ kind, description: opts?.description, references: opts?.references }),
  } as unknown as KnowledgeSourceIR;
}

describe('agentConnectorIds — what a source says it needs', () => {
  it('does NOT wire Confluence for a federated source whose note says it is not Confluence', () => {
    // The exact shape that shipped wrong: Copilot's generic federated kind, no description, so
    // the classifier infers SharePoint and SAYS SO in a note containing the word "Confluence".
    const ks = classified('FederatedStructuredSearchSource', { name: 'TestingPermissions' });
    expect(
      /confluence/i.test(ks.classification!.notes.join(' ')),
      'precondition: the note must still mention Confluence, or this test proves nothing',
    ).toBe(true);
    expect(ks.classification!.requiresConnectorId).toBe('shared_sharepointonline');

    const ids = agentConnectorIds(agent([ks]));
    expect([...ids]).not.toContain('shared_confluence');
  });

  it('DOES wire SharePoint for that same federated source', () => {
    // The other half: the classifier declines to copy these because live tools will serve them,
    // so the tools have to exist. `kind` is FederatedStructuredSearchSource, not
    // SharePointSearchSource — keying on the raw kind missed all five of them.
    const ids = agentConnectorIds(agent([classified('FederatedStructuredSearchSource', { name: 'daily_queries.txt' })]));
    expect([...ids]).toContain('shared_sharepointonline');
  });

  it('still wires Confluence when the source genuinely IS Confluence', () => {
    const ks = classified('FederatedStructuredSearchSource', { description: 'Confluence items from ENG' });
    expect(ks.classification!.strategy).toBe('confluence-crawler');
    expect([...agentConnectorIds(agent([ks]))]).toContain('shared_confluence');
  });

  it('wires Confluence from space names even if the classification says nothing', () => {
    // Space names are evidence on their own — an author picked those spaces in Copilot Studio.
    const ids = agentConnectorIds(
      agent([{ kind: 'SomethingElse', name: 'x', confluenceSpaceNames: ['ENG'] } as Partial<KnowledgeSourceIR>]),
    );
    expect([...ids]).toContain('shared_confluence');
  });

  it('keeps working for rows staged before requiresConnectorId existed', () => {
    // stagedAgents rows outlive releases. An old row has a classification with no
    // requiresConnectorId, so the structural fallbacks must still carry it.
    const ids = agentConnectorIds(
      agent([
        { kind: 'SharePointSearchSource', name: 'old-sp' } as Partial<KnowledgeSourceIR>,
        {
          kind: 'FederatedStructuredSearchSource',
          name: 'old-conf',
          classification: { strategy: 'confluence-crawler', retrievability: 'connector-backed', geminiTarget: 'document-data-store', automatable: true, notes: [] },
        } as Partial<KnowledgeSourceIR>,
      ]),
    );
    expect([...ids]).toContain('shared_sharepointonline');
    expect([...ids]).toContain('shared_confluence');
  });

  it('never wires a connector for a source that needs none', () => {
    // An uploaded file is copied and indexed; it implies no live connector at all. Wiring one
    // here would hand the agent API access nobody asked for.
    const ids = agentConnectorIds(agent([classified('FileUpload', { name: 'report.pdf' })]));
    expect([...ids]).toHaveLength(0);
  });

  it('still takes connectors from the agent\'s own tools', () => {
    const ir = agent([]);
    (ir as { agentTools: unknown[] }).agentTools = [{ connectorId: 'shared_jira', operationId: 'ListIssues' }];
    expect([...agentConnectorIds(ir)]).toContain('shared_jira');
  });

  it('every connector a classifier rule claims to need is a real registry id', async () => {
    // A typo in requiresConnectorId would be silent: the id gets added, no registry entry
    // matches, and the source is reported unsupported instead of wired.
    const { REGISTRY_BY_ID } = await import('../connectors/registry.js');
    const kinds = [
      'SharePointSearchSource',
      'SharePointKnowledgeSource',
      'FederatedStructuredSearchSource',
      'OneDriveKnowledgeSource',
      'DataverseStructuredSearchSource',
      'FileUpload',
      'PublicSiteSearchSource',
      'AzureBlobKnowledgeSource',
      'AzureAiSearchSource',
    ];
    for (const kind of kinds) {
      const id = classifyKnowledgeSource({ kind }).requiresConnectorId;
      if (!id) continue;
      expect(REGISTRY_BY_ID.has(id), `${kind} claims connector "${id}", which is not in the registry`).toBe(true);
    }
  });
});
