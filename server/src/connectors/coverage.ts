/**
 * Per-operation coverage for SAME-VENDOR connectors.
 *
 * Distinct from `equivalence.ts`, which answers a cross-vendor question: "this agent read
 * Microsoft mail — what happens if it reads Google mail instead?" That model is keyed by
 * `M365Surface` and every row names a Google target, because a vendor really is changing.
 *
 * Confluence, Jira, Google Drive, HubSpot and SharePoint change no vendor. Confluence stays
 * Confluence. The only question is narrower and more practical: **the source agent called
 * operation X — does the migrated agent have a tool that does X, and how faithfully?**
 *
 * Forcing those into `Equivalence` would have meant inventing a fake "target service" for
 * every row, so this is a separate, smaller shape.
 *
 * Why it exists at all: `surfaceForConnector()` returns null for these connectors, so
 * `findEquivalence` is never called and every operation they use is UNJUDGED. Measured
 * 2026-08-20 across 151 staged agents — 28 operations on Tier-1 connectors had no verdict of
 * any kind. That is not the same as being broken (Google Drive has a tool for all 11
 * operations agents call) but it means the fidelity report cannot say so, and a customer
 * reading it cannot tell "we checked and it works" from "nobody looked".
 *
 * `verified` is the strict flag this codebase uses everywhere: true ONLY when a real call was
 * made against a real tenant and returned real data. Written by hand from evidence, never
 * inferred from a tool existing.
 */

export type CoverageFidelity =
  /** The tool does what the operation did. Nothing measurable is lost. */
  | 'exact'
  /** The capability survives with a stated constraint. */
  | 'narrowed'
  /** The migrated agent cannot do this. `tool` must be null. */
  | 'lost';

export interface OperationCoverage {
  /** Registry connector id, e.g. `shared_confluence`. */
  connectorId: string;
  /** The Copilot operationId as the source agent declares it. */
  operationId: string;
  /** Other operationIds this row answers for (API generations, renames, aliases). */
  covers?: string[];
  /** What the operation is, in the customer's words. */
  label: string;
  /** The tool the migrated agent actually gets. Null when the capability is lost. */
  tool: string | null;
  fidelity: CoverageFidelity;
  /** Why, whenever not `exact`. Required by test for non-exact rows. */
  reason?: string;
  /** True ONLY when exercised live against a real tenant. */
  verified?: boolean;
}

/**
 * Confluence.
 *
 * All four operations real agents call, measured across 151 staged agents:
 *   GetPages          27 agents
 *   GetSpaces         18 agents
 *   GetPageMetadata   16 agents
 *   GetPagesBySpace   14 agents
 *
 * Until 2026-08-20 the module shipped ONE tool (a text search), so three of these four had no
 * tool at all. All four rows below were exercised live against cf2020.atlassian.net on
 * 2026-08-20 (`_test_confluence_all_tools.ts`, 10 assertions, 0 failures) — 76 spaces read,
 * pages listed by key AND by name, a page read with and without its body.
 */
