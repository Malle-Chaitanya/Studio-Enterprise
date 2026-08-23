/**
 * The fixture source: canned data so every v2 screen can be built and reviewed
 * without a connected tenant.
 *
 * It holds in-memory state, so saving a credential really does flip that row to
 * connected — the flow behaves, the numbers are invented. The shell shows a
 * permanent "fixture data" banner whenever this source is in use.
 *
 * This replaces the earlier trick of stubbing `window.fetch`: that was fine for one
 * screen and wrong as an architecture, because it made every screen's data path
 * depend on a monkey-patch rather than an interface.
 */

import type { ConnectorRequirement, ConnectorValidation } from '../../api.ts';
import { sortRows } from './api.ts';
import type {
  AgentRow, AgentsSource, ConnectSource, ConnectorRow, ConnectorScan, ConnectorsSource,
  DestOption, EnvPair, EnvRow, MigrateSource, PairSource, ReportRow, ReportSource,
  ReviewFinding, ReviewRow, ReviewSource, RunState, UserRow, UsersSource, V2Source, Verdict,
} from './types.ts';

const ATLASSIAN_GROUP = {
  id: 'atlassian',
  name: 'Atlassian (one API token)',
  setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  setupHint:
    'One API token covers Confluence and Jira. The token inherits the permissions of the ' +
    'account that creates it — use a purpose-made account limited to the spaces and projects ' +
    'the agent should see, not a full admin.',
  siblings: ['shared_jira'],
};

const MS_GROUP = {
  id: 'ms_graph',
  name: 'Microsoft 365 (one App Registration)',
  setupUrl: 'https://portal.azure.com/',
  setupHint:
    'Create ONE app registration for all Microsoft connectors. Add the permissions listed ' +
    'below as APPLICATION permissions, then click Grant admin consent.',
  siblings: ['shared_onedrive', 'shared_teams', 'shared_office365'],
};

/** Mutable so a save in the fixture behaves like a save. */
const REQS: Record<string, ConnectorRequirement> = {
  shared_confluence: {
    connectorId: 'shared_confluence', name: 'Confluence', icon: '📘', authKind: 'api_token',
    group: ATLASSIAN_GROUP,
    fields: [
      { key: 'base_url', label: 'Atlassian Cloud URL', type: 'url', shared: true, supplied: true,
        placeholder: 'https://yourcompany.atlassian.net', hint: 'Your Atlassian Cloud base URL (before /wiki or /jira)' },
      { key: 'email', label: 'Account Email', type: 'text', shared: true, supplied: true,
        hint: 'The account the API token belongs to' },
      { key: 'api_token', label: 'API Token', type: 'password', shared: true, supplied: false,
        hint: 'id.atlassian.com -> Security -> Create and manage API tokens' },
    ],
  },
  shared_jira: {
    connectorId: 'shared_jira', name: 'Jira', icon: '📋', authKind: 'api_token',
    group: { ...ATLASSIAN_GROUP, siblings: ['shared_confluence'] },
    fields: [
      { key: 'base_url', label: 'Atlassian Cloud URL', type: 'url', shared: true, supplied: true },
      { key: 'email', label: 'Account Email', type: 'text', shared: true, supplied: true },
      { key: 'api_token', label: 'API Token', type: 'password', shared: true, supplied: false },
    ],
  },
  shared_sharepointonline: {
    connectorId: 'shared_sharepointonline', name: 'SharePoint Online', icon: '📂',
    authKind: 'client_credentials', adminConsentRequired: true,
    requiredPermissions: ['Sites.Read.All', 'Files.Read.All'],
    group: MS_GROUP,
    fields: [
      { key: 'tenant_id', label: 'Directory (tenant) ID', type: 'password', shared: true, supplied: true },
      { key: 'client_id', label: 'Application (client) ID', type: 'password', shared: true, supplied: true },
      { key: 'client_secret', label: 'Client Secret', type: 'password', shared: true, supplied: false,
        hint: 'Azure Portal → App registrations → Certificates & secrets → New client secret' },
    ],
  },
  shared_hubspot: {
    connectorId: 'shared_hubspot', name: 'HubSpot', icon: '🟠', authKind: 'api_key', configured: true,
    fields: [
      { key: 'api_key', label: 'Private App Token', type: 'password', shared: true, supplied: true,
        hint: 'HubSpot → Settings → Integrations → Private Apps' },
    ],
  },
  shared_smartsheet: { connectorId: 'shared_smartsheet', name: 'Smartsheet', unknown: true },
};

