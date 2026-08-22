/**
 * The real source: v2 screens backed by the live backend.
 *
 * All the scan logic that used to sit in a hook lives here, so a screen holds no
 * knowledge of endpoints and the fixture can be a straight swap.
 */

import {
  fetchThirdPartyConnectors,
  fetchKnowledgeSourceConnectors,
  fetchConnectorsNeeded,
  fetchConnectorRequirements,
  fetchSavedConnectors,
  saveConnectorCredentials,
  forgetConnectorCredentials,
  type DetectedConnector,
} from '../../api.ts';
import type { ConnectorRow, ConnectorScan, ScopeEnv, V2Source } from './types.ts';
import {
  disconnectPlatform,
  discoverPrincipals,
  fetchAgents,
  fetchAssessment,
  fetchEngines,
  fetchEnvironments,
  fetchGoogleUsers,
  fetchIdentityMap,
  fetchProjects,
  fetchSession,
  migrateStreamUrl,
  planMigration,
  saveIdentityMap,
  type DiscoveredIdentityPrincipal,
} from '../../api.ts';
import type { Compatibility, MigrationScope, ProgressEvent } from '../../types.ts';
import type {
  AgentsSource, ConnectSource, MigrateSource, PairSource, ReportSource, ReviewFinding,
  ReviewSource, UserRow, UsersSource, Verdict,
} from './types.ts';


/** SharePoint/OneDrive used only as KNOWLEDGE still needs the Microsoft app. */
const KNOWLEDGE_MS_IDS: Record<string, string> = {
  'sharepoint-connector': 'shared_sharepointonline',
  'onedrive-connector': 'shared_onedrive',
};

function mergeDetected(lists: DetectedConnector[][]): DetectedConnector[] {
  const merged = new Map<string, DetectedConnector>();
  for (const list of lists) {
    for (const c of list) {
      const prev = merged.get(c.connectorId);
      merged.set(c.connectorId, prev
        ? {
            ...prev,
            flowCount: prev.flowCount + c.flowCount,
            flowNames: [...new Set([...prev.flowNames, ...c.flowNames])],
            agentNames: [...new Set([...(prev.agentNames ?? []), ...(c.agentNames ?? [])])],
          }
        : c);
    }
  }
  return [...merged.values()];
}

/** The agents the customer picked, per environment. Written by the Select data step. */
function readScope(session: string): ScopeEnv[] {
  try {
    const raw: ScopeEnv[] = JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
    return raw.filter((s) => s.botIds.length > 0);
  } catch {
    return [];
  }
}

async function scan(session: string): Promise<ConnectorScan> {
  const envs = readScope(session);

  // Each scan is independently best-effort: a Power Automate scan that fails must
  // not hide the knowledge connectors we did find.
  const [flows, knowledge, needed] = await Promise.all([
    Promise.all(envs.map((e) => fetchThirdPartyConnectors(session, e.env).catch(() => [])))
      .then(mergeDetected),
    Promise.all(envs.map((e) => fetchKnowledgeSourceConnectors(session, e.env, e.botIds).catch(() => [])))
      .then(mergeDetected),
    Promise.all(envs.map((e) => fetchConnectorsNeeded(session, e.env, e.botIds).catch(() => [])))
      .then((r) => r.flat()),
  ]);

  const detected = mergeDetected([flows, knowledge]);
  const detectedById = new Map(detected.map((d) => [d.connectorId, d]));

  // Knowledge-only SharePoint/OneDrive has no flow behind it, so it appears in no
  // scan above — but the crawler needs Graph credentials all the same.
  const knowledgeMsIds = [...new Set(
    needed.map((n) => KNOWLEDGE_MS_IDS[n.kind]).filter((id): id is string => Boolean(id)),
  )];
  const ids = [...new Set([...detectedById.keys(), ...knowledgeMsIds])];

  const [reqs, saved] = await Promise.all([
    fetchConnectorRequirements(session, ids, envs[0]?.env).catch(() => []),
    fetchSavedConnectors(session).catch(() => []),
  ]);
  const reqById = new Map(reqs.map((r) => [r.connectorId, r]));
  const savedById = new Map(saved.map((s) => [s.connectorId, s]));

  const rows: ConnectorRow[] = ids.map((id) => {
    const det = detectedById.get(id) ?? null;
    const req = reqById.get(id) ?? null;
    const sav = savedById.get(id) ?? null;
    const fields = req?.fields ?? [];
    const missingFields = fields.filter((f) => !f.supplied).map((f) => f.key);

    // Order matters. "Cannot migrate" outranks everything — asking for credentials
    // for a connector we cannot call would waste the customer's time.
    let state: ConnectorRow['state'];
    if (det?.unsupported || req?.unknown) state = 'cannot-migrate';
    else if (sav && sav.matchesDestination === false) state = 'wrong-project';
    else if (missingFields.length === 0 && (req?.configured || req?.credentialAlreadySupplied || sav)) state = 'ready';
    else state = 'needs-you';

    // Knowledge-source connectors carry agent names; flow connectors carry flow
    // names. Show whichever we truly have — never invent the other.
    const agentNames = det?.agentNames ?? (knowledgeMsIds.includes(id)
      ? [...new Set(needed.filter((n) => KNOWLEDGE_MS_IDS[n.kind] === id).flatMap((n) => n.agentNames))]
      : []);

    return {
      connectorId: id,
      name: req?.name ?? det?.def?.name ?? id.replace(/^shared_/, ''),
      agentNames,
      flowNames: det?.flowNames ?? [],
      detected: det,
      req,
      saved: sav,
      missingFields,
      state,
    };
  });

  return { rows: sortRows(rows), envs };
}