export const CONFLUENCE_COVERAGE: OperationCoverage[] = [
  {
    connectorId: 'shared_confluence',
    operationId: 'GetSpaces',
    covers: ['GetSpacesV2', 'ListSpaces'],
    label: 'List spaces',
    tool: 'confluence_list_spaces',
    fidelity: 'exact',
    verified: true,
  },
  {
    connectorId: 'shared_confluence',
    operationId: 'GetPagesBySpace',
    covers: ['GetPagesInSpace', 'ListPagesBySpace'],
    label: 'List the pages in a space',
    tool: 'confluence_list_pages_in_space',
    fidelity: 'exact',
    reason:
      'Accepts the space NAME as well as its key. Copilot passed an opaque space key; a ' +
      'customer asking the migrated agent says the name, so the tool resolves either and ' +
      'refuses an ambiguous name rather than picking one of two same-named spaces.',
    verified: true,
  },
  {
    connectorId: 'shared_confluence',
    operationId: 'GetPageMetadata',
    covers: ['GetPageMetadataV2'],
    label: 'Page metadata (title, author, version)',
    tool: 'confluence_get_page',
    fidelity: 'exact',
    reason:
      'Served by confluence_get_page with include_body=false, which returns title, space, ' +
      'url, version, updated and updatedBy without fetching the body.',
    verified: true,
  },
  {
    connectorId: 'shared_confluence',
    operationId: 'GetPages',
    covers: ['GetPage', 'GetPagesV2', 'GetPageById', 'GetContent'],
    label: 'Read page content',
    tool: 'confluence_get_page',
    fidelity: 'narrowed',
    reason:
      'Page text is returned as rendered HTML stripped to plain text and cut at 6000 ' +
      'characters, with a truncation note — Copilot returned the storage-format body ' +
      'uncut. Macros (tables, excerpts, includes) therefore arrive as their RENDERED text ' +
      'rather than as macro markup, which is closer to what a reader sees but is not the ' +
      'same payload the source agent received.',
    verified: true,
  },
];

/**
 * Jira.
 *
 * Six operations, measured across 151 staged agents:
 *   mcp_JiraIssueManagement  34 agents   (an MCP server, expanded below)
 *   ListIssues_Datacenter    34 agents
 *   GetIssue_V2              33 agents
 *   ListIssues               33 agents
 *   ListResources            15 agents
 *   GetIssue                  1 agent
 *
 * The MCP row matters more than its name suggests. A Copilot MCP tool carries no server URL
 * and is reached through the Power Platform proxy, which a migrated agent cannot use — so the
 * TRANSPORT is unreproducible. What it does carry is the list of tools the author selected,
 * and for the Jira MCP server those six are ordinary connector operations
 * (GetCurrentUser, ListIssues, ListIssues_Datacenter, ListProjects, ListResources,
 * ListIssueTypes_V2). boundToolSpec.ts expands them, so the CAPABILITY survives while the
 * dynamic discovery does not. Three of the six had no tool until 2026-08-20.
 *
 * All rows exercised live against cf2020.atlassian.net on 2026-08-20
 * (`_test_jira_all_tools.ts`, 12 assertions, 0 failures).
 */