const AGENTS: Record<string, string[]> = {
  shared_confluence: ['HR Onboarding Assistant', 'Benefits Q&A', 'Leave Balance Helper'],
  shared_jira: ['Field Service Dispatcher'],
  shared_sharepointonline: ['Expense Policy Bot', 'Contract Reviewer'],
  shared_hubspot: ['Sales Objection Coach'],
  shared_smartsheet: ['Vendor Risk Screener'],
};

/** The same agents by botid, matching AGENT_ROWS below. The real scan returns ids
 *  alongside names, and the per-agent decisions match on ids, so a fixture without
 *  them would exercise a path production no longer uses. */
const AGENT_IDS: Record<string, string[]> = {
  shared_confluence: ['b1', 'b5', 'b6'],
  shared_jira: ['b9'],
  shared_sharepointonline: ['b3', 'b7'],
  shared_hubspot: ['b2'],
  shared_smartsheet: ['b4'],
  shared_googledrive: ['b1', 'b2'],
};

const FLOWS: Record<string, string[]> = {
  shared_jira: ['Escalate ticket', 'Create bug', 'Sync status'],
  shared_hubspot: ['Log objection', 'Update deal'],
  shared_sharepointonline: ['Archive policy doc'],
  shared_smartsheet: ['Update vendor sheet'],
};

const SAVED_IDS = new Set(['shared_hubspot']);

/** Same latency everywhere, so the agent's pacing matches the real screen. */
const LAG = 420;
const wait = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => window.setTimeout(() => resolve(value), LAG));

function toRow(id: string): ConnectorRow {
  const req = REQS[id] ?? null;
  const fields = req?.fields ?? [];
  const missingFields = fields.filter((f) => !f.supplied).map((f) => f.key);
  const saved = SAVED_IDS.has(id)
    ? { connectorId: id, fields: fields.map((f) => f.key), project: 'contoso-gemini', matchesDestination: true,
        updatedAt: '2026-08-11T16:42:00.000Z' }
    : null;

  let state: ConnectorRow['state'];
  if (req?.unknown) state = 'cannot-migrate';
  else if (missingFields.length === 0) state = 'ready';
  else state = 'needs-you';

  return {
    connectorId: id,
    name: req?.name ?? id.replace(/^shared_/, ''),
    agentNames: AGENTS[id] ?? [],
    agentIds: AGENT_IDS[id] ?? [],
    flowNames: FLOWS[id] ?? [],
    detected: {
      connectorId: id,
      def: req?.name ? { name: req.name } as never : undefined,
      flowCount: (FLOWS[id] ?? []).length,
      flowNames: FLOWS[id] ?? [],
      agentNames: AGENTS[id] ?? [],
      unsupported: req?.unknown,
      confidence: id === 'shared_smartsheet' ? 'heuristic' : 'certain',
    },
    req,
    saved,
    missingFields,
    state,
  };
}