/** Everything that needs a human first: this list is a to-do list, not a catalogue. */
export function sortRows(rows: ConnectorRow[]): ConnectorRow[] {
  const rank: Record<ConnectorRow['state'], number> = {
    'needs-you': 0, 'wrong-project': 1, 'cannot-migrate': 2, ready: 3,
  };
  return [...rows].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}


// ── the rest of the phases, wired to the endpoints that already exist ────────
// Everything below calls api.ts wrappers that the current UI uses in production,
// so these are the real reads and writes, not stubs. What is NOT yet real is
// called out in a comment at the point where it is missing — never papered over
// with invented data.

const connect: ConnectSource = {
  read: async (session) => {
    const s = await fetchSession(session);
    return {
      source: {
        platform: 'microsoft',
        connected: s.connected.microsoft,
        account: s.msEmail,
        detail: s.orgName ? `${s.orgName} — app-only access to Dataverse` : undefined,
      },
      destination: {
        platform: 'google',
        connected: s.connected.google,
        account: s.gEmail,
        detail: s.geminiProject ? `Destination project ${s.geminiProject}` : undefined,
        // The service account failing is the single most common reason a run dies
        // half way, so it is surfaced on the very first screen instead of at insert.
        problem: s.saOk ? undefined : s.saReason ?? 'The service account cannot reach the destination project.',
      },
      // Counts exist only once the source has really been read.
      found: s.connected.microsoft
        ? { environments: s.environments, agents: s.botCount, topics: s.topicCount }
        : undefined,
    };
  },
  disconnect: async (session, platform) => { await disconnectPlatform(session, platform); },
};

const pair: PairSource = {
  environments: async (session) => {
    const envs = await fetchEnvironments(session);
    return envs.map((e) => ({
      url: e.url, name: e.name, accessible: e.accessible, agents: e.bots, topics: e.topics,
    }));
  },
  destinations: async (session) => {
    const { projects } = await fetchProjects(session);
    // Engines are fetched per project by the caller in the old UI; do the same
    // here, but tolerate a project we cannot list (permissions) rather than
    // failing the whole screen.
    const withEngines = await Promise.all(projects.map(async (p) => ({
      project: p.projectId,
      name: p.displayName ?? p.projectId,
      engines: await fetchEngines(session, p.projectId)
        .then((r) => r.engines.map((e) => ({ id: e.id, displayName: e.displayName })))
        .catch(() => []),
    })));
    return withEngines;
  },
  read: async (session) => {
    const raw = sessionStorage.getItem(`csge_dest_${session}`);
    if (!raw) return [];
    try {
      const map = JSON.parse(raw) as Record<string, { project: string; engine: string }>;
      return Object.entries(map).map(([env, d]) => ({ env, project: d.project, engine: d.engine }));
    } catch {
      return [];
    }
  },
  save: async (session, next) => {
    // Same two keys the current wizard writes, so a run started here is
    // indistinguishable from one started in the old UI.
    const map: Record<string, { project: string; engine: string; assistant: string }> = {};
    for (const p of next) {
      if (p.project && p.engine) map[p.env] = { project: p.project, engine: p.engine, assistant: 'default_assistant' };
    }
    sessionStorage.setItem(`csge_dest_${session}`, JSON.stringify(map));
    sessionStorage.setItem(`csge_envs_${session}`, JSON.stringify(Object.keys(map)));
  },
};

const users: UsersSource = {
  list: async (session) => {
    // Only the people the SELECTED agents actually touch — discovering every user
    // in a tenant would hand the customer a mapping table thousands of rows long,
    // nearly all of it irrelevant to this migration.
    const selection: Array<{ env: string; botIds: string[] }> =
      JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
    const [discovered, saved] = await Promise.all([
      discoverPrincipals(session, selection).catch(() => ({ principals: [] })),
      fetchIdentityMap(session).catch(() => ({ users: {} as Record<string, string> })),
    ]);
    const map = (saved as { users?: Record<string, string> }).users ?? {};
    const principals = (discovered as { principals?: DiscoveredIdentityPrincipal[] }).principals ?? [];
    return principals.map((p) => {
      const id = p.key || p.id || p.email || '';
      const mapped = map[id];
      return {
        sourceId: id,
        sourceEmail: p.email ?? id,
        sourceName: p.displayName,
        mapped,
        state: mapped ? ('mapped' as const) : ('unmapped' as const),
      } satisfies UserRow;
    });
  },
  candidates: async (session, query) => {
    const res = await fetchGoogleUsers(session, { q: query, max: 25 }).catch(() => ({ users: [] }));
    return res.users.map((u) => ({ email: u.email, name: u.displayName }));
  },
  save: async (session, map) => { await saveIdentityMap(session, map, {}); },
};

