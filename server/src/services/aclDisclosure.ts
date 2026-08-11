/**
 * Which knowledge sources lose their source permissions when we migrate them?
 *
 * THE PROBLEM, proven live (docs/verification-ledger.md §1.3): every Discovery Engine data
 * store our pipeline creates has `aclEnabled: false`, and that flag is **immutable** — it
 * can only be set at creation. So a SharePoint folder restricted to Finance, or a
 * Confluence space restricted to Engineering, becomes readable by anyone who can reach the
 * migrated agent. In the same project, the three stores created by Google's own native
 * connectors are `aclEnabled: true`, so this is our pipeline's limitation, not the
 * platform's.
 *
 * This module does not fix that. It makes it impossible to migrate into it silently.
 * The customer is told, per source, what protection is being dropped, and has to say yes.
 *
 * WHY NOT BLOCK: a hard refusal makes the tool look worse than a hand migration and pushes
 * customers to disable the check. The decision (docs/connector-transform-plan.md) is to
 * migrate with a mandatory acknowledgement instead — the run cannot START without one, but
 * the acknowledgement is always available.
 *
 * Pure: no I/O, no config. Everything here is derived from the IR.
 */

import type { AgentIR, KnowledgeSourceIR } from '../types.js';

/** One knowledge source whose source-side permissions will not survive migration. */
export interface AclLossItem {
  /** The knowledge source as the author named it in Copilot Studio. */
  sourceName: string;
  /** The permissioned system the content comes from, in the customer's words. */
  system: string;
  /** How it will be migrated — explains WHY the permissions are dropped. */
  strategy: string;
  /** One sentence a non-engineer can act on. */
  detail: string;
}

export interface AclDisclosure {
  /** Sources that will lose their permissions. Empty means nothing to acknowledge. */
  items: AclLossItem[];
  /**
   * True when the migrated agent will be reachable by the whole organization, which is
   * what turns "permissions dropped" into "everyone can read it". Sharing is decided later
   * in the pipeline, so this is the intent as far as the IR knows it.
   */
  orgWide: boolean;
}

/**
 * Strategies that pull content INTO a data store we create — and therefore into a store
 * that cannot carry ACLs.
 *
 * `reconnect` is deliberately absent: it wires Google's native connector, which produces
 * `aclEnabled: true` (proven for SharePoint and Google Drive in ledger §1.3). Nothing is
 * lost on that path, and reporting a loss there would be a false alarm.
 *
 * `recreate` is absent too — it points at a public website. There is no permission to lose.
 */
const INDEXING_STRATEGIES = new Set(['copy-and-index', 'confluence-crawler', 'dataverse-snapshot']);

/**
 * Name the permissioned system behind a source, for a human.
 *
 * Returns undefined when the content carries no meaningful source-side permissions — a
 * public website has nothing to protect, and saying it lost protection would train people
 * to ignore this warning.
 */
function permissionedSystem(src: KnowledgeSourceIR): string | undefined {
  const kind = (src.kind ?? '').toLowerCase();
  const refs = [src.reference ?? '', ...(src.references ?? [])].join(' ').toLowerCase();
  const desc = (src.description ?? '').toLowerCase();

  if (src.confluenceSpaceNames?.length || kind.includes('confluence') || desc.includes('confluence')) {
    return 'Confluence';
  }
  if (kind.includes('sharepoint') || /sharepoint\.com/.test(refs)) return 'SharePoint';
  if (kind.includes('onedrive') || /-my\.sharepoint\.com/.test(refs)) return 'OneDrive';
  if (kind.includes('dataverse') || src.classification?.strategy === 'dataverse-snapshot') {
    return 'Dataverse';
  }
  // An author-uploaded file is only as protected as the agent it was attached to. That is
  // still a real boundary: the source agent may have been shared with a handful of people
  // while the migrated one is reachable org-wide.
  if (kind.includes('fileupload') || src.file?.name) return 'an uploaded file';
  return undefined;
}

/**
 * Sources on this agent whose permissions will not survive.
 *
 * Only counts sources we will actually index. A source classified `manual-review` is not
 * migrated at all, so nothing is exposed — it is reported elsewhere as not migrated, and
 * listing it here would overstate the problem.
 */
export function aclLossItems(ir: AgentIR): AclLossItem[] {
  const items: AclLossItem[] = [];
  for (const src of ir.knowledgeSources ?? []) {
    const strategy = src.classification?.strategy;
    if (!strategy || !INDEXING_STRATEGIES.has(strategy)) continue;
    const system = permissionedSystem(src);
    if (!system) continue;
    items.push({
      sourceName: src.name || '(unnamed source)',
      system,
      strategy,
      detail:
        `Content from ${system} will be copied into a Gemini data store that cannot carry ` +
        `${system} permissions. Anyone who can use the migrated agent will be able to read ` +
        `it, including people who cannot open the original.`,
    });
  }
  return items;
}

/**
 * Will the migrated agent be reachable org-wide?
 *
 * `chatAccess.policy` mirrors Copilot's own end-user access setting. `any` means everyone
 * in the tenant. When we could not read the source's permissions at all, assume org-wide:
 * the whole point of this gate is that the customer sees the worst realistic case rather
 * than a comfortable guess.
 */
function isOrgWide(ir: AgentIR): boolean {
  const policy = ir.permissions?.chatAccess?.policy;
  if (!policy) return true;
  return policy === 'any' || policy === 'any-multitenant' || policy === 'unknown';
}

export function aclDisclosureFor(ir: AgentIR): AclDisclosure {
  return { items: aclLossItems(ir), orgWide: isOrgWide(ir) };
}

/** Does this agent need an acknowledgement before it can be migrated? */
export function needsAclAcknowledgement(ir: AgentIR): boolean {
  return aclLossItems(ir).length > 0;
}

/**
 * The text the customer acknowledges. Deliberately concrete: it names the sources and the
 * systems, because "some permissions may not be preserved" is the kind of sentence people
 * click past.
 */
export function aclDisclosureSummary(agentName: string, d: AclDisclosure): string {
  if (!d.items.length) return '';
  const bySystem = [...new Set(d.items.map((i) => i.system))].join(', ');
  const audience = d.orgWide
    ? 'everyone in your organization'
    : 'everyone the migrated agent is shared with';
  return (
    `"${agentName}" has ${d.items.length} knowledge source(s) from ${bySystem} whose ` +
    `permissions cannot be carried into Gemini. After migration, ${audience} will be able ` +
    `to read that content through the agent, including people who cannot open the ` +
    `original. This cannot be changed after the data store is created.`
  );
}