const connectors: ConnectorsSource = {
    scan: async (): Promise<ConnectorScan> => wait({
      rows: sortRows(Object.keys(REQS).map(toRow)),
      envs: [{ env: 'https://contoso.crm.dynamics.com', botIds: ['a', 'b', 'c'] }],
    }),
    requirements: async (_session, connectorId) => wait(REQS[connectorId] ?? null),
    save: async (_session, connectorId, creds): Promise<{ validation?: ConnectorValidation }> => {
      const req = REQS[connectorId];
      // Mark exactly the fields that were supplied, on this connector AND its
      // siblings — a shared credential really does unblock the whole group.
      const groupIds = req?.group ? [connectorId, ...req.group.siblings] : [connectorId];
      for (const id of groupIds) {
        const target = REQS[id];
        if (!target?.fields) continue;
        target.fields = target.fields.map((f) =>
          creds.some((c) => c.field === f.key) ? { ...f, supplied: true } : f);
      }
      SAVED_IDS.add(connectorId);
      // A Microsoft app authenticates fine with nothing consented, so this is the
      // honest verdict for that case — the fixture must not pretend it passed.
      const validation: ConnectorValidation = creds.some((c) => c.field === 'client_secret')
        ? { code: 'permission_denied',
            detail: 'The app authenticated, but Sites.Read.All is not consented. An admin must grant it.' }
        : { code: 'ok' };
      return wait({ validation });
    },
    forget: async (_session, connectorId) => {
      SAVED_IDS.delete(connectorId);
      const req = REQS[connectorId];
      if (req?.fields) req.fields = req.fields.map((f) => ({ ...f, supplied: false }));
      await wait(null);
    },
  };

// ── the rest of the phases ──────────────────────────────────────────────────
// Invented numbers, consistent with each other: 4 environments, 9 agents, the
// same agent names everywhere. One dataset, so walking the flow tells one story.

const ENVS: EnvRow[] = [
  { url: 'https://contoso.crm.dynamics.com', name: 'Production', accessible: true, agents: 4, topics: 67 },
  { url: 'https://contoso-hr.crm.dynamics.com', name: 'HR', accessible: true, agents: 2, topics: 20 },
  { url: 'https://contoso-legal.crm.dynamics.com', name: 'Legal', accessible: true, agents: 2, topics: 37 },
  { url: 'https://contoso-field.crm.dynamics.com', name: 'Field ops', accessible: false, agents: 1, topics: 40 },
];

const DESTS: DestOption[] = [
  { project: 'contoso-gemini', name: 'Contoso Gemini', engines: [
    { id: 'contoso-assistant_1730', displayName: 'Contoso Assistant' },
    { id: 'contoso-hr_4471', displayName: 'HR Assistant' },
  ] },
  { project: 'contoso-legal-ai', name: 'Contoso Legal AI', engines: [
    { id: 'legal-copilot_2201', displayName: 'Legal Copilot' },
  ] },
  { project: 'contoso-sandbox', name: 'Sandbox', engines: [] },
];

const FIX_AGENTS: AgentRow[] = [
  { botId: 'b1', name: 'HR Onboarding Assistant', env: ENVS[0].url, envName: 'Production', owner: 'Ayesha K.', topics: 14, knowledge: 6 },
  { botId: 'b2', name: 'Sales Objection Coach', env: ENVS[0].url, envName: 'Production', owner: 'Marco D.', topics: 18, knowledge: 7 },
  { botId: 'b3', name: 'Expense Policy Bot', env: ENVS[0].url, envName: 'Production', owner: 'Marco D.', topics: 9, knowledge: 3 },
  { botId: 'b4', name: 'Vendor Risk Screener', env: ENVS[0].url, envName: 'Production', owner: 'Nina P.', topics: 26, knowledge: 14 },
  { botId: 'b5', name: 'Benefits Q and A', env: ENVS[1].url, envName: 'HR', owner: 'Ayesha K.', topics: 12, knowledge: 5 },
  { botId: 'b6', name: 'Leave Balance Helper', env: ENVS[1].url, envName: 'HR', owner: 'Ayesha K.', topics: 8, knowledge: 2 },
  { botId: 'b7', name: 'Contract Reviewer', env: ENVS[2].url, envName: 'Legal', topics: 22, knowledge: 11 },
  { botId: 'b8', name: 'NDA Checker', env: ENVS[2].url, envName: 'Legal', owner: 'Priya N.', topics: 15, knowledge: 8 },
  { botId: 'b9', name: 'Field Service Dispatcher', env: ENVS[3].url, envName: 'Field ops', topics: 40, knowledge: 21 },
];

