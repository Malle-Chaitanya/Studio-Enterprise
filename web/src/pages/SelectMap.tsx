import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchEngines, fetchEnvironments, fetchProjects, type DestEngine, type DestProject, type GeminiDest } from '../api.ts';
import { GeminiIcon, MsIcon } from '../icons.tsx';
import type { EnvironmentInfo } from '../types.ts';

/**
 * Step 3 — Select & Map Environments. FIRST the admin picks which Copilot Studio
 * environments to migrate, and maps EACH to a target Gemini Enterprise
 * PROJECT + APP (engine) — discovered live from the connected account. Agents are
 * chosen afterward (Select Data), scoped to the environments picked here.
 *
 * Persists: `csge_envs_<session>` (chosen environments) + `csge_dest_<session>`
 * (environmentMap: envUrl → {project, engine, assistant}). Nothing hardcoded.
 */
export function SelectMap() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<DestProject[]>([]);
  const [manualEntry, setManualEntry] = useState(false);
  const [enginesByProject, setEnginesByProject] = useState<Record<string, DestEngine[]>>({});
  const [sel, setSel] = useState<Record<string, { project: string; engine: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const [list, proj] = await Promise.all([
        fetchEnvironments(session).catch(() => [] as EnvironmentInfo[]),
        fetchProjects(session).catch(() => ({ projects: [] as DestProject[], manualEntry: true })),
      ]);
      const acc = list.filter((e) => e.accessible);
      setEnvs(acc);
      setProjects(proj.projects);
      setManualEntry(proj.manualEntry || proj.projects.length === 0);

      const first = proj.projects[0]?.projectNumber ?? '';
      // Default: include environments that actually have agents; default each to
      // the first discovered project.
      const inc = new Set<string>();
      const init: Record<string, { project: string; engine: string }> = {};
      for (const e of acc) {
        init[e.url] = { project: first, engine: '' };
        if ((e.bots ?? 0) > 0) inc.add(e.url);
      }
      setIncluded(inc);
      setSel(init);
      if (first) await loadEngines(first);
      setLoading(false);
    })().catch(() => {
      setError('Could not load environments/projects. Make sure both platforms are connected.');
      setLoading(false);
    });
  }, [session]);

  const loadEngines = async (project: string): Promise<void> => {
    if (!project || enginesByProject[project]) return;
    const engs = await fetchEngines(session, project).catch(() => []);
    setEnginesByProject((m) => ({ ...m, [project]: engs }));
    setSel((s) => {
      const next = { ...s };
      for (const [env, v] of Object.entries(next)) {
        if (v.project === project && !v.engine && engs[0]) next[env] = { ...v, engine: engs[0].id };
      }
      return next;
    });
  };

  const toggleInclude = (url: string) =>
    setIncluded((prev) => {
      const s = new Set(prev);
      s.has(url) ? s.delete(url) : s.add(url);
      return s;
    });
  const onProject = async (env: string, project: string): Promise<void> => {
    setSel((s) => ({ ...s, [env]: { project, engine: '' } }));
    await loadEngines(project);
  };
  const onEngine = (env: string, engine: string): void =>
    setSel((s) => ({ ...s, [env]: { ...s[env], engine } }));

  const chosen = envs.filter((e) => included.has(e.url));
  const ready = chosen.length > 0 && chosen.every((e) => sel[e.url]?.project && sel[e.url]?.engine);

  const cont = () => {
    const environmentMap: Record<string, GeminiDest> = {};
    const envList: { env: string; name: string }[] = [];
    for (const e of chosen) {
      environmentMap[e.url] = { project: sel[e.url].project, engine: sel[e.url].engine, assistant: 'default_assistant' };
      envList.push({ env: e.url, name: e.name });
    }
    sessionStorage.setItem(`csge_dest_${session}`, JSON.stringify(environmentMap));
    sessionStorage.setItem(`csge_envs_${session}`, JSON.stringify(envList));
    navigate(`/select-data?session=${session}`);
  };

  const projLabel = (p: DestProject) => {
    // The injected "connected" fallback entry has displayName already containing
    // the id — don't append it again (avoids "x (connected) (x)").
    if (!p.displayName || p.displayName === p.projectNumber) return p.projectNumber;
    if (p.displayName.includes(p.projectNumber)) return p.displayName;
    return `${p.displayName} (${p.projectNumber})`;
  };

  return (
    <div className="card wide">
      <h2>Select &amp; Map Environments</h2>
      <p className="lead">
        Choose which Copilot Studio environments to migrate, and map each to a target{' '}
        <strong>Gemini Enterprise project &amp; app</strong> (discovered from your connected account).
        You’ll pick the agents next.
      </p>

      {error && <div className="error">{error}</div>}
      {loading && <p className="lead">Discovering environments &amp; Gemini projects…</p>}

      {!loading && envs.length === 0 && <p className="lead">No accessible environments found.</p>}

      {!loading && envs.length > 0 && (
        <>
          <div className="map-head">
            <span><MsIcon s={20} /> Source environment</span>
            <span />
            <span><GeminiIcon s={20} /> Target project &amp; app</span>
          </div>

          {envs.map((e) => {
            const on = included.has(e.url);
            const cur = sel[e.url] ?? { project: '', engine: '' };
            const engs = enginesByProject[cur.project] ?? [];
            return (
              <div key={e.url} className="map-row" style={{ opacity: on ? 1 : 0.6 }}>
                <div className="map-src" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleInclude(e.url)} style={{ marginTop: 4 }} />
                  <div>
                    <div className="map-name">{e.name}</div>
                    <div className="map-sub">{e.bots} agent(s) · {e.knowledgeSources} knowledge · {e.flows} flows</div>
                  </div>
                </div>
                <div className="map-arrow">→</div>
                <div className="map-tgt" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {manualEntry ? (
                    <input
                      className="map-input"
                      value={cur.project}
                      disabled={!on}
                      placeholder="Gemini project id or number"
                      onChange={(ev) => setSel((s) => ({ ...s, [e.url]: { project: ev.target.value.trim(), engine: '' } }))}
                      onBlur={(ev) => ev.target.value.trim() && loadEngines(ev.target.value.trim())}
                    />
                  ) : (
                    <select className="map-input" value={cur.project} disabled={!on} onChange={(ev) => onProject(e.url, ev.target.value)}>
                      <option value="" disabled>Select project…</option>
                      {projects.map((p) => (
                        <option key={p.projectNumber} value={p.projectNumber}>{projLabel(p)}</option>
                      ))}
                    </select>
                  )}
                  <select
                    className="map-input"
                    value={cur.engine}
                    disabled={!on || !cur.project || engs.length === 0}
                    onChange={(ev) => onEngine(e.url, ev.target.value)}
                  >
                    <option value="" disabled>
                      {!cur.project ? 'Select project first' : engs.length === 0 ? 'No apps in this project' : 'Select app…'}
                    </option>
                    {engs.map((eng) => (
                      <option key={eng.id} value={eng.id}>{eng.displayName}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}

          <div className="wizard-actions">
            <button className="wbtn" onClick={() => navigate(`/pair?session=${session}`)}>← Back</button>
            <button className="wbtn primary" disabled={!ready} onClick={cont}>Continue to agents →</button>
          </div>
        </>
      )}
    </div>
  );
}
