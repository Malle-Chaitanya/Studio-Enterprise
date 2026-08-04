import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchAgents, fetchAssessment, fetchEnvironments } from '../api.ts';
import { avatarColor, Chevron } from '../icons.tsx';
import type { AgentAssessment, AgentBrief, EnvironmentInfo } from '../types.ts';

const AGENTS_PAGE = 8;
const FLOWS_PAGE = 6;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || '?').toUpperCase();
}

function getTopics(assessment: AgentAssessment): AgentAssessment['components'] {
  const topicItems = assessment.components.filter(
    (c) =>
      c.kind.toLowerCase().includes('topic') ||
      c.kind.toLowerCase().includes('dialog'),
  );
  return topicItems.length > 0 ? topicItems : assessment.components;
}

/**
 * Step 3 — Select Data. Two tabs:
 * - Agents: selectable rows with search, select all/deselect all, pagination (8/page).
 * - Flows: expandable agent rows showing conversation topics; topics selectable with
 *   checkboxes; topics fetched lazily on expand via fetchAssessment.
 *
 * Both selections are saved to sessionStorage on Continue.
 */
export function SelectData() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  // ── Shared data ──────────────────────────────────────────────
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [agentsByEnv, setAgentsByEnv] = useState<Record<string, AgentBrief[]>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  // ── Tab ──────────────────────────────────────────────────────
  const [tab, setTab] = useState<'agents' | 'flows'>('agents');

  // ── Agents tab ───────────────────────────────────────────────
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  // envUrl -> current page (1-indexed)
  const [agentPage, setAgentPage] = useState<Record<string, number>>({});

  // ── Flows tab ────────────────────────────────────────────────
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [agentAssessments, setAgentAssessments] = useState<
    Record<string, { loading: boolean; assessment: AgentAssessment | null }>
  >({});
  // Key = agent botId, Value = Set of selected component names
  const [flowSelected, setFlowSelected] = useState<Record<string, Set<string>>>({});
  // envUrl -> current page (1-indexed)
  const [flowPage, setFlowPage] = useState<Record<string, number>>({});

  // ── Load environments + agents ───────────────────────────────
  useEffect(() => {
    if (!session) return;
    (async () => {
      let chosen: { env: string; name: string }[] = [];
      try {
        chosen = JSON.parse(sessionStorage.getItem(`csge_envs_${session}`) || '[]');
      } catch { /* none */ }

      let acc: EnvironmentInfo[];
      if (chosen.length) {
        const all = await fetchEnvironments(session).catch(() => []);
        const byUrl = new Map(all.map((e) => [e.url, e]));
        acc = chosen.map(
          (c) =>
            byUrl.get(c.env) ??
            ({
              url: c.env,
              name: c.name,
              accessible: true,
              bots: 0,
              knowledgeSources: 0,
              flows: 0,
            } as EnvironmentInfo),
        );
      } else {
        acc = (await fetchEnvironments(session).catch(() => [])).filter((e) => e.accessible);
      }

      setEnvs(acc);

      const map: Record<string, AgentBrief[]> = {};
      const sel: Record<string, Set<string>> = {};
      for (const e of acc) {
        const ags = await fetchAgents(session, e.url).catch(() => []);
        map[e.url] = ags;
        sel[e.url] = new Set(ags.map((a) => a.botid));
      }
      setAgentsByEnv(map);
      setSelected(sel);
      setLoading(false);
    })();
  }, [session]);

  // Reset agent pages to 1 when search query changes
  useEffect(() => {
    setAgentPage({});
  }, [query]);

  // ── Agents tab helpers ───────────────────────────────────────
  const toggle = (env: string, botId: string) =>
    setSelected((prev) => {
      const s = new Set(prev[env]);
      s.has(botId) ? s.delete(botId) : s.add(botId);
      return { ...prev, [env]: s };
    });

  const selectAll = (env: string) =>
    setSelected((prev) => ({
      ...prev,
      [env]: new Set((agentsByEnv[env] ?? []).map((a) => a.botid)),
    }));

  const deselectAll = (env: string) =>
    setSelected((prev) => ({ ...prev, [env]: new Set() }));

  const totalAgentsSelected = useMemo(
    () => Object.values(selected).reduce((n, s) => n + s.size, 0),
    [selected],
  );

  // ── Flows tab helpers ────────────────────────────────────────
  const toggleAgentExpand = async (agent: AgentBrief, envUrl: string) => {
    const key = agent.botid;
    const isOpen = expandedAgents.has(key);

    setExpandedAgents((prev) => {
      const next = new Set(prev);
      isOpen ? next.delete(key) : next.add(key);
      return next;
    });

    if (!isOpen && !agentAssessments[key]) {
      setAgentAssessments((prev) => ({
        ...prev,
        [key]: { loading: true, assessment: null },
      }));
      const assessment = await fetchAssessment(session, envUrl, agent).catch(() => null);
      setAgentAssessments((prev) => ({
        ...prev,
        [key]: { loading: false, assessment },
      }));
      if (assessment) {
        const topics = getTopics(assessment);
        if (topics.length > 0) {
          setFlowSelected((prev) => ({
            ...prev,
            [key]: new Set(topics.map((t) => t.component)),
          }));
        }
      }
    }
  };

  const toggleTopic = (agentId: string, topicName: string) => {
    setFlowSelected((prev) => {
      const s = new Set(prev[agentId] ?? []);
      s.has(topicName) ? s.delete(topicName) : s.add(topicName);
      return { ...prev, [agentId]: s };
    });
  };

  const totalFlowsSelected = useMemo(
    () => Object.values(flowSelected).reduce((n, s) => n + s.size, 0),
    [flowSelected],
  );

  const match = (name: string) => name.toLowerCase().includes(query.toLowerCase().trim());

  // ── Continue ─────────────────────────────────────────────────
  const cont = () => {
    // Agents payload (existing format)
    const agentPayload = envs
      .map((e) => ({ env: e.url, name: e.name, botIds: [...(selected[e.url] ?? [])] }))
      .filter((u) => u.botIds.length);
    sessionStorage.setItem(`csge_data_${session}`, JSON.stringify(agentPayload));

    // Flows payload
    const flowPayload: { agentId: string; agentName: string; envUrl: string; topicNames: string[] }[] = [];
    for (const e of envs) {
      for (const agent of agentsByEnv[e.url] ?? []) {
        const topics = flowSelected[agent.botid];
        if (topics && topics.size > 0) {
          flowPayload.push({
            agentId: agent.botid,
            agentName: agent.name,
            envUrl: e.url,
            topicNames: [...topics],
          });
        }
      }
    }
    sessionStorage.setItem(`csge_flows_${session}`, JSON.stringify(flowPayload));

    navigate(`/migrate?session=${session}`);
  };

  const totalSelected = totalAgentsSelected + totalFlowsSelected;

  // ── Pagination helpers ───────────────────────────────────────
  const getAgentPageNum = (envUrl: string) => agentPage[envUrl] ?? 1;
  const getFlowPageNum = (envUrl: string) => flowPage[envUrl] ?? 1;

  const setAgentPageNum = (envUrl: string, page: number) =>
    setAgentPage((prev) => ({ ...prev, [envUrl]: page }));
  const setFlowPageNum = (envUrl: string, page: number) =>
    setFlowPage((prev) => ({ ...prev, [envUrl]: page }));

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="card wide">
      <h2>Select Data</h2>
      <p className="lead">
        Choose agents and conversation flows to migrate. All agents are selected by default.
      </p>

      {/* Tab bar */}
      <div className="sd-tabs">
        <button
          className={`sd-tab ${tab === 'agents' ? 'on' : ''}`}
          onClick={() => setTab('agents')}
        >
          Agents
        </button>
        <button
          className={`sd-tab ${tab === 'flows' ? 'on' : ''}`}
          onClick={() => setTab('flows')}
        >
          Flows
        </button>
      </div>

      {loading && <p className="lead" style={{ marginTop: 16 }}>Loading agents…</p>}

      {/* ── AGENTS TAB ── */}
      {!loading && tab === 'agents' && (
        <>
          <div className="usearch-wrap" style={{ marginTop: 16 }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#9aa0a6"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="usearch"
              placeholder="Search agents…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {envs.map((e) => {
            const allAgents = agentsByEnv[e.url] ?? [];
            const filtered = allAgents.filter((a) => match(a.name));
            const sel = selected[e.url] ?? new Set<string>();
            const totalEnvAgents = allAgents.length;

            const currentPage = getAgentPageNum(e.url);
            const totalPages = Math.ceil(filtered.length / AGENTS_PAGE) || 1;
            const pageAgents = filtered.slice(
              (currentPage - 1) * AGENTS_PAGE,
              currentPage * AGENTS_PAGE,
            );

            return (
              <div key={e.url} style={{ marginBottom: 24 }}>
                <div className="dlist-head">
                  <span className="signed">
                    <span className="dot" />
                    {e.name} · {sel.size} of {totalEnvAgents} agents
                  </span>
                  <span style={{ display: 'flex', gap: 16 }}>
                    <button className="dlink" onClick={() => selectAll(e.url)}>
                      Select All
                    </button>
                    <button className="dlink" onClick={() => deselectAll(e.url)}>
                      Deselect All
                    </button>
                  </span>
                </div>

                {/* Loading skeleton while agents load */}
                {!(e.url in agentsByEnv) && (
                  <div className="sd-loading-row">Loading agents…</div>
                )}

                {/* Empty state */}
                {e.url in agentsByEnv && filtered.length === 0 && (
                  <p style={{ color: 'var(--muted)', fontSize: 14, padding: '8px 0' }}>
                    No agents found in this environment.
                  </p>
                )}

                {pageAgents.map((a) => {
                  const on = sel.has(a.botid);
                  return (
                    <label key={a.botid} className={`urow ${on ? 'on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(e.url, a.botid)}
                      />
                      <span
                        className="uavatar"
                        style={{ background: avatarColor(a.name) }}
                      >
                        {initials(a.name)}
                      </span>
                      <span className="uinfo">
                        <span className="uname">{a.name}</span>
                        <span className="usub">{e.name}</span>
                      </span>
                      {on && <span className="ucheck">✓</span>}
                    </label>
                  );
                })}

                {/* Pagination */}
                {filtered.length > AGENTS_PAGE && (
                  <div className="sd-pagination">
                    <button
                      className="sd-page-btn"
                      disabled={currentPage <= 1}
                      onClick={() => setAgentPageNum(e.url, currentPage - 1)}
                    >
                      ← Previous
                    </button>
                    <span className="sd-page-info">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      className="sd-page-btn"
                      disabled={currentPage >= totalPages}
                      onClick={() => setAgentPageNum(e.url, currentPage + 1)}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* ── FLOWS TAB ── */}
      {!loading && tab === 'flows' && (
        <div style={{ marginTop: 16 }}>
          <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 16 }}>
            Expand an agent to see and select its conversation topics/flows.
          </p>

          {envs.map((e) => {
            const allAgents = agentsByEnv[e.url] ?? [];
            const currentPage = getFlowPageNum(e.url);
            const totalPages = Math.ceil(allAgents.length / FLOWS_PAGE) || 1;
            const pageAgents = allAgents.slice(
              (currentPage - 1) * FLOWS_PAGE,
              currentPage * FLOWS_PAGE,
            );

            return (
              <div key={e.url} style={{ marginBottom: 28 }}>
                <div className="dlist-head">
                  <span className="signed">
                    <span className="dot" />
                    {e.name} · {allAgents.length} agent{allAgents.length === 1 ? '' : 's'}
                  </span>
                </div>

                {allAgents.length === 0 && (
                  <p style={{ color: 'var(--muted)', fontSize: 14, padding: '8px 0' }}>
                    No agents found in this environment.
                  </p>
                )}

                {pageAgents.map((agent) => {
                  const isOpen = expandedAgents.has(agent.botid);
                  const assessState = agentAssessments[agent.botid];
                  const topics = assessState?.assessment
                    ? getTopics(assessState.assessment)
                    : [];
                  const selectedTopics = flowSelected[agent.botid] ?? new Set<string>();

                  return (
                    <div
                      key={agent.botid}
                      className={`flow-agent-row${isOpen ? ' exp' : ''}`}
                    >
                      {/* Agent header — clickable to expand */}
                      <div
                        className="flow-agent-head"
                        role="button"
                        tabIndex={0}
                        onClick={() => { void toggleAgentExpand(agent, e.url); }}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            void toggleAgentExpand(agent, e.url);
                          }
                        }}
                      >
                        <Chevron open={isOpen} s={14} />
                        <span
                          className="uavatar"
                          style={{
                            background: avatarColor(agent.name),
                            width: 32,
                            height: 32,
                            fontSize: 11,
                            flexShrink: 0,
                          }}
                        >
                          {initials(agent.name)}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="uname">{agent.name}</span>
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
                          {assessState?.loading
                            ? 'Loading…'
                            : assessState?.assessment
                              ? `${topics.length} flow${topics.length === 1 ? '' : 's'}`
                              : isOpen
                                ? 'Loading…'
                                : ''}
                        </span>
                      </div>

                      {/* Expanded: show topics */}
                      {isOpen && (
                        <div style={{ paddingLeft: 44, paddingBottom: 8 }}>
                          {assessState?.loading && (
                            <div className="sd-loading-row">Loading flows…</div>
                          )}

                          {!assessState?.loading && assessState?.assessment && topics.length === 0 && (
                            <p style={{ color: 'var(--muted)', fontSize: 13, padding: '6px 0' }}>
                              No conversation flows found for this agent.
                            </p>
                          )}

                          {!assessState?.loading &&
                            topics.map((topic) => {
                              const on = selectedTopics.has(topic.component);
                              return (
                                <label
                                  key={topic.component}
                                  className={`flow-topic-row${on ? ' on' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() => toggleTopic(agent.botid, topic.component)}
                                    style={{ accentColor: 'var(--brand)', flexShrink: 0 }}
                                  />
                                  <span style={{ flex: 1, minWidth: 0 }}>
                                    <span
                                      style={{
                                        fontWeight: 600,
                                        color: 'var(--ink)',
                                        fontSize: 13,
                                        display: 'block',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                      }}
                                    >
                                      {topic.component}
                                    </span>
                                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                                      {topic.kind}
                                    </span>
                                  </span>
                                  {on && (
                                    <span style={{ color: 'var(--brand)', fontWeight: 700, fontSize: 14 }}>
                                      ✓
                                    </span>
                                  )}
                                </label>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Flows tab pagination */}
                {allAgents.length > FLOWS_PAGE && (
                  <div className="sd-pagination">
                    <button
                      className="sd-page-btn"
                      disabled={currentPage <= 1}
                      onClick={() => setFlowPageNum(e.url, currentPage - 1)}
                    >
                      ← Previous
                    </button>
                    <span className="sd-page-info">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      className="sd-page-btn"
                      disabled={currentPage >= totalPages}
                      onClick={() => setFlowPageNum(e.url, currentPage + 1)}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Continue button */}
      <button
        className="btn primary"
        style={{ marginTop: 16 }}
        disabled={totalSelected === 0}
        onClick={cont}
      >
        {tab === 'agents'
          ? `Continue with ${totalAgentsSelected} agent${totalAgentsSelected === 1 ? '' : 's'} →`
          : tab === 'flows'
            ? `Continue with ${totalFlowsSelected} flow${totalFlowsSelected === 1 ? '' : 's'} →`
            : `Continue with ${totalSelected} selected →`}
      </button>
      <button
        className="wbtn"
        style={{ marginTop: 12 }}
        onClick={() => navigate(`/map?session=${session}`)}
      >
        ← Back
      </button>

    </div>
  );
}