const USERS: UserRow[] = [
  { sourceId: 'u1', sourceEmail: 'ayesha.k@contoso.com', sourceName: 'Ayesha Khan', mapped: 'ayesha.k@contoso-gws.com', state: 'mapped' },
  { sourceId: 'u2', sourceEmail: 'marco.d@contoso.com', sourceName: 'Marco Diaz', mapped: 'marco.d@contoso-gws.com', state: 'mapped' },
  { sourceId: 'u3', sourceEmail: 'nina.p@contoso.com', sourceName: 'Nina Patel', suggested: 'n.patel@contoso-gws.com', state: 'suggested' },
  { sourceId: 'u4', sourceEmail: 'priya.n@contoso.com', sourceName: 'Priya Nair', suggested: 'priya@contoso-gws.com', state: 'suggested' },
  { sourceId: 'u5', sourceEmail: 'legal-team@contoso.com', sourceName: 'Legal Team (group)', state: 'unmapped' },
  { sourceId: 'u6', sourceEmail: 'svc-dispatch@contoso.com', sourceName: 'Dispatch service account', state: 'unmapped' },
];

const CANDIDATES = [
  { email: 'ayesha.k@contoso-gws.com', name: 'Ayesha Khan' },
  { email: 'marco.d@contoso-gws.com', name: 'Marco Diaz' },
  { email: 'n.patel@contoso-gws.com', name: 'Nina Patel' },
  { email: 'priya@contoso-gws.com', name: 'Priya Nair' },
  { email: 'legal@contoso-gws.com', name: 'Legal (group)' },
  { email: 'ops@contoso-gws.com', name: 'Operations' },
];

/** Per-agent verdicts. Deliberately mixed: a tool that reports "all clean" for
 *  every agent is a tool nobody should believe. */
const REVIEWS: Record<string, { effort: 'low' | 'medium' | 'high'; findings: ReviewFinding[] }> = {
  b1: { effort: 'low', findings: [
    { verdict: 'clean', component: '14 topics', detail: 'Compiled to instructions and examples.' },
    { verdict: 'clean', component: '6 knowledge sources', detail: 'All SharePoint, reachable with the app you configured.' },
  ] },
  b2: { effort: 'medium', findings: [
    { verdict: 'clean', component: '18 topics', detail: 'Compiled.' },
    { verdict: 'needs-review', component: 'AI Builder prompt', detail: 'Kept verbatim in the instruction, but Gemini will phrase answers differently.' },
    { verdict: 'needs-review', component: 'HubSpot action', detail: 'Reproduced against the HubSpot API — verify the deal fields after migrating.' },
  ] },
  b3: { effort: 'low', findings: [
    { verdict: 'clean', component: '9 topics', detail: 'Compiled.' },
    { verdict: 'needs-review', component: 'SharePoint knowledge', detail: 'Indexed knowledge loses source permissions — anyone with the agent can read it.' },
  ] },
  b4: { effort: 'high', findings: [
    { verdict: 'clean', component: '26 topics', detail: 'Compiled.' },
    { verdict: 'lost', component: 'Smartsheet action', detail: 'Not in our connector registry — this action cannot be reproduced.' },
    { verdict: 'needs-review', component: 'Adaptive card', detail: 'Rendered as text; the card layout does not exist in Gemini.' },
  ] },
  b5: { effort: 'low', findings: [
    { verdict: 'clean', component: '12 topics', detail: 'Compiled.' },
    { verdict: 'clean', component: '5 knowledge sources', detail: 'Confluence, via the token you supplied.' },
  ] },
  b6: { effort: 'low', findings: [
    { verdict: 'clean', component: '8 topics', detail: 'Compiled.' },
  ] },
  b7: { effort: 'high', findings: [
    { verdict: 'clean', component: '22 topics', detail: 'Compiled.' },
    { verdict: 'lost', component: 'Power Automate approval flow', detail: 'Flows are out of scope in this phase — the agent will answer but not start an approval.' },
    { verdict: 'needs-review', component: 'No owner recorded', detail: 'Nobody is named as owner in Dataverse, so nobody will own it in Gemini either.' },
  ] },
  b8: { effort: 'medium', findings: [
    { verdict: 'clean', component: '15 topics', detail: 'Compiled.' },
    { verdict: 'needs-review', component: 'Jira lookup', detail: 'Reproduced against the Jira API — check the project scope of the token.' },
  ] },
  b9: { effort: 'high', findings: [
    { verdict: 'clean', component: '40 topics', detail: 'Compiled.' },
    { verdict: 'lost', component: 'Live dispatch webhook', detail: 'An outbound webhook has no equivalent — this behaviour will not come across.' },
    { verdict: 'needs-review', component: 'Environment not accessible', detail: 'Field ops did not respond during the scan, so these numbers may be stale.' },
  ] },
};