const agents: AgentsSource = {
  list: async (session, envs) => {
    const envInfo = await fetchEnvironments(session).catch(() => []);
    const nameOf = new Map(envInfo.map((e) => [e.url, e.name]));
    const wanted = envs.length ? envs : envInfo.filter((e) => e.accessible).map((e) => e.url);
    const perEnv = await Promise.all(wanted.map(async (env) => {
      const list = await fetchAgents(session, env).catch(() => []);
      return list.map((a) => ({
        botId: a.botid,
        name: a.name,
        env,
        envName: nameOf.get(env) ?? env,
        owner: a.ownerDisplayName ?? a.ownerEmail,
        // Per-agent topic/knowledge counts come from the assessment, which is a
        // separate call per agent — the list must not claim numbers it has not read.
        topics: 0,
        knowledge: 0,
      }));
    }));
    return perEnv.flat();
  },
  saveSelection: async (session, selection) => {
    sessionStorage.setItem(`csge_data_${session}`, JSON.stringify(selection));
  },
};

/** Map the server's four-level compatibility onto the three words a customer needs. */
function verdictOf(c: Compatibility): Verdict {
  if (c === 'supported') return 'clean';
  if (c === 'none') return 'lost';
  return 'needs-review'; // partial | manual — both mean "a human has to look"
}

const review: ReviewSource = {
  assess: async (session, agent) => {
    const a = await fetchAssessment(session, agent.env, { botid: agent.botId, name: agent.name });
    const findings: ReviewFinding[] = a.components.map((c) => ({
      verdict: verdictOf(c.compatibility),
      component: c.component,
      detail: c.note,
    }));
    const counts: Record<Verdict, number> = { clean: 0, 'needs-review': 0, lost: 0 };
    for (const f of findings) counts[f.verdict] += 1;
    return { botId: agent.botId, name: agent.name, env: agent.env, effort: a.effort, counts, findings };
  },
};

const migrate: MigrateSource = {
  start: async (session, opts) => {
    const scope: MigrationScope = { kind: 'selection' };
    const environmentMap = JSON.parse(sessionStorage.getItem(`csge_dest_${session}`) || '{}');
    await planMigration(session, scope, { environmentMap }, opts.dryRun);
  },
  subscribe: (session, onUpdate) => {
    // The existing SSE stream. Its ProgressEvent union has log | progress | agent |
    // done — enough to drive this screen. It has NO tool_start / awaiting_human
    // yet, which is why the agent cursor stays out of the run itself for now
    // rather than animating steps the server never reported.
    const es = new EventSource(migrateStreamUrl(session));
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ProgressEvent;
        if (ev.type === 'log') onUpdate({ line: { level: ev.level, msg: ev.msg } });
        else if (ev.type === 'progress') onUpdate({ pct: ev.pct, line: { level: 'info', msg: ev.msg } });
        else if (ev.type === 'agent') {
          const r = ev.result;
          onUpdate({
            agent: {
              name: r.name,
              state: r.created ? 'done' : 'failed',
              // verifyStatus is three-valued on purpose: "unknown" is a check still
              // owed, not a pass. Do not collapse it into a tick.
              note: r.error
                ?? (r.verifyStatus === 'verified' ? 'Created, published and verified'
                  : r.verifyStatus === 'failed' ? 'Created, but the smoke test failed'
                  : 'Created — not verified'),
            },
          });
        } else if (ev.type === 'done') onUpdate({ pct: 100, finished: { summary: ev.summary } });
      } catch {
        /* a malformed frame must not kill the stream */
      }
    };
    return () => es.close();
  },
};

const report: ReportSource = {
  // Not wired yet: the per-run results are persisted server-side, but there is no
  // read endpoint for them. The screen shows the run it just watched, and says so
  // — inventing a history here would be inventing migrations.
  list: async () => [],
};

export const apiSource: V2Source = {
  isFixture: false,
  connect,
  pair,
  users,
  agents,
  review,
  migrate,
  report,
  connectors: {
    scan,
    requirements: async (session, connectorId, env) =>
      (await fetchConnectorRequirements(session, [connectorId], env))[0] ?? null,
    save: async (session, connectorId, creds) => {
      const res = await saveConnectorCredentials(session, connectorId, creds);
      return { validation: res.validation };
    },
    forget: forgetConnectorCredentials,
  },
};
