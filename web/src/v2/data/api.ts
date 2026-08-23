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
import { markStale } from './cache.ts';
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
  fetchMsUsersPage,
  fetchRun,
  fetchRuns,
  migrateStreamUrl,
  saveSelectionToServer,
  fetchRunState,
  stopMigration,
  planMigration,
  saveIdentityMap,
  type DiscoveredIdentityPrincipal,
  type MsUserBrief,
} from '../../api.ts';
import type {
  Compatibility, FidelityNote, MigrationScope, ProgressEvent,
} from '../../types.ts';
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
  disconnect: async (session, platform) => {
    const r = await disconnectPlatform(session, platform);
    return { sessionEnded: r.sessionEnded };
  },
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
  // The persisted identity map is the same thing the orchestrator reads when it
  // resolves owners, so this count and the run log can never disagree.
  mappedCount: async (session) => Object.keys(
    (await fetchIdentityMap(session).catch(() => ({ users: {} }))).users ?? {},
  ).length,
  directory: async (session) => listUsers(session, { withPrincipals: false }),
  list: async (session) => listUsers(session, { withPrincipals: true }),
  candidates: (session, query, all) => usersCandidates.candidates(session, query, all),
  save: (session, map) => usersCandidates.save(session, map),
};

/** One implementation, two depths — so the fast pass and the full pass can never
 *  disagree about what a row means. */
async function listUsers(
  session: string,
  { withPrincipals }: { withPrincipals: boolean },
): Promise<UserRow[]> {
  {
    // The source directory, ALWAYS — this screen sits before agent selection in
    // the flow, so principals-from-agents alone rendered an empty grid and read
    // as a broken page. Directory users are the floor; referenced people are
    // flagged on top of it.
    const dir = await fetchMsUsersPage(session, { max: 300 }).catch(
      () => ({ users: [] as MsUserBrief[] }),
    );
    // Only the people the SELECTED agents actually touch — discovering every user
    // in a tenant would hand the customer a mapping table thousands of rows long,
    // nearly all of it irrelevant to this migration.
    let selection: Array<{ env: string; botIds: string[] }> =
      JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');

    // Map users sits BEFORE Select agents in the flow, so there is usually no
    // selection yet — and an empty selection is a 400 (`selection_required`),
    // which rendered as "0 people found" and looked like a tenant with nobody in
    // it. Fall back to the agents in a paired environment.
    //
    // BOUNDED, and that bound matters: principal discovery is one ACL read per
    // agent, so on a 56-agent tenant the unbounded version took minutes and made
    // this screen feel broken in a different way. Twelve agents is enough to show
    // the shape of who is involved; the exact set arrives once agents are picked,
    // which is the only time it is worth paying for.
    const FALLBACK_AGENT_CAP = 12;
    let capped = false;
    if (selection.length === 0) {
      const pairs = await pair.read(session).catch(() => []);
      const envs = pairs.filter((p) => p.project && p.engine).map((p) => p.env);
      const perEnv = await Promise.all(envs.map(async (env) => ({
        // The Dataverse ORG URL, not a display name or id: a wrong env returns an
        // empty catalogue rather than an error, which is indistinguishable from
        // "this agent references nobody".
        env,
        botIds: (await fetchAgents(session, env).catch(() => [])).map((a) => a.botid),
      })));
      const all = perEnv.filter((e) => e.botIds.length > 0);
      const total = all.reduce((n, e) => n + e.botIds.length, 0);
      capped = total > FALLBACK_AGENT_CAP;
      let budget = FALLBACK_AGENT_CAP;
      selection = all.map((e) => {
        const take = e.botIds.slice(0, Math.max(0, budget));
        budget -= take.length;
        return { env: e.env, botIds: take };
      }).filter((e) => e.botIds.length > 0);
    }

    const [discovered, saved] = await Promise.all([
      selection.length && withPrincipals
        ? discoverPrincipals(session, selection).catch(() => ({ principals: [] }))
        : Promise.resolve({ principals: [] }),
      fetchIdentityMap(session).catch(() => ({ users: {} as Record<string, string> })),
    ]);
    const map = (saved as { users?: Record<string, string> }).users ?? {};
    const principals = (discovered as { principals?: DiscoveredIdentityPrincipal[] }).principals ?? [];

    const rows = new Map<string, UserRow>();
    const put = (id: string, email: string, name: string | undefined, referenced: boolean): void => {
      if (!id) return;
      const existing = rows.get(id.toLowerCase());
      const mapped = map[id] ?? (existing?.mapped);
      rows.set(id.toLowerCase(), {
        sourceId: existing?.sourceId ?? id,
        sourceEmail: email || existing?.sourceEmail || id,
        sourceName: name ?? existing?.sourceName,
        // Once referenced, always referenced: the directory copy of the same
        // person must not overwrite the fact that an agent names them.
        referenced: referenced || existing?.referenced,
        mapped,
        state: mapped ? 'mapped' : 'unmapped',
      });
    };

    for (const u of dir.users) {
      const id = u.email || u.userPrincipalName || u.id;
      put(id, u.email || u.userPrincipalName || '', u.displayName, false);
    }
    for (const p of principals) put(p.key || p.id || p.email || '', p.email ?? '', p.displayName, true);

    if (capped) {
      // Marked on the rows themselves so the screen can say the sample is a
      // sample. Silently sampling and calling it "who your agents reference"
      // would be the same overclaiming as an empty list called a tenant.
      for (const r of rows.values()) if (r.referenced) r.sampled = true;
    }

    // Referenced people first: they are the ones whose mapping changes what the
    // migration does.
    return [...rows.values()].sort((a, b) =>
      Number(b.referenced ?? false) - Number(a.referenced ?? false)
      || a.sourceEmail.localeCompare(b.sourceEmail));
  }
}