/** The fixture agents whose sources carry permissions that cannot come across. */
const ACL_INVERTS = new Set([FIX_AGENTS[0]?.botId, FIX_AGENTS[3]?.botId].filter(Boolean) as string[]);

function reviewRow(botId: string): ReviewRow {
  const agent = FIX_AGENTS.find((a) => a.botId === botId);
  const rec = REVIEWS[botId] ?? { effort: 'low' as const, findings: [] };
  const counts: Record<Verdict, number> = { clean: 0, 'needs-review': 0, lost: 0 };
  for (const f of rec.findings) counts[f.verdict] += 1;
  return {
    botId,
    name: agent?.name ?? botId,
    env: agent?.env ?? '',
    effort: rec.effort,
    counts,
    findings: rec.findings,
    // Only agents with a RESTRICTED source invert a permission. The knowledge-
    // bearing agents that do not (a public site, say) must exist in the fixture
    // too, or the narrow predicate never gets tested against a false case.
    permissionLoss: ACL_INVERTS.has(botId)
      ? {
        inverts: true,
        orgWide: false,
        items: [
          { source: 'HR Policies (SharePoint)', readableBy: 'anyone who can use this agent',
            detail: 'was restricted to the HR site members' },
          { source: 'Benefits FAQ (SharePoint)', readableBy: 'anyone who can use this agent' },
        ],
        summary: 'Two restricted SharePoint sources become readable by anyone who can use this agent.',
      }
      : { inverts: false, orgWide: false, items: [], summary: '' },
  };
}

/** Mutable fixture state, so walking the flow actually changes what later phases see. */
let userMap: Record<string, string> = Object.fromEntries(
  USERS.filter((u) => u.mapped).map((u) => [u.sourceId, u.mapped as string]),
);

let pairs: EnvPair[] = [
  { env: ENVS[0].url, project: 'contoso-gemini', engine: 'contoso-assistant_1730' },
  { env: ENVS[1].url, project: 'contoso-gemini', engine: 'contoso-hr_4471' },
  { env: ENVS[2].url },
  { env: ENVS[3].url },
];

/** What the last run produced, so the report shows that run and not a fiction. */
let lastRun: ReportRow[] = [];

const connect: ConnectSource = {
  read: async () => wait({
    source: { platform: 'microsoft' as const, connected: true, account: 'hari.r@contoso.com',
      detail: 'Tenant contoso.onmicrosoft.com — app-only access to Dataverse' },
    destination: { platform: 'google' as const, connected: true, account: 'hari.r@contoso-gws.com',
      detail: 'Service account has Discovery Engine access to contoso-gemini' },
    found: { environments: 4, agents: 9, topics: 164 },
  }),
  disconnect: async (_session, platform) => { await wait(null); return { sessionEnded: platform === 'microsoft' }; },
};

const pair: PairSource = {
  environments: async () => wait(ENVS),
  destinations: async () => wait(DESTS),
  read: async () => wait(pairs),
  save: async (_s, next) => { pairs = next; await wait(null); },
};

