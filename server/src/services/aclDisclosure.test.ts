import { describe, it, expect } from 'vitest';
import { aclLossItems, aclDisclosureFor, needsAclAcknowledgement, aclDisclosureSummary } from './aclDisclosure.js';
import type { AgentIR, KnowledgeSourceIR } from '../types.js';

/**
 * The gate's whole value is that it fires on the right sources and stays quiet on the
 * wrong ones. A false alarm on a public website teaches people to click through, which
 * costs more than the warning is worth.
 */

function ks(over: Partial<KnowledgeSourceIR>): KnowledgeSourceIR {
  return { id: 'k1', name: 'Source', kind: 'Unknown', ...over } as KnowledgeSourceIR;
}

function ir(over: Partial<AgentIR>): AgentIR {
  return {
    sourceId: 'b1',
    name: 'Agent',
    instructions: '',
    description: '',
    capabilities: { webBrowsing: false, codeInterpreter: false },
    starterPrompts: [],
    topics: [],
    knowledgeSources: [],
    unmapped: [],
    ...over,
  } as AgentIR;
}

describe('aclLossItems — fires on indexed content from permissioned systems', () => {
  it('flags a SharePoint source we copy and index', () => {
    const items = aclLossItems(
      ir({
        knowledgeSources: [
          ks({
            name: 'HR Policies',
            kind: 'SharePointSearchSource',
            reference: 'https://filefuze.sharepoint.com/Shared%20Documents/HR',
            classification: { strategy: 'copy-and-index' } as never,
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].system).toBe('SharePoint');
    expect(items[0].sourceName).toBe('HR Policies');
  });

  it('flags a Confluence source identified only by its space names', () => {
    const items = aclLossItems(
      ir({
        knowledgeSources: [
          ks({
            name: 'Engineering wiki',
            kind: 'FederatedStructuredSearchSource',
            confluenceSpaceNames: ['Engineering'],
            classification: { strategy: 'confluence-crawler' } as never,
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].system).toBe('Confluence');
  });

  it('flags a Dataverse table snapshot', () => {
    const items = aclLossItems(
      ir({
        knowledgeSources: [
          ks({ name: 'FAQ Entry', kind: 'DataverseTableSearch', classification: { strategy: 'dataverse-snapshot' } as never }),
        ],
      }),
    );
    expect(items[0].system).toBe('Dataverse');
  });

  it('flags an author-uploaded file — the source agent may have had a narrow audience', () => {
    const items = aclLossItems(
      ir({
        knowledgeSources: [
          ks({ name: 'salaries.xlsx', kind: 'FileUpload', file: { name: 'salaries.xlsx' }, classification: { strategy: 'copy-and-index' } as never }),
        ],
      }),
    );
    expect(items[0].system).toBe('an uploaded file');
  });
});

describe('aclLossItems — stays quiet where there is nothing to lose', () => {
  // reconnect wires Google's NATIVE connector, which produces aclEnabled: true
  // (proven for SharePoint and Google Drive, ledger §1.3). Warning here would be a
  // false alarm on the one path that actually preserves permissions.
  it('does NOT flag a source migrated via the native connector', () => {
    expect(
      aclLossItems(
        ir({
          knowledgeSources: [
            ks({ name: 'Finance site', kind: 'SharePointSearchSource', classification: { strategy: 'reconnect' } as never }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });

  it('does NOT flag a public website', () => {
    expect(
      aclLossItems(
        ir({
          knowledgeSources: [
            ks({ name: 'Docs site', kind: 'PublicSiteSearchSource', reference: 'https://example.com', classification: { strategy: 'recreate' } as never }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });

  // A manual-review source is never migrated, so nothing is exposed. Listing it would
  // overstate the problem and it is already reported as not migrated elsewhere.
  it('does NOT flag a source we do not migrate at all', () => {
    expect(
      aclLossItems(
        ir({
          knowledgeSources: [
            ks({ name: 'Weird source', kind: 'SharePointSearchSource', classification: { strategy: 'manual-review' } as never }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });

  it('does NOT flag an agent with no knowledge at all', () => {
    expect(needsAclAcknowledgement(ir({}))).toBe(false);
  });
});

describe('orgWide — the worst realistic case, not a comfortable guess', () => {
  const withSource = (permissions?: AgentIR['permissions']) =>
    ir({
      permissions,
      knowledgeSources: [
        ks({ name: 'HR', kind: 'SharePointSearchSource', classification: { strategy: 'copy-and-index' } as never }),
      ],
    });

  it('is true when the source agent was open to everyone', () => {
    expect(aclDisclosureFor(withSource({ sharedPrincipals: [], chatAccess: { policy: 'any', groupIds: [] } })).orgWide).toBe(true);
  });

  it('is false when access was limited to specific groups', () => {
    expect(
      aclDisclosureFor(withSource({ sharedPrincipals: [], chatAccess: { policy: 'group', groupIds: ['g1'] } })).orgWide,
    ).toBe(false);
  });

  // Unknown must not read as safe. If we could not determine the audience, the customer
  // should see the worst realistic case — that is the entire point of this gate.
  it('assumes org-wide when permissions could not be read', () => {
    expect(aclDisclosureFor(withSource(undefined)).orgWide).toBe(true);
    expect(
      aclDisclosureFor(withSource({ sharedPrincipals: [], chatAccess: { policy: 'unknown', groupIds: [] } })).orgWide,
    ).toBe(true);
  });
});

describe('aclDisclosureSummary', () => {
  it('names the systems and the audience instead of hedging', () => {
    const d = aclDisclosureFor(
      ir({
        permissions: { sharedPrincipals: [], chatAccess: { policy: 'any', groupIds: [] } },
        knowledgeSources: [
          ks({ name: 'HR', kind: 'SharePointSearchSource', classification: { strategy: 'copy-and-index' } as never }),
        ],
      }),
    );
    const text = aclDisclosureSummary('HR Assistant', d);
    expect(text).toContain('HR Assistant');
    expect(text).toContain('SharePoint');
    expect(text).toContain('everyone in your organization');
    expect(text).toContain('cannot be changed');
  });

  it('is empty when there is nothing to disclose', () => {
    expect(aclDisclosureSummary('Agent', { items: [], orgWide: true })).toBe('');
  });
});