export const JIRA_COVERAGE: OperationCoverage[] = [
  {
    connectorId: 'shared_jira',
    operationId: 'ListIssues',
    // The Data Center variant is the SAME question against a different deployment. This site
    // is Cloud (serverInfo deploymentType=Cloud, measured 2026-08-20) and Atlassian has
    // removed /rest/api/2/search there too — it returns the same 410 as v3 /search — so the
    // Cloud endpoint is the only one that answers, for both operations.
    covers: ['ListIssues_Datacenter', 'SearchIssues', 'ListIssuesV2'],
    label: 'Search issues with JQL',
    tool: 'jira_search',
    fidelity: 'narrowed',
    reason:
      'Served by /rest/api/3/search/jql, which is cursor-paginated and returns no total, so ' +
      'the match count comes from /search/approximate-count and is reported as APPROXIMATE. ' +
      'Jira also rejects an unbounded query, so a question with no JQL is answered against a ' +
      'bounded 365-day window and the tool says which window it used.',
    verified: true,
  },
  {
    connectorId: 'shared_jira',
    operationId: 'GetIssue_V2',
    covers: ['GetIssue', 'GetIssueByKey'],
    label: 'Get one issue by key',
    tool: 'jira_get_issue',
    fidelity: 'exact',
    verified: true,
  },
  {
    connectorId: 'shared_jira',
    operationId: 'ListProjects',
    covers: ['ListProjects_V2', 'GetProjects'],
    label: 'List projects',
    tool: 'jira_list_projects',
    fidelity: 'exact',
    verified: true,
  },
  {
    connectorId: 'shared_jira',
    operationId: 'GetCurrentUser',
    label: 'Who am I',
    tool: 'jira_get_current_user',
    fidelity: 'narrowed',
    reason:
      'Returns the ONE stored account the migrated agent authenticates as, not the person in ' +
      'the conversation — a deployed agent holds a single identity for everyone who talks to ' +
      'it. JQL terms like currentUser() therefore resolve to that shared account, so the tool ' +
      'states this on every call rather than letting "my issues" read as the asker\'s issues.',
    verified: true,
  },
  {
    connectorId: 'shared_jira',
    operationId: 'ListIssueTypes_V2',
    covers: ['ListIssueTypes', 'GetIssueTypes'],
    label: 'List issue types',
    tool: 'jira_list_issue_types',
    fidelity: 'narrowed',
    reason:
      'Jira repeats a type once per project scheme, so the raw list has many duplicates. The ' +
      'tool deduplicates on name and reports how many entries were collapsed — a per-scheme ' +
      'type id is therefore not addressable through this tool.',
    verified: true,
  },
  {
    connectorId: 'shared_jira',
    operationId: 'ListResources',
    label: 'List accessible Atlassian sites',
    tool: 'jira_list_sites',
    fidelity: 'narrowed',
    reason:
      'Copilot enumerated every site an OAuth token could reach. A migrated agent uses a ' +
      'stored email + API token against ONE site, and Atlassian\'s accessible-resources ' +
      'endpoint rejects that credential type (401, measured 2026-08-20). The tool reports the ' +
      'single configured site and states that multi-site discovery is gone, so an agent that ' +
      'used this to choose between sites is now fixed to one.',
    verified: true,
  },
  {
    connectorId: 'shared_jira',
    operationId: 'mcp_JiraIssueManagement',
    label: 'Jira MCP Server',
    // Not null: every tool the author selected on this server IS reproduced, as a direct
    // vendor call. Marking it lost would understate what the customer keeps.
    tool: 'jira_search',
    fidelity: 'narrowed',
    reason:
      'The MCP transport cannot be reproduced — a Copilot MCP tool carries no server URL and ' +
      'is reached through the Power Platform proxy. The six tools this server exposed are ' +
      'ordinary Jira operations and each is wired as a direct API call instead, so the ' +
      'capability survives. What is lost is MCP\'s dynamic discovery: the migrated agent has ' +
      'exactly the six tools the author had selected, and will not pick up tools added to the ' +
      'server later.',
    // NOT verified, unlike the six rows above it. Those were each called against the real
    // site; an MCP server reached through the Power Platform proxy is something we have never
    // been able to call at all, so there is nothing here that was proven. The capability
    // claim rests on the six verified rows, and this row says so rather than borrowing their
    // evidence.
    verified: false,
  },
];

/**
 * Google Drive.
 *
 * Eleven operations, measured across 33 staged agents — the largest single block of used
 * operations on any Tier-1 connector:
 *   ListFolder             33      UpdateFile             18
 *   GetFileContent         33      ExtractFolderV2        18
 *   ListRootFolder         18      GetFileMetadataByPath  18
 *   DeleteFile             18      CopyFile               18
 *   CreateFileV2           18      GetFileContentByPath   18
 *   GetFileMetadata        18
 *
 * ONE PRECONDITION GOVERNS EVERY ROW. Drive is reached by domain-wide delegation, acting as
 * a PERSON, and which person is a per-agent fact (`agentConnectorIdentity`). Without a
 * confirmed identity the orchestrator drops the connector and reports it needs-review — it
 * does not deploy a Drive tool that cannot see anything. Measured 2026-08-20: run as the bare
 * service account, My Drive root listed 0 items and every content upload 403'd, because a
 * service account owns no Drive. So these rows describe what an agent WITH a confirmed
 * identity gets; there is no half-configured middle state that silently returns nothing.
 *
 * All eleven exercised live against the customer's Drive as zara@storefuze.com on 2026-08-20
 * (`_test_drive_all_tools.ts`, 24 assertions, 0 failures) — including the write paths, in a
 * scratch folder the harness creates and trashes. The assertions are round-trips, not status
 * codes: content written is read back and compared, a copy must carry the bytes, an update
 * must REPLACE rather than append, and an extracted zip member must really appear in Drive.
 */