const users: UsersSource = {
  mappedCount: async () => wait(Object.keys(userMap).length),
  // The fixture has no slow half to skip, so the fast pass IS the full pass —
  // minus the `referenced` flags, which is exactly what the real one omits.
  directory: async () => wait(USERS.map((u) => {
    const mapped = userMap[u.sourceId];
    return mapped
      ? { ...u, referenced: false, mapped, state: 'mapped' as const }
      : { ...u, referenced: false, mapped: undefined,
          state: u.suggested ? ('suggested' as const) : ('unmapped' as const) };
  })),
  list: async () => wait(USERS.map((u, i) => {
    const mapped = userMap[u.sourceId];
    // The first four are named by the fixture's agents; the last two are
    // directory-only, so the screen shows both lists it has to handle.
    const referenced = i < 4;
    return mapped
      ? { ...u, referenced, mapped, state: 'mapped' as const }
      : { ...u, referenced, mapped: undefined, state: u.suggested ? ('suggested' as const) : ('unmapped' as const) };
  })),
  candidates: async (_s, q, all) => {
    const hit = CANDIDATES.filter((c) => !q
      || c.email.includes(q.toLowerCase())
      || (c.name ?? '').toLowerCase().includes(q.toLowerCase()));
    // Two extra accounts exist that the filter hides: that is what "show all"
    // reveals, and why the counts have to be on screen.
    const hidden = [
      { email: 'former.dev@contoso-gws.com', name: 'Former Developer (suspended)' },
      { email: 'contractor@contoso-gws.com', name: 'Contractor (no Gemini seat)' },
    ];
    return wait({
      users: all ? [...hit, ...hidden] : hit,
      truncated: false,
      filter: {
        returned: all ? hit.length + hidden.length : hit.length,
        excludedInactive: all ? 0 : 1,
        excludedUnlicensed: all ? 0 : 1,
        excludedGuest: 0,
        // Excluded even with `all`: there is no address to map this account BY, so
        // showing it would offer a target that cannot receive anything.
        excludedNoAddress: 1,
        licenceCheck: 'applied' as const,
      },
    });
  },
  save: async (_s, map) => { userMap = { ...userMap, ...map }; await wait(null); },
};

const agents: AgentsSource = {
  list: async (_s, envs) => wait(
    envs.length ? FIX_AGENTS.filter((a) => envs.includes(a.env)) : FIX_AGENTS,
  ),
  saveSelection: async (session, selection) => {
    // Key off the REAL session id, not a hardcoded one: the downstream screens read
    // `csge_data_<session>`, so hardcoding "fixture" here meant a selection saved
    // under any other session id was written where nothing would ever read it.
    sessionStorage.setItem(`csge_data_${session}`, JSON.stringify(selection));
    await wait(null);
  },
};

const review: ReviewSource = {
  assess: async (_s, agent) => wait(reviewRow(agent.botId)),
};