const usersCandidates = {
  candidates: async (session: string, query: string, all?: boolean) => {
    const res = await fetchGoogleUsers(session, { q: query, max: 200, all })
      .catch(() => ({ users: [] } as Awaited<ReturnType<typeof fetchGoogleUsers>>));
    return {
      users: res.users.map((u) => ({ email: u.email, name: u.displayName })),
      truncated: res.truncated,
      filter: res.filter,
    };
  },
  save: async (session: string, map: Record<string, string>) => {
    await saveIdentityMap(session, map, {});
  },
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
        // Knowledge comes from the list response itself (one call for all agents).
        // Topics do NOT: the row count and the staged count disagree and the
        // relationship is not understood, so no topic number is claimed here.
        // 0 renders as "not read", never as "this agent has no topics".
        topics: 0,
        knowledge: a.knowledgeCount ?? 0,
      }));
    }));
    return perEnv.flat();
  },
  saveSelection: async (session, selection) => {
    // The server first: every per-agent decision on Connectors is keyed to the
    // recorded selection, and Connectors comes BEFORE the Start button that used to
    // be the only thing that told the server anything. sessionStorage alone is per
    // tab and invisible to the server.
    await saveSelectionToServer(session, selection);
    const key = `csge_data_${session}`;
    const before = sessionStorage.getItem(key) ?? '';
    const after = JSON.stringify(selection);
    sessionStorage.setItem(key, after);
    // Connectors are derived FROM the selection, so a CHANGED selection makes the
    // scan stale. Only a changed one. This used to drop the scan on every save,
    // including the save that re-writes an identical selection when the screen is
    // revisited, so walking back to Select agents and forward again erased the
    // Connectors phase from the rail — it fell back to a bare step number long
    // after the operator had finished it.
    //
    // The user list is NOT dropped either way: the people and their mappings are
    // still true, only the "referenced by your agents" flags go stale, and dropping
    // the list used to un-tick a mapping the operator had already done.
    // Compared canonically: the same agents in a different row order are the same
    // selection, and must not count as a change.
    const canon = (raw: string): string => {
      try {
        const v = JSON.parse(raw || '[]') as Array<{ env: string; botIds: string[] }>;
        return JSON.stringify(
          v.map((u) => ({ env: u.env, botIds: [...(u.botIds ?? [])].sort() }))
            .sort((a, b) => a.env.localeCompare(b.env)),
        );
      } catch {
        return raw;
      }
    };
    // Marked stale, NOT deleted. Deleting it left the rail with nothing to say
    // about a phase the operator had already finished, so Connectors fell back to a
    // bare step number every time the selection was re-saved.
    if (canon(before) !== canon(after)) markStale(session, `conn:${session}`);
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
    return {
      botId: agent.botId,
      name: agent.name,
      env: agent.env,
      effort: a.effort,
      counts,
      findings,
      // The server's own predicate for whether this agent inverts a permission.
      // Passed through untouched: re-deriving it here from knowledge counts was
      // wider than the truth, because a public source has no permissions to lose.
      permissionLoss: a.permissionLoss,
    };
  },
};

