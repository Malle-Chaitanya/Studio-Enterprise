import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { connectViaPopup, disconnectPlatform, fetchAgents, fetchEnvironments, fetchSession, googleStartUrl, microsoftStartUrl } from '../api.ts';
import { avatarColor, Chevron, GeminiIcon, IcoTrash, MsIcon } from '../icons.tsx';
import type { AgentBrief, EnvironmentInfo, SessionSummary } from '../types.ts';

/** A connect/summary card in the "All Platforms" tab. */
function PlatformCard({
  role,
  name,
  icon,
  connected,
  detail,
  tint,
  disabled,
  onConnect,
}: {
  role: string;
  name: string;
  icon: React.ReactNode;
  connected: boolean;
  detail?: string;
  tint: 'blue' | 'green';
  disabled?: boolean;
  onConnect: () => void;
}) {
  return (
    <div className={`pcard ${tint} ${connected ? 'on' : ''}`}>
      <div className="pcard-icon">{icon}</div>
      <div className="pcard-role">{role}</div>
      <div className="pcard-name">{name}</div>
      <div className="pcard-status">
        {connected ? `✓ ${detail || '1 account connected'}` : '0 accounts connected'}
      </div>
      <button
        className="pcard-btn"
        onClick={onConnect}
        disabled={disabled}
        style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      >
        {connected ? '+ Add Another' : 'Connect'}
      </button>
    </div>
  );
}