const migrate: MigrateSource = {
  // The fixture has no server holding a run, so there is never one to attach to
  // or stop. Saying so is truer than pretending.
  runState: async () => wait<RunState>({ phase: null }),
  stop: async () => { await wait(null); },
  start: async () => { await wait(null); },
  subscribe: (_session, onUpdate) => {
    // A scripted run, but every line is emitted as it "happens" and the report is
    // built from what was emitted — the fixture never reports work it did not show.
    const picked = FIX_AGENTS.slice(0, 6);
    const timers: number[] = [];
    let t = 300;
    const at = (fn: () => void, gap: number): void => {
      t += gap;
      timers.push(window.setTimeout(fn, t));
    };
    lastRun = [];

    at(() => onUpdate({ line: { level: 'info', msg: 'Phase 1 — reading agents from Dataverse' }, pct: 4 }), 0);
    picked.forEach((a, i) => {
      at(() => onUpdate({
        agent: { name: a.name, state: 'running' },
        line: { level: 'info', msg: `Extracting ${a.name} (${a.topics} topics)` },
        pct: 8 + i * 6,
      }), 550);
    });
    at(() => onUpdate({ line: { level: 'ok', msg: 'Phase 1 complete — 6 agents staged' }, pct: 48 }), 500);

    picked.forEach((a, i) => {
      const review = reviewRow(a.botId);
      const failed = review.counts.lost > 1;
      at(() => {
        lastRun.push({
          name: a.name, env: a.env, ok: !failed, verified: !failed,
          counts: review.counts, findings: review.findings,
        });
        // The step stream, as the server now emits it: extract, then verify, with
        // the three outcomes represented so their colours are actually seen.
        onUpdate({ step: { phase: 'start', tool: 'extract', target: `agent:${a.botId}`,
          msg: `Reading ${a.name} from Copilot Studio` } });
        onUpdate({ step: { phase: 'end', tool: 'extract', target: `agent:${a.botId}`,
          ok: true, outcome: 'ok',
          msg: `Extracted ${a.name} · ${a.topics} topic(s), ${a.knowledge} knowledge source(s)` } });
        // Inconclusive verification: proved nothing either way, so amber.
        if (i === 2) {
          onUpdate({ step: { phase: 'end', tool: 'verify', target: `agent:${a.botId}`,
            ok: false, outcome: 'unknown',
            msg: `Verification inconclusive for ${a.name} — nothing was proven either way` } });
        }

        // The one case worth rendering: frames present, but they belong to ANOTHER
        // agent. That is a failure, not a tick, and the fixture must be able to
        // show it or the copy for it never gets read.
        const swapped = i === 1;
        // Same agent as the inconclusive verify above. Its row must say
        // "created · unverified", not "verified", or the ledger and the row
        // contradict each other on screen.
        const inconclusive = i === 2;
        onUpdate({
          agent: {
            name: a.name,
            sourceId: a.botId,
            state: swapped || failed ? 'failed' : inconclusive ? 'created' : 'verified',
            note: swapped
              ? 'Answered using another agent’s tools — not this agent'
              : failed ? 'Created, but behaviour was lost'
                : inconclusive ? 'Created — verification proved nothing either way'
                  : 'Created, published and verified',
            evidence: swapped
              ? { verdict: 'wrong_agent_tools', expected: ['jira_search'],
                  observed: ['confluence_search'], unexpected: ['confluence_search'],
                  missing: ['jira_search'], returnedData: true }
              : inconclusive
                ? { verdict: 'not_probed', expected: ['jira_search'], observed: [],
                    unexpected: [], missing: ['jira_search'], returnedData: false }
                : { verdict: 'tools_confirmed', expected: ['jira_search'],
                    observed: ['jira_search'], unexpected: [], missing: [], returnedData: true },
          },
          // The log has to agree with the row. A line saying "verified" beside a row
          // saying "failed" is the exact contradiction this screen exists to avoid.
          line: swapped
            ? { level: 'fail', msg: `${a.name} created, but it answered with another agent's tools` }
            : inconclusive
              ? { level: 'warn', msg: `${a.name} created — verification was inconclusive` }
              : failed
              ? { level: 'warn', msg: `${a.name} migrated with losses — see the report` }
              : { level: 'ok', msg: `${a.name} created in Gemini and verified` },
          pct: 52 + i * 8,
        });
      }, 600);
    });

    at(() => onUpdate({ pct: 100, finished: { summary: '6 agents migrated, 2 need review' } }), 500);

    return () => timers.forEach((id) => window.clearTimeout(id));
  },
};

const report: ReportSource = {
  list: async () => wait(lastRun),
  // Two past runs so the screen has to handle the case it will meet in production:
  // a run where verified + failed does NOT equal the agent count, because some
  // agents are still owed a check.
  history: async () => wait([
    { runId: 'run-fixture-2', startedAt: '2026-08-21T09:14:00.000Z',
      finishedAt: '2026-08-21T09:31:00.000Z', status: 'completed',
      summary: '6 agents migrated, 2 need review', agents: 6, verified: 5, failed: 1 },
    { runId: 'run-fixture-1', startedAt: '2026-08-19T16:02:00.000Z',
      finishedAt: '2026-08-19T16:20:00.000Z', status: 'completed',
      summary: 'Dry run — nothing written', agents: 6, verified: 0, failed: 0 },
  ]),
};

/**
 * The fixture, assembled. Namespaces are declared above as plain objects so this
 * one object literal is the only place that has to satisfy V2Source — a missing
 * phase is then a compile error, not a runtime surprise.
 */
export const fixtureSource: V2Source = {
  isFixture: true,
  connect,
  pair,
  users,
  agents,
  review,
  connectors,
  migrate,
  report,
};
