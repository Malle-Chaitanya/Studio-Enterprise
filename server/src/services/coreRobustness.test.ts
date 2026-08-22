import { describe, it, expect } from 'vitest';
import { classifyKnowledgeSource } from './knowledgeClassifier.js';
import { buildBoundToolSpecs } from '../connectors/boundToolSpec.js';
import { buildLiveConnectorSpecsDetailed, agentConnectorIds } from './connectorToolBuilder.js';
import { findCoverage } from '../connectors/coverage.js';
import { findEquivalence, surfaceForConnector } from '../connectors/equivalence.js';
import { hasDedicatedToolModule } from '../connectors/toolModule.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import type { AgentIR } from '../types.js';

/**
 * THE CORE MUST NOT BE AGENT-SPECIFIC.
 *
 * Everything else in this repo is measured against agents that exist. That is necessary and
 * not sufficient: the requirement is that an agent a customer builds TOMORROW, with a
 * connector mix nobody predicted, migrates without errors — or is told precisely what it
 * cannot do. So these tests drive the core path over SYNTHETIC agents built from the matrix of
 * things a Copilot author can actually assemble, including shapes no real agent has yet:
 * unknown connectors, unknown knowledge-source kinds, empty agents, and every Tier-1
 * connector at once on a single agent.
 *
 * The bar is not "it works". The bar is: it never throws, and it never goes quiet. A
 * capability that cannot be reproduced must produce a note; silence is the failure this file
 * exists to prevent (see ledger 1.51, where 13 proven operations reported nothing at all).
 */

/** Everything real agents were measured using, by `_diag_connector_census.ts` (2026-08-21). */
const OBSERVED_KS_KINDS = [
  'SharePointSearchSource',
  'FileUpload',
  'DataverseStructuredSearchSource',
  'FederatedStructuredSearchSource',
  'PublicSiteSearchSource',
  'DataverseTableSearch',
  'SharePointKnowledgeSource',
];

/**
 * Shapes NO agent has used yet — the point being that they must still be handled.
 *
 * `AzureBlobKnowledgeSource` was in this list and does NOT belong: it matches a deliberate
 * Azure Blob rule that returns copy-and-index with `automatable: false` and a note saying it
 * needs the customer's blob credentials. That is the classifier working. The first version of
 * this test asserted every unfamiliar-LOOKING kind must be manual-review, which conflated
 * "has a strategy" with "claims to be automatic" — the code was right and the test was wrong.
 * Kinds that are genuinely unrecognised by every rule:
 */
const UNSEEN_KS_KINDS = [
  'SomeFutureSearchSource',
  'QuantumLedgerThing',
  '',
  'zzz',
];

/**
 * Kinds no agent has used but which rules DO claim.
 *
 * Deliberately NOT paired with expected targets. Two of my guesses were wrong — Azure AI
 * Search is `manual-review`/`none` on purpose (a prebuilt index cannot be moved, and the note
 * names the two human options) — and a test that encodes the author's guess about each rule
 * tests the guess, not the property. What matters is the property below: every claimed kind
 * either names something concrete it will build, or says a human must decide, and never both
 * or neither.
 */
const HANDLED_BUT_UNSEEN = [
  'AzureBlobKnowledgeSource',
  'AzureAiSearchSource',
  'SqlKnowledgeSource',
  'CustomApiKnowledgeSource',
  'MicrosoftGraphConnectorSource',
];

