import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchEngines, fetchEnvironments, fetchProjects, type DestEngine, type DestProject, type GeminiDest } from '../api.ts';
import { useWizardOptional } from '../context/WizardContext.tsx';
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
  const wizard = useWizardOptional();

  const [envs, setEnvs] = useState<EnvironmentInfo[]>([]);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<DestProject[]>([]);
  const [manualEntry, setManualEntry] = useState(false);
  const [enginesByProject, setEnginesByProject] = useState<Record<string, DestEngine[]>>({});
  const [enginesLoaded, setEnginesLoaded] = useState<Record<string, boolean>>({});
  const [enginesWarning, setEnginesWarning] = useState<string | null>(null);
  const [sel, setSel] = useState<Record<string, { project: string; engine: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default view shows only projects that already have a Gemini app (valid
  // destinations); the toggle reveals every accessible project.
  const [showAllProjects, setShowAllProjects] = useState(false);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const [list, proj] = await Promise.all([
        fetchEnvironments(session).catch(() => [] as EnvironmentInfo[]),
        fetchProjects(session).catch(() => ({ projects: [] as DestProject[], manualEntry: true, defaultProject: '' })),
      ]);
      const acc = list.filter((e) => e.accessible);
      setEnvs(acc);
      setProjects(proj.projects);
      setManualEntry(proj.manualEntry || proj.projects.length === 0);

      // Pre-select the discovered Gemini destination so the common case is
      // "confirm", not "hunt": prefer the server's defaultProject, else the first
      // Gemini-capable project, else the first project.
      const defaultProj =
        proj.defaultProject ||
        proj.projects.find((p) => p.hasGeminiApp)?.projectNumber ||
        proj.projects[0]?.projectNumber ||
        '';
      // Default: include environments that actually have agents; default each to
      // the discovered project.
      const inc = new Set<string>();
      const init: Record<string, { project: string; engine: string }> = {};
      for (const e of acc) {
        init[e.url] = { project: defaultProj, engine: '' };
        if ((e.bots ?? 0) > 0) inc.add(e.url);
      }
      setIncluded(inc);
      setSel(init);
      if (defaultProj) await loadEngines(defaultProj);
      setLoading(false);
    })().catch(() => {
      setError('Could not load environments/projects. Make sure both platforms are connected.');
      setLoading(false);
    });
  }, [session]);

  const loadEngines = async (project: string, force = false): Promise<void> => {
    if (!project || (!force && enginesLoaded[project])) return;
    setEnginesWarning(null);
    try {
      const result = await fetchEngines(session, project);
      const engs = result.engines ?? [];
      setEnginesByProject((m) => ({ ...m, [project]: engs }));
      setEnginesLoaded((m) => ({ ...m, [project]: true }));
      if (!engs.length && result.warning) setEnginesWarning(result.warning);
      setSel((s) => {
        const next = { ...s };
        for (const [env, v] of Object.entries(next)) {
          if (v.project === project && !v.engine && engs[0]) next[env] = { ...v, engine: engs[0].id };
        }
        return next;
      });
    } catch (e) {
      setEnginesByProject((m) => ({ ...m, [project]: [] }));
      setEnginesLoaded((m) => ({ ...m, [project]: true }));
      setEnginesWarning((e as Error).message || 'Could not load apps for this project');
    }
  };

  const toggleInclude = (url: string) => {
    setIncluded((prev) => {
      const s = new Set(prev);
      const nowIncluded = !s.has(url);
      nowIncluded ? s.add(url) : s.delete(url);
      const name = envs.find((e) => e.url === url)?.name ?? url;
      wizard?.notifyAction(`${nowIncluded ? 'Included' : 'Excluded'} environment "${name}" for migration`);
      return s;
    });
  };
  const onProject = async (env: string, project: string): Promise<void> => {
    setSel((s) => ({ ...s, [env]: { project, engine: '' } }));
    // Always re-fetch when the user picks a project (don't stick on a prior empty cache).
    await loadEngines(project, true);
  };
  const onEngine = (env: string, engine: string): void =>
    setSel((s) => ({ ...s, [env]: { ...s[env], engine } }));

  const chosen = envs.filter((e) => included.has(e.url));
  const ready = chosen.length > 0 && chosen.every((e) => sel[e.url]?.project && sel[e.url]?.engine);

  // Only projects with a Gemini app are valid destinations. Show just those by
  // default; if none were detected, fall back to showing all so the user is never
  // stuck with an empty list. Always keep an already-selected project visible.
  const geminiCount = projects.filter((p) => p.hasGeminiApp).length;
  const noGemini = geminiCount === 0;
  const selectedProjNums = new Set(Object.values(sel).map((v) => v.project).filter(Boolean));
  const optionProjects =
    showAllProjects || noGemini
      ? projects
      : projects.filter((p) => p.hasGeminiApp || selectedProjNums.has(p.projectNumber));
  const hiddenCount = projects.length - geminiCount;

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
    // The injected "connected" fallback entry already reads "<id> (connected)".
    if (p.displayName.includes('(connected)')) return p.displayName;
    // Just the project's own name — no projectId/org context in the dropdown.
    return p.displayName || p.projectId || p.projectNumber;
  };

  return (
    <div className="card wide">
      <h2>Select &amp; Map Environments</h2>
      <p className="lead" style={{ marginBottom: 16 }}>
        Choose which source environments to migrate and map each one to the Google Cloud
        project and Gemini Enterprise app its agents will be created in.
      </p>

      {error && <div className="error">{error}</div>}
      {enginesWarning && (
        <div className="error" style={{ marginBottom: 12 }}>
          Apps list: {enginesWarning}{' '}
          <button
            type="button"
            className="dlink"
            style={{ padding: 0 }}
            onClick={() => {
              const p = Object.values(sel).find((v) => v.project)?.project;
              if (p) void loadEngines(p, true);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading && (
        <>
          <p className="lead" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="cf-spinner" aria-hidden="true" />
            Discovering environments &amp; Gemini projects…
          </p>
          {/* Skeleton rows so the page shows the shape of the result instead of a bare
              line of text on empty space. */}
          {[0, 1].map((i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 16,
                padding: '16px 0', borderBottom: '1px solid var(--border)',
                opacity: 1 - i * 0.3,
              }}
            >
              <div className="cf-skel" style={{ width: 16, height: 16, borderRadius: 3 }} />
              <div style={{ flex: 1 }}>
                <div className="cf-skel" style={{ width: '35%', height: 13, marginBottom: 7 }} />
                <div className="cf-skel" style={{ width: '22%', height: 10 }} />
              </div>
              <div className="cf-skel" style={{ width: '32%', height: 34, borderRadius: 6 }} />
            </div>
          ))}
        </>
      )}

      {!loading && envs.length === 0 && <p className="lead">No accessible environments found.</p>}

      {!loading && envs.length > 0 && (
        <>
          {!manualEntry && !noGemini && hiddenCount > 0 && (
            <label className="lead" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={showAllProjects}
                onChange={(ev) => setShowAllProjects(ev.target.checked)}
              />
              Show all projects ({hiddenCount} without a Gemini app hidden)
            </label>
          )}
          {!manualEntry && noGemini && (
            <p className="lead" style={{ marginBottom: 12 }}>
              No projects with a Gemini app were detected — showing all projects. Pick the project
              that hosts your Gemini Enterprise app.
            </p>
          )}

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
                      {optionProjects.map((p) => (
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
                      {!cur.project
                        ? 'Select project first'
                        : engs.length === 0
                          ? enginesLoaded[cur.project]
                            ? 'No apps found — see warning / Retry'
                            : 'Loading apps…'
                          : 'Select app…'}
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
            <button className="wbtn" onClick={() => navigate(`/map-users?session=${session}`)}>← Back</button>
            <button className="wbtn primary" disabled={!ready} onClick={cont}>Continue to agents →</button>
          </div>
        </>
      )}
    </div>
  );
}