const migrate: MigrateSource = {
  runState: async (session) => {
    const { run } = await fetchRunState(session);
    return run ? { ...run } : { phase: null };
  },
  stop: (session) => stopMigration(session),
  start: async (session, opts) => {
    // The scope MUST carry the units. Sending `{ kind: 'selection' }` with no
    // units is what produced plan_failed: the server was asked to migrate a
    // selection and handed nothing to select from.
    const units: Array<{ env: string; botIds: string[] }> =
      JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
    if (units.length === 0 || units.every((u) => u.botIds.length === 0)) {
      throw new Error('no_agents_selected: go back to Select agents and choose at least one');
    }
    const environmentMap = JSON.parse(sessionStorage.getItem(`csge_dest_${session}`) || '{}');
    if (Object.keys(environmentMap).length === 0) {
      throw new Error('no_destination: no environment is pointed at a Gemini app yet');
    }
    const scope: MigrationScope = {
      kind: 'selection',
      units: units.map((u) => ({ env: u.env, botIds: u.botIds })),
    };
    await planMigration(
      session,
      scope,
      { environmentMap },
      opts.dryRun,
      opts.acknowledgeAclLoss ?? false,
    );
  },
  subscribe: (session, onUpdate) => {
    // The SSE stream. log | progress | agent | done carry the run; tool_start,
    // tool_end and awaiting_human carry what the agent is DOING, and they are the
    // only things allowed to move the cursor. The server emits them one real call
    // site at a time, so a step on screen is a step that happened.
    // Reconnecting is SAFE again, and useful: the server owns the run in a registry
    // and a reattach replays every event we missed. What is not safe is reconnecting
    // after the run has ENDED — a finished run is no longer live, so the stream
    // would start a new one from the plan still on the session. Hence: let the
    // browser retry freely while a run is going, and close the moment it is done.
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
              sourceId: r.sourceId,
              // created !== working. Only a verified probe earns 'verified'; an
              // unknown verify is reported as created, which is a check still owed.
              // A dry run creates nothing BY DESIGN, so `created: false` is the
              // expected outcome and not a failure. The server says which it is:
              // its error field carries "dry-run (not created)" for a staged agent.
              state: /^dry.run/i.test(r.error ?? '')
                ? 'staged'
                : !r.created
                  ? 'failed'
                  : r.verifyStatus === 'verified' ? 'verified' : 'created',
              // verifyStatus is three-valued on purpose: "unknown" is a check still
              // owed, not a pass. Do not collapse it into a tick.
              note: /^dry.run/i.test(r.error ?? '')
                ? 'Extracted, mapped and staged — nothing was written to Gemini'
                : r.error
                ?? (r.verifyStatus === 'verified' ? 'Created, published and verified'
                  : r.verifyStatus === 'failed' ? 'Created, but the smoke test failed'
                  : 'Created — not verified'),
              evidence: r.verifyEvidence,
            },
          });
        } else if (ev.type === 'tool_start') {
          onUpdate({ step: { phase: 'start', tool: ev.tool, target: ev.target, msg: ev.msg } });
        } else if (ev.type === 'tool_end') {
          onUpdate({ step: {
            phase: 'end', tool: ev.tool, target: ev.target, ok: ev.ok,
            outcome: ev.outcome, msg: ev.msg,
          } });
        } else if (ev.type === 'awaiting_human') {
          onUpdate({ handoff: { reason: ev.reason, target: ev.target, msg: ev.msg } });
        } else if (ev.type === 'done') {
          // Close it OURSELVES the moment the run ends. GET /api/migrate/stream is
          // not a listener, it IS the run — so when the server finishes and closes
          // the response, EventSource's automatic reconnect re-opens it and the
          // whole migration runs again. That is why a dry run looked like it "kept
          // running": it genuinely ran three times, each one a real extract against
          // the tenant. Nothing but an explicit close stops that loop.
          es.close();
          onUpdate({ pct: 100, finished: { summary: ev.summary } });
        }
      } catch {
        /* a malformed frame must not kill the stream */
      }
    };
    // A dropped stream must SAY it dropped. Silence here was read as "the run is
    // stuck": a server restart during development, or any proxy timing out, closed
    // the stream and the screen sat at 0% forever with nothing to explain it.
    es.onerror = () => {
      // A dropped stream must SAY it dropped rather than sitting silent at 0%.
      // readyState CLOSED means the browser has given up; anything else means it is
      // about to reattach, which now rejoins the same run instead of starting one.
      if (es.readyState === EventSource.CLOSED) onUpdate({ streamError: 'connection_closed' });
    };
    return () => es.close();
  },
};

/** Server fidelity notes -> the three words a customer needs. */
function verdictOfNote(status: FidelityNote['status']): Verdict {
  if (status === 'mapped') return 'clean';
  if (status === 'lost') return 'lost';
  return 'needs-review'; // partial | needs-review
}

const report: ReportSource = {
  list: async (session, runId) => {
    const id = runId ?? (await fetchRuns(session, 1).catch(() => []))[0]?.runId;
    if (!id) return []; // no run recorded for this tenant — not an error
    const { results } = await fetchRun(session, id);
    return results.map((r) => {
      const counts: Record<Verdict, number> = { clean: 0, 'needs-review': 0, lost: 0 };
      for (const f of r.fidelity) counts[verdictOfNote(f.status)] += 1;
      return {
        name: r.name,
        env: '',
        ok: r.created,
        // Only a passed probe counts. `unknown` stays absent rather than false, so
        // the screen can say "not checked" instead of implying a failed check.
        verified: r.verifyStatus === 'verified' ? true : r.verifyStatus === 'failed' ? false : undefined,
        counts,
        findings: r.fidelity.map((f) => ({
          verdict: verdictOfNote(f.status),
          component: f.component,
          detail: f.detail,
        })),
        evidence: r.verifyEvidence,
      };
    });
  },
  history: async (session) => {
    const runs = await fetchRuns(session).catch(() => []);
    return runs.map((r) => ({
      runId: r.runId,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      summary: r.summary,
      agents: r.agentCount,
      verified: r.verifiedCount,
      failed: r.failedCount,
    }));
  },
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