export const DRIVE_COVERAGE: OperationCoverage[] = [
  {
    connectorId: 'shared_googledrive',
    operationId: 'ListFolder',
    covers: ['ListFolderV2', 'ListFiles'],
    label: 'List a folder',
    tool: 'google_drive_list_files',
    fidelity: 'narrowed',
    reason:
      'One call returns at most 1000 entries (20 pages) and sets `truncated` when a folder ' +
      'holds more, so a question about a very large folder is answered from a prefix rather ' +
      'than by failing. Trashed files are excluded, which is what Drive itself shows.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'ListRootFolder',
    label: 'List the top of My Drive',
    // Not a separate tool: "root" is a real folder id in the Drive API, so the same tool
    // answers it. Proven with an explicit assertion rather than assumed from the docs.
    tool: 'google_drive_list_files',
    fidelity: 'exact',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'GetFileContent',
    covers: ['GetFileContentV2'],
    label: 'Read a file',
    tool: 'google_drive_read_file',
    fidelity: 'narrowed',
    reason:
      'Returns TEXT, extracted per format: plain text as-is, PDF/Word/Excel parsed, and ' +
      'native Docs/Sheets/Slides exported (Sheets as .xlsx, because a CSV export silently ' +
      'keeps only the first tab). Images and other binaries are refused with a reason ' +
      'instead of returning bytes the model cannot use, and very long files are truncated at ' +
      '60,000 characters.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'GetFileContentByPath',
    label: 'Read a file by path',
    tool: 'google_drive_read_file',
    fidelity: 'narrowed',
    reason:
      'Two calls, because Drive has no path lookup at all: google_drive_find_by_path walks ' +
      'each segment by NAME from the root, then the id is read. So a path is resolved by ' +
      'name-matching rather than natively, and duplicate names along the way make it ' +
      'ambiguous — the walk reports the segment it could not resolve rather than guessing.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'GetFileMetadata',
    label: 'File metadata',
    tool: 'google_drive_get_metadata',
    fidelity: 'exact',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'GetFileMetadataByPath',
    label: 'File metadata by path',
    tool: 'google_drive_find_by_path',
    fidelity: 'narrowed',
    reason:
      'Resolved by walking the path segment by segment against file NAMES, since the Drive ' +
      'API has no path concept. Correct for a unique path and ambiguous where two siblings ' +
      'share a name, which the tool reports rather than resolving arbitrarily.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'CreateFileV2',
    covers: ['CreateFile'],
    label: 'Create a file',
    tool: 'google_drive_create_file',
    fidelity: 'narrowed',
    reason:
      'Writes a text string as the file bytes, so only mime types a plain string genuinely ' +
      'IS are accepted (text, markdown, csv, json, xml). Asking for .docx or .xlsx is ' +
      'refused, deliberately: it previously produced a file Drive labelled as Word whose ' +
      'bytes were plain text, which then failed to open and could not be diagnosed from the ' +
      'outside. Generating real Office binaries is not supported.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'UpdateFile',
    label: 'Update a file',
    tool: 'google_drive_update_file',
    fidelity: 'narrowed',
    reason:
      'REPLACES the file content (proven by assertion — an append would be a different ' +
      'operation) and can rename. Subject to the same text-only limit as create: it cannot ' +
      'write real Office binaries.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'CopyFile',
    label: 'Copy a file',
    tool: 'google_drive_copy_file',
    fidelity: 'exact',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'DeleteFile',
    label: 'Delete a file',
    tool: 'google_drive_delete_file',
    fidelity: 'narrowed',
    reason:
      'Moves the file to Trash rather than erasing it, so a wrong delete by an agent stays ' +
      'recoverable. The file then disappears from every listing and search, and ' +
      'google_drive_get_metadata reports `trashed: true` so the agent can say the file is in ' +
      'the Trash instead of describing it as current — that field was added 2026-08-20 after ' +
      'a trashed file read back as an ordinary live file.',
    verified: true,
  },
  {
    connectorId: 'shared_googledrive',
    operationId: 'ExtractFolderV2',
    covers: ['ExtractFolder'],
    label: 'Extract an archive',
    tool: 'google_drive_extract_archive',
    fidelity: 'narrowed',
    reason:
      'ZIP only — each entry is uploaded into the destination folder as its own file. Other ' +
      'archive formats (.7z, .rar, .tar.gz) are refused by name rather than attempted, so an ' +
      'agent gets a clear reason instead of a corrupt result.',
    verified: true,
  },
];

