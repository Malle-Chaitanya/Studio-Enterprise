import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  agentJsonUrl,
  fetchAgents,
  fetchAssessment,
  fetchEnvironments,
} from '../api.ts';
import type {
  AgentAssessment,
  AgentBrief,
  Compatibility,
  EnvironmentInfo,
  KnowledgeAction,
  KnowledgeAssessment,
  KnowledgeDisposition,
} from '../types.ts';

const COMPAT_LABEL: Record<Compatibility, string> = {
  supported: 'Auto',
  partial: 'Adapt',
  manual: 'Manual',
  none: 'None',
};

const KDISPO: Record<KnowledgeDisposition, { label: string; tag: Compatibility }> = {
  auto: { label: 'Auto migrate', tag: 'supported' },
  reconnect: { label: 'Reconnect', tag: 'partial' },
  manual: { label: 'Manual', tag: 'manual' },
};

function ksIcon(target: string): string {
  if (target === 'document-data-store') return '📄';
  if (target === 'website-data-store') return '🌐';
  if (target === 'structured-data-store') return '🗃️';
  if (target === 'sharepoint-connector') return '🔗';
  if (target === 'onedrive-connector') return '☁️';
  if (target === 'agent-tool') return '🛠';
  if (target === 'gcs-import') return '📦';
  return '⚠️';
}

/** Client-facing knowledge dry run: what migrates automatically vs. needs work. */
function KnowledgePanel({ k }: { k: KnowledgeAssessment }) {
  if (!k.total) {
    return (
      <div className="kspanel">
        <div className="kshead">
          <h3>Knowledge Sources</h3>
          <span className="chip">none attached</span>
        </div>
        <p className="lead" style={{ margin: 0 }}>This agent has no knowledge sources to migrate.</p>
      </div>
    );
  }
  return (
    <div className="kspanel">
      <div className="kshead">
        <h3>Knowledge Sources</h3>
        <div className="chips" style={{ margin: 0 }}>
          <span className="chip ok">{k.autoCount} auto</span>
          {k.reconnectCount > 0 && <span className="chip warn">{k.reconnectCount} reconnect</span>}
          {k.manualCount > 0 && <span className="chip fail">{k.manualCount} manual</span>}
        </div>
      </div>
      <div className="ksgrid">
        {k.actions.map((a: KnowledgeAction, i) => (
          <div key={i} className="kscard">
            <div className="kscard-top">
              <span className="ksicon">{ksIcon(a.target)}</span>
              <span className="kstitle">{a.title}</span>
              {a.ownership && a.strategy === 'recreate' && (
                <span className={`tag ${a.ownership === 'owned' ? 'supported' : a.ownership === 'third-party' ? 'none' : 'partial'}`}>
                  {a.ownership === 'owned' ? 'Own domain' : a.ownership === 'third-party' ? '3rd-party' : 'Ownership?'}
                </span>
              )}
              <span className={`tag ${KDISPO[a.disposition].tag}`}>{KDISPO[a.disposition].label}</span>
            </div>
            <p className="ksdetail">{a.detail}</p>
            {a.incompatibleFiles && a.incompatibleFiles.length > 0 && (
              <p className="kswarn">⚠ Unsupported format: {a.incompatibleFiles.join(', ')}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Explore() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  const [envs, setEnvs] = useState<EnvironmentInfo[] | null>(null);
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [agents, setAgents] = useState<AgentBrief[] | null>(null);
  const [agent, setAgent] = useState<AgentBrief | null>(null);
  const [assessment, setAssessment] = useState<AgentAssessment | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) fetchEnvironments(session).then(setEnvs).catch(() => setEnvs([]));
  }, [session]);

  const selectEnv = async (e: EnvironmentInfo) => {
    setEnv(e);
    setAgents(null);
    setAgent(null);
    setAssessment(null);
    if (!e.accessible) return;
    const list = await fetchAgents(session, e.url).catch(() => []);
    setAgents(list);
  };

  const selectAgent = async (a: AgentBrief) => {
    if (!env) return;
    setAgent(a);
    setAssessment(null);
    setLoading(true);
    const res = await fetchAssessment(session, env.url, a).catch(() => null);
    setAssessment(res);
    setLoading(false);
  };

  return (
    <div className="card wide">
      <h2>Assess environments &amp; agents</h2>
      <p className="lead">
        See exactly what will migrate automatically, what needs adaptation, and what requires
        manual work — per agent, before any migration runs.
      </p>

      <h3 style={{ margin: '8px 0' }}>Environments</h3>
      {!envs && <p className="lead">Discovering environments…</p>}
      <div className="agentlist">
        {envs?.map((e) => (
          <div
            key={e.id || e.url}
            className="agentrow"
            style={{
              cursor: e.accessible ? 'pointer' : 'not-allowed',
              opacity: e.accessible ? 1 : 0.55,
              borderColor: env?.url === e.url ? 'var(--blue)' : undefined,
            }}
            onClick={() => e.accessible && selectEnv(e)}
          >
            <div className="head">
              <span>{e.name || e.url}</span>
              <span className={`badge ${e.accessible ? 'ok' : 'fail'}`}>
                {e.accessible ? `${e.bots} agents` : 'no access (403)'}
              </span>
            </div>
            {e.accessible && (
              <div className="chips">
                <span className="chip">{e.topics} topics</span>
                <span className="chip">{e.knowledgeSources} knowledge</span>
                <span className="chip">{e.flows} flows</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {env?.accessible && (
        <>
          <h3 style={{ margin: '18px 0 8px' }}>Agents in {env.name}</h3>
          {!agents && <p className="lead">Loading agents…</p>}
          <div className="chips">
            {agents?.map((a) => (
              <button
                key={a.botid}
                className={`chip ${agent?.botid === a.botid ? 'ok' : ''}`}
                style={{ cursor: 'pointer', border: 'none' }}
                onClick={() => selectAgent(a)}
              >
                {a.name}
              </button>
            ))}
          </div>
        </>
      )}

      {agent && (
        <div style={{ marginTop: 20 }}>
          <div className="head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>{agent.name}</h3>
            {assessment && (
              <a className="chip" href={agentJsonUrl(session, env!.url, agent)}>
                ↓ Export IR (JSON)
              </a>
            )}
          </div>

          {loading && <p className="lead">Extracting &amp; assessing…</p>}

          {assessment && (
            <>
              <div className="chips" style={{ margin: '10px 0' }}>
                <span className={`chip effort-${assessment.effort}`}>effort: {assessment.effort}</span>
                <span className="chip ok">Auto {assessment.summary.supported}</span>
                <span className="chip warn">Adapt {assessment.summary.partial}</span>
                <span className="chip fail">Manual {assessment.summary.manual}</span>
              </div>

              {assessment.knowledge && <KnowledgePanel k={assessment.knowledge} />}

              {assessment.dependencies.length > 0 && (
                <div className="infobox">
                  <strong>Dependencies detected</strong>
                  <ul className="fidelity">
                    {assessment.dependencies.map((d, i) => (
                      <li key={i}>
                        {d.type}: <span className="mono">{d.ref}</span> (from {d.from})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <table className="assess">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Maps</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {assessment.components.map((c, i) => (
                    <tr key={i}>
                      <td>{c.component}</td>
                      <td>
                        <span className={`tag ${c.compatibility}`}>{COMPAT_LABEL[c.compatibility]}</span>
                      </td>
                      <td className="note">{c.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