export function Home() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const [tab, setTab] = useState<'all' | 'manage'>('all');
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  // Manage-tab drill-down: environments (the CS_GE analog of "users in domain")
  // and, per environment, its agents — both lazy-fetched on expand.
  const [expandedRow, setExpandedRow] = useState<'source' | 'target' | null>(null);
  const [envs, setEnvs] = useState<EnvironmentInfo[] | null>(null);
  const [envsLoading, setEnvsLoading] = useState(false);
  const [expandedEnv, setExpandedEnv] = useState<string | null>(null);
  const [agentsByEnv, setAgentsByEnv] = useState<Record<string, { loading: boolean; agents: AgentBrief[] }>>({});

  useEffect(() => {
    if (session) fetchSession(session).then(setSummary).catch(() => setSummary(null));
  }, [session]);

  const srcConnected = !!summary?.connected.microsoft;
  const tgtConnected = !!summary?.connected.google;

  const [connecting, setConnecting] = useState<null | 'microsoft' | 'google'>(null);

  // Connect via POPUP (GEM_CO-style) — the app never navigates away; on success
  // we refresh the session in place. MS connect mints (or resumes) the session,
  // so we adopt the id it posts back.
  const startMs = async () => {
    setConnecting('microsoft');
    const r = await connectViaPopup(microsoftStartUrl(), 'ms-auth-success', 'ms-auth-error');
    setConnecting(null);
    if (r.ok && r.session) {
      navigate(`/home?session=${r.session}`);
      setSummary(await fetchSession(r.session).catch(() => null));
    }
  };
  const startGoogle = async () => {
    if (!session) return;
    setConnecting('google');
    const r = await connectViaPopup(googleStartUrl(session), 'google-auth-success', 'google-auth-error');
    setConnecting(null);
    if (r.ok) setSummary(await fetchSession(r.session ?? session).catch(() => null));
  };

  const disconnect = async (platform: 'microsoft' | 'google') => {
    const label = platform === 'microsoft' ? 'Copilot Studio (source)' : 'Gemini Enterprise (target)';
    const extra = platform === 'microsoft'
      ? '\n\nThis is the source connection — removing it ends the session and you will reconnect from scratch.'
      : '';
    if (!window.confirm(`Disconnect ${label}?${extra}`)) return;
    const res = await disconnectPlatform(session, platform).catch(() => null);
    if (!res) return;
    if (res.sessionEnded) {
      navigate('/home'); // source gone → back to a fresh connect screen
      return;
    }
    setExpandedRow(null);
    const s = await fetchSession(session).catch(() => null);
    setSummary(s);
  };

  const toggleSource = async () => {
    const opening = expandedRow !== 'source';
    setExpandedRow(opening ? 'source' : null);
    if (opening && !envs) {
      setEnvsLoading(true);
      const list = await fetchEnvironments(session).catch(() => []);
      setEnvs(list);
      setEnvsLoading(false);
    }
  };

  const toggleEnv = async (env: EnvironmentInfo) => {
    const opening = expandedEnv !== env.url;
    setExpandedEnv(opening ? env.url : null);
    if (opening && !agentsByEnv[env.url]) {
      setAgentsByEnv((m) => ({ ...m, [env.url]: { loading: true, agents: [] } }));
      const agents = await fetchAgents(session, env.url).catch(() => []);
      setAgentsByEnv((m) => ({ ...m, [env.url]: { loading: false, agents } }));
    }
  };

  // Show the connected account's email (like Gemini Enterprise), not the org/agent count.
  const srcDetail = srcConnected ? summary?.msEmail || summary?.orgName : undefined;
  const tgtDetail = tgtConnected ? summary?.gEmail : undefined;

  return (
    <div className="card wide">
      <h2>Connect Platforms</h2>
      <p className="lead">
        Connect the source and destination with admin credentials. Connect once — stored encrypted
        and reused across migrations.
      </p>

      {/* Tabs */}
      <div className="ptabs">
        <div className={`ptab ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>
          All Platforms
        </div>
        <div className={`ptab ${tab === 'manage' ? 'on' : ''}`} onClick={() => setTab('manage')}>
          Manage Platforms {(srcConnected || tgtConnected) && <span style={{ color: '#16a34a' }}>✓</span>}
        </div>
      </div>

      {tab === 'all' && (
        <>
          <p className="lead" style={{ marginBottom: 18 }}>
            Click a platform to add and connect an account. You can add multiple accounts per platform.
          </p>
          <div className="platform-cards">
            <PlatformCard
              role="Source"
              name="Copilot Studio"
              icon={<MsIcon s={44} />}
              connected={srcConnected}
              detail={srcDetail}
              tint="blue"
              disabled={connecting !== null}
              onConnect={startMs}
            />
            <PlatformCard
              role="Target"
              name="Gemini Enterprise"
              icon={<GeminiIcon s={44} />}
              connected={tgtConnected}
              detail={tgtDetail}
              tint="green"
              disabled={!srcConnected || connecting !== null}
              onConnect={startGoogle}
            />
          </div>
          {srcConnected && !tgtConnected && (
            <p className="lead" style={{ marginTop: 14 }}>
              Source connected. Connect <strong>Gemini Enterprise</strong> to enable live migration,
              or{' '}
              <button className="dlink" style={{ padding: 0 }} onClick={() => navigate(`/explore?session=${session}`)}>
                explore &amp; assess now
              </button>{' '}
              (no target needed for a dry run).
            </p>
          )}
        </>
      )}

      {tab === 'manage' && (
        <>
          <p className="lead" style={{ marginBottom: 16 }}>Manage your connected platform accounts.</p>
          {!srcConnected && !tgtConnected ? (
            <div className="infobox">No platforms connected yet. Use the <strong>All Platforms</strong> tab to connect.</div>
          ) : (
            <div className="mtable">
              <div className="mrow mhead">
                <div>Platform</div>
                <div>Account</div>
                <div>Status</div>
                <div style={{ textAlign: 'center' }}>Action</div>
              </div>

              {/* Source — Copilot Studio (expand → environments → agents) */}
              {srcConnected && (
                <div className="mgroup">
                  <div className={`mrow ${expandedRow === 'source' ? 'exp' : ''}`}>
                    <div className="mcloud">
                      <button className="mchev" onClick={toggleSource} title="Show environments">
                        <Chevron open={expandedRow === 'source'} />
                      </button>
                      <MsIcon s={26} />
                      <span>Copilot Studio</span>
                    </div>
                    <div className="macct">
                      <span>{summary?.orgName ?? summary?.tenantId ?? 'Microsoft tenant'}</span>
                      {(summary?.botCount ?? 0) > 0 && <span className="mbadge">{summary?.botCount} agents</span>}
                    </div>
                    <div className="mstatus">Admin</div>
                    <div style={{ textAlign: 'center' }}>
                      <button className="mdelete" onClick={() => disconnect('microsoft')} title="Disconnect Copilot Studio">
                        <IcoTrash />
                      </button>
                    </div>
                  </div>

                  {expandedRow === 'source' && (
                    <div className="mexpand">
                      {envsLoading && <div className="muted-row">Discovering environments…</div>}
                      {envs && envs.length === 0 && <div className="muted-row">No environments found.</div>}
                      {envs && envs.length > 0 && (
                        <>
                          <div className="mexpand-title">Environments — {envs.length} total</div>
                          <div className="mlist">
                            {envs.map((e) => (
                              <div key={e.url} className="menv">
                                <div
                                  className="menv-head"
                                  style={{ cursor: e.accessible ? 'pointer' : 'not-allowed', opacity: e.accessible ? 1 : 0.55 }}
                                  onClick={() => e.accessible && toggleEnv(e)}
                                >
                                  {e.accessible && <Chevron open={expandedEnv === e.url} s={12} />}
                                  <span className="menv-name">{e.name}</span>
                                  <span className={`badge ${e.accessible ? 'ok' : 'fail'}`}>
                                    {e.accessible ? `${e.bots} agents` : 'no access'}
                                  </span>
                                  {e.accessible && (
                                    <span className="menv-sub">{e.knowledgeSources} knowledge · {e.flows} flows</span>
                                  )}
                                </div>
                                {expandedEnv === e.url && (
                                  <div className="magents">
                                    {agentsByEnv[e.url]?.loading && <div className="muted-row">Loading agents…</div>}
                                    {agentsByEnv[e.url] && !agentsByEnv[e.url].loading && agentsByEnv[e.url].agents.length === 0 && (
                                      <div className="muted-row">No agents in this environment.</div>
                                    )}
                                    {agentsByEnv[e.url]?.agents.map((a) => (
                                      <div key={a.botid} className="magent">
                                        <span className="mavatar" style={{ background: avatarColor(a.name) }}>
                                          {a.name.slice(0, 2).toUpperCase()}
                                        </span>
                                        <span>{a.name}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Target — Gemini Enterprise */}
              {tgtConnected && (
                <div className="mgroup">
                  <div className={`mrow ${expandedRow === 'target' ? 'exp' : ''}`}>
                    <div className="mcloud">
                      <button
                        className="mchev"
                        onClick={() => setExpandedRow(expandedRow === 'target' ? null : 'target')}
                        title="Show details"
                      >
                        <Chevron open={expandedRow === 'target'} />
                      </button>
                      <GeminiIcon s={26} />
                      <span>Gemini Enterprise</span>
                    </div>
                    <div className="macct"><span>{summary?.gEmail}</span></div>
                    <div className="mstatus">{summary?.saOk ? 'Admin' : 'Connected'}</div>
                    <div style={{ textAlign: 'center' }}>
                      <button className="mdelete" onClick={() => disconnect('google')} title="Disconnect Gemini Enterprise">
                        <IcoTrash />
                      </button>
                    </div>
                  </div>
                  {expandedRow === 'target' && (
                    <div className="mexpand">
                      <div className="mlist">
                        <div className="muted-row">Gemini project: <span className="mono">{summary?.geminiProject || '—'}</span></div>
                        <div className="muted-row">Service account: {summary?.saOk ? '✓ verified (Domain-Wide Delegation)' : '⚠ not verified'}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!srcConnected && (
        <div className="warn-banner">
          <span className="warn-ico">⚠</span>
          Connect <strong>Copilot Studio</strong> (source) to proceed.
        </div>
      )}

      <div className="wizard-actions">
        <button className="wbtn" onClick={() => navigate('/')}>← Back</button>
        <button
          className="wbtn primary"
          disabled={!srcConnected}
          onClick={() => navigate(`/pair?session=${session}`)}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