/**
 * HubSpot — four connector ids, one API, one token, one tool module.
 *
 * Power Platform ships HubSpot as several connectors and the customer's agents use the
 * INDEPENDENT PUBLISHER variants, not the Microsoft one. Measured across staged agents:
 *   shared_hubspotcrmv2       ListAssociations                                 15 agents
 *   shared_hubspotsettingsv2  GetTheDailyApiUsageAndLimitsForAHubspotAccount    10 agents
 *   shared_hubspotcrm         CompaniesList                                      8 agents
 *   shared_hubspot            (no staged agent uses it — it was the guessed id)
 *
 * Until 2026-08-20 there was NO HubSpot tool module: all three ids fell through to
 * generic_rest.py's "call any REST API" tool, the shape the model was measured declining to
 * use for Drive and Confluence. So every row here is new code, proven live against portal
 * 246967746 (`_test_hubspot_all_tools.ts`, 20 assertions, 0 failures).
 *
 * Rows are recorded against EVERY id that uses the operation rather than one canonical id,
 * because findCoverage is keyed by connectorId and the report must answer for the id the
 * agent actually declared.
 */
const HUBSPOT_ROWS: Array<Omit<OperationCoverage, 'connectorId'> & { ids: string[] }> = [
  {
    ids: ['shared_hubspotcrm', 'shared_hubspot', 'shared_hubspotcrmv2'],
    operationId: 'CompaniesList',
    covers: ['ListCompanies', 'GetCompanies'],
    label: 'List companies',
    tool: 'hubspot_list_companies',
    fidelity: 'narrowed',
    reason:
      'Returns one page (default 20, max 100) with a `nextPage` cursor. HubSpot returns no ' +
      'total for a plain list, so the tool does not report one and says as much — for "how ' +
      'many", hubspot_search returns a real count. Properties are requested explicitly ' +
      '(name, domain, industry, city, country, phone, website), because a list call without ' +
      'them returns a 200 carrying only internal ids and timestamps.',
    verified: true,
  },
  {
    ids: ['shared_hubspotcrmv2', 'shared_hubspot', 'shared_hubspotcrm'],
    operationId: 'ListAssociations',
    covers: ['GetAssociations', 'ListAssociationsV4'],
    label: 'Linked records (associations)',
    tool: 'hubspot_list_associations',
    fidelity: 'narrowed',
    reason:
      "HubSpot's association API returns linked record IDS ONLY — an un-hydrated answer is a " +
      'list of 18-digit numbers. The tool makes a second batch call to turn them into names ' +
      'and record links, and surfaces the association label ("Contact with Primary ' +
      'Company"), which is often the real answer. Limited to the four object types that ' +
      'matter here (companies, contacts, deals, tickets); custom objects are not addressable ' +
      'through it.',
    verified: true,
  },
  {
    // CMS, found on a real agent by the connector census — an id no hand-written Tier-1 list
    // contained, and therefore a capability that was silently getting no tool.
    ids: ['shared_hubspotcms', 'shared_hubspot'],
    operationId: 'TemplatesList',
    covers: ['ListTemplates', 'GetTemplates'],
    label: 'List CMS templates',
    tool: 'hubspot_list_templates',
    fidelity: 'narrowed',
    reason:
      'Served by the LEGACY /content/api/v2/templates, because the v3 equivalent does not ' +
      'exist on this portal (/cms/v3/design-manager/templates returns 404, measured ' +
      '2026-08-21). BLOCKED on a scope the customer controls: CMS access is a different scope ' +
      'family from CRM, and the private app token in use has none of ' +
      'design-manager-access / content-editor-access / landingpages-read, so the call answers ' +
      '403. The tool reports exactly that, naming the scopes, rather than a bare 403. Once one ' +
      'of them is added a NEW token must be issued — a private app\'s scopes are fixed at ' +
      'creation and cannot be read back through the API.',
    // NOT verified: the endpoint has never returned data here. The tool is written and its
    // failure path is proven; the success path is not, and those are different claims.
    verified: false,
  },
  {
    ids: ['shared_hubspotsettingsv2', 'shared_hubspot'],
    operationId: 'GetTheDailyApiUsageAndLimitsForAHubspotAccount',
    covers: ['GetDailyApiUsage', 'GetApiUsage'],
    label: 'Daily API usage and limits',
    tool: 'hubspot_get_api_usage',
    fidelity: 'narrowed',
    reason:
      'There is no portal-level usage endpoint: five candidate paths all 404 on this account ' +
      '(measured 2026-08-20), and usage is reported per private app. The tool reads ' +
      "/account-info/v3/api-usage/daily/private-apps AND the request's own rate-limit " +
      'headers, because that endpoint\'s `currentUsage` is a lagging snapshot — it read 0 ' +
      'while the same response header showed 14 calls used. Live figures are quoted and the ' +
      'snapshot is labelled with its collection time. The limit covers every private app on ' +
      'the account, not this agent alone, which the tool states.',
    verified: true,
  },
];