describe('knowledge sources: every kind gets an answer', () => {
  it('every kind real agents use classifies to a strategy', () => {
    for (const kind of OBSERVED_KS_KINDS) {
      const c = classifyKnowledgeSource({ kind, references: ['https://contoso.sharepoint.com/sites/x'] });
      expect(c.strategy, `${kind} produced no strategy`).toBeTruthy();
      expect(c.retrievability, `${kind} produced no retrievability`).toBeTruthy();
      expect(c.geminiTarget, `${kind} produced no gemini target`).toBeTruthy();
    }
  });

  it('a genuinely unrecognised kind is sent to manual review, never quietly indexed', () => {
    // The dangerous default would be copy-and-index: it looks like success, produces an empty
    // or wrong data store, and the customer finds out when the agent answers badly.
    for (const kind of UNSEEN_KS_KINDS) {
      const c = classifyKnowledgeSource({ kind });
      expect(c.strategy, `${kind || '(empty)'} was given a confident strategy`).toBe('manual-review');
      expect(c.automatable, `${kind || '(empty)'} claims to be automatable`).toBe(false);
      expect(c.notes.length, `${kind || '(empty)'} needs manual review but says nothing about why`)
        .toBeGreaterThan(0);
      // The note must NAME the kind, or a human reading the report cannot tell which source
      // needs attention.
      if (kind) expect(c.notes.join(' '), `the note does not name "${kind}"`).toContain(kind);
    }
  });

  it('a kind a rule claims either builds something concrete or defers to a human', () => {
    // Being unfamiliar is not the same as being unsupported. Each of these has a rule, so the
    // classifier owes a definite answer of one of exactly two shapes:
    //   a concrete geminiTarget  -> we will build that
    //   manual-review + 'none'   -> we will not, and here is the decision to make
    // "no target and no manual-review" is the shape that reads as success and does nothing.
    for (const kind of HANDLED_BUT_UNSEEN) {
      const c = classifyKnowledgeSource({ kind });
      const concrete = c.geminiTarget !== 'none';
      const deferred = c.strategy === 'manual-review' && c.geminiTarget === 'none';
      expect(
        concrete || deferred,
        `${kind} produced neither a target nor a manual-review deferral: ` +
          `${c.strategy}/${c.geminiTarget}`,
      ).toBe(true);
      // Never unattended: every one of these needs a credential or a decision the customer
      // has not given us.
      expect(c.automatable, `${kind} claims to be fully automatic`).toBe(false);
      expect(c.notes.length, `${kind} has a strategy but explains nothing`).toBeGreaterThan(0);
    }
  });

  it('manual-review always explains itself', () => {
    // A human is being asked to do something. Handing them "manual-review" with no reason is
    // the report failing at the exact moment it matters.
    for (const kind of [...OBSERVED_KS_KINDS, ...UNSEEN_KS_KINDS]) {
      const c = classifyKnowledgeSource({ kind });
      if (c.strategy !== 'manual-review') continue;
      expect(c.notes.join(' ').length, `${kind || '(empty)'} manual-review with no explanation`)
        .toBeGreaterThan(20);
    }
  });

  it('a claim of full automation always names what it will create', () => {
    for (const kind of [...OBSERVED_KS_KINDS, ...UNSEEN_KS_KINDS]) {
      for (const refs of [undefined, ['https://example.com/'], ['Account']]) {
        const c = classifyKnowledgeSource({ kind, references: refs });
        if (!c.automatable) continue;
        expect(c.geminiTarget, `${kind} is automatable but creates nothing`).not.toBe('none');
      }
    }
  });

  it('an oversized or unsupported file is refused before it is promised', () => {
    // FileUpload is the most common kind (14 agents). Vertex has hard format and size limits,
    // and discovering them at import time means a migration that reported success and indexed
    // nothing.
    const huge = classifyKnowledgeSource({ kind: 'FileUpload', file: { name: 'x.pdf', sizeBytes: 900 * 1024 * 1024 } });
    expect(huge.notes.join(' '), 'a 900MB file was accepted silently').toMatch(/size|large|limit|MB/i);
    const weird = classifyKnowledgeSource({ kind: 'FileUpload', file: { name: 'model.onnx', sizeBytes: 1024 } });
    expect(weird.notes.join(' '), 'an unsupported format was accepted silently').toBeTruthy();
  });
});

/** Build a synthetic agent that declares one connector operation. */
function agentWith(tools: Array<{ connectorId: string; operationId: string }>): AgentIR {
  return {
    name: 'Synthetic Agent',
    instructions: 'test',
    agentTools: tools.map((t, i) => ({
      kind: 'connector' as const,
      name: `tool ${i}`,
      connectorId: t.connectorId,
      operationId: t.operationId,
    })),
    knowledgeSources: [],
  } as unknown as AgentIR;
}

/**
 * The Tier-1 set plus HubSpot, with one operation each that real agents were measured
 * declaring. Kept as data so a new connector is added here rather than in five places.
 */
const TIER1_OPS: Array<[string, string]> = [
  ['shared_teams', 'GetTeam'],
  ['shared_teams', 'GetAllChannelsForTeam'],
  ['shared_teams', 'GetChats'],
  ['shared_office365', 'GetEmailsV3'],
  ['shared_googledrive', 'ListFolder'],
  ['shared_googledrive', 'CreateFileV2'],
  ['shared_confluence', 'GetSpaces'],
  ['shared_jira', 'ListIssues'],
  ['shared_jira', 'mcp_JiraIssueManagement'],
  ['shared_sharepointonline', 'GetAllTables'],
  ['shared_hubspotcrm', 'CompaniesList'],
  ['shared_hubspotcrmv2', 'ListAssociations'],
  ['shared_hubspotsettingsv2', 'GetTheDailyApiUsageAndLimitsForAHubspotAccount'],
  ['shared_hubspotcms', 'TemplatesList'],
];