export const HUBSPOT_COVERAGE: OperationCoverage[] = HUBSPOT_ROWS.flatMap(({ ids, ...row }) =>
  ids.map((connectorId) => ({ connectorId, ...row })),
);

/** Every same-vendor coverage table, concatenated. Add a new connector here. */
export const COVERAGE: OperationCoverage[] = [
  ...CONFLUENCE_COVERAGE,
  ...JIRA_COVERAGE,
  ...DRIVE_COVERAGE,
  ...HUBSPOT_COVERAGE,
];

const BY_CONNECTOR = new Map<string, OperationCoverage[]>();
for (const row of COVERAGE) {
  BY_CONNECTOR.set(row.connectorId, [...(BY_CONNECTOR.get(row.connectorId) ?? []), row]);
}

/**
 * What does the migrated agent do about `connectorId`.`operationId`?
 *
 * Returns undefined when nobody has judged this operation — deliberately distinct from a
 * `lost` row. "We checked and it cannot be done" and "nobody looked" must never render
 * identically in a report, because only one of them is a finished piece of work.
 */
export function findCoverage(connectorId: string, operationId: string): OperationCoverage | undefined {
  const rows = BY_CONNECTOR.get(connectorId);
  if (!rows) return undefined;
  const wanted = operationId.trim().toLowerCase();
  return (
    rows.find((r) => r.operationId.toLowerCase() === wanted) ??
    rows.find((r) => (r.covers ?? []).some((c) => c.toLowerCase() === wanted))
  );
}

/** True when this connector has a coverage table at all. */
export function hasCoverageTable(connectorId: string): boolean {
  return BY_CONNECTOR.has(connectorId);
}

/** Every operation judged for a connector — for the report and for tests. */
export function coverageFor(connectorId: string): OperationCoverage[] {
  return BY_CONNECTOR.get(connectorId) ?? [];
}