describe('connectors: the core survives any agent shape', () => {
  it('every Tier-1 + HubSpot connector has a registry entry', () => {
    // No entry means no credential can be collected and no spec is built, so the agent
    // deploys with NO TOOL for it. `shared_hubspotcms` was in exactly that state until the
    // census found it on a real agent (2026-08-21).
    for (const [id] of TIER1_OPS) {
      expect(REGISTRY_BY_ID.has(id), `${id} is referenced by agents but absent from the registry`).toBe(true);
    }
  });

  it('a connector with a dedicated tool module is always in the registry too', () => {
    // The dangerous combination, and the one hubspotcms was in: the Python dispatch claims the
    // connector (so bound operations are reported as dropped in favour of purpose-built tools)
    // while no spec exists to carry those tools. Both halves must agree.
    for (const [id] of TIER1_OPS) {
      if (!hasDedicatedToolModule(id)) continue;
      expect(
        REGISTRY_BY_ID.has(id),
        `${id} resolves to a Python tool module but has no registry entry — it would be ` +
          'reported as served by purpose-built tools and receive none',
      ).toBe(true);
    }
  });

  it('every Tier-1 operation has a verdict in one of the two tables', () => {
    // coverage.ts is same-vendor and keyed by connectorId; equivalence.ts is cross-vendor and
    // keyed by M365Surface. Checking one and concluding about both was the same mistake three
    // times (ledger 1.50/1.51), so the lookup here is deliberately the full one.
    for (const [id, op] of TIER1_OPS) {
      const surface = surfaceForConnector(id);
      const judged = findCoverage(id, op) ?? (surface ? findEquivalence(surface, op) : undefined);
      expect(judged, `${id}:${op} resolves to nothing — the report would have to say "unjudged"`).toBeTruthy();
    }
  });

  it('binding tool specs never throws, for any of them', async () => {
    // The orchestrator catches per agent, so a throw here is a FAILED AGENT in a live run.
    for (const [id, op] of TIER1_OPS) {
      await expect(
        buildBoundToolSpecs(agentWith([{ connectorId: id, operationId: op }]), undefined, {}),
        `${id}:${op} threw while building bound tool specs`,
      ).resolves.toBeTruthy();
    }
  });

  it('one agent using EVERY Tier-1 connector at once still builds', async () => {
    // Nothing stops an author doing this, and connector interactions are where the real
    // breakage lives — two connectors once collided on tool names and 400'd every message
    // (live 2026-08-07). Tool names must therefore be unique across the whole agent.
    const ir = agentWith(TIER1_OPS.map(([connectorId, operationId]) => ({ connectorId, operationId })));
    const build = await buildBoundToolSpecs(ir, undefined, {});
    const names = [...build.byConnector.values()].flat().map((s) => s.toolName);
    expect(new Set(names).size, `duplicate tool names across connectors: ${names.join(', ')}`).toBe(names.length);
  });

  it('an UNKNOWN connector is reported, not dropped', async () => {
    // A connector nobody has heard of must still surface. Silence here is how a capability
    // disappears between Copilot and the report.
    const ir = agentWith([{ connectorId: 'shared_somethingnobodyhasheardof', operationId: 'DoAThing' }]);
    const build = await buildBoundToolSpecs(ir, undefined, {});
    const { unsupported } = buildLiveConnectorSpecsDetailed(
      [...agentConnectorIds(ir)],
      { ownerScope: 'test', storedSecretIds: {} },
    );
    // Either the binder notes it, or the spec builder calls it unsupported — one of the two
    // must know, because the orchestrator turns `unsupported` into a `lost` note.
    const known = build.notes.length > 0 || unsupported.includes('shared_somethingnobodyhasheardof');
    expect(known, 'an unknown connector produced neither a note nor an unsupported entry').toBe(true);
  });

  it('an agent with no tools and no knowledge migrates without error', async () => {
    // The degenerate case. It has to be boring, not a crash.
    const empty = { name: 'Empty', instructions: 'hi', agentTools: [], knowledgeSources: [] } as unknown as AgentIR;
    const build = await buildBoundToolSpecs(empty, undefined, {});
    expect(build.byConnector.size).toBe(0);
    expect(agentConnectorIds(empty).size).toBe(0);
  });

  it('a tool with a connector but no operation does not crash the binder', async () => {
    // Real payloads carry this: an MCP tool with no selection, a half-configured action.
    const ir = {
      name: 'Half configured',
      instructions: 'x',
      agentTools: [
        { kind: 'connector', name: 'no op', connectorId: 'shared_jira' },
        { kind: 'mcp-server', name: 'mcp, no tools', connectorId: 'shared_jira' },
        { kind: 'connected-agent', name: 'Some Other Agent' },
        { kind: 'ai-builder', name: 'A model' },
      ],
      knowledgeSources: [],
    } as unknown as AgentIR;
    await expect(buildBoundToolSpecs(ir, undefined, {})).resolves.toBeTruthy();
  });
});
