import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSession, migrateStreamUrl, planMigration, type GeminiDest } from '../api.ts';
import { useWizardOptional } from '../context/WizardContext.tsx';
import type {
  MigrationResult,
  MigrationScope,
  ProgressEvent,
  SessionSummary,
} from '../types.ts';

interface Unit {
  env: string;
  name: string;
  botIds: string[];
}

/**
 * Steps 5–7 — Dry Run / Live Migration / Report.
 *
 * No scope picker here: the agents were chosen in Select Data and mapped to
 * projects in Select & Map. This screen mirrors GEM_CO's Options→Migration:
 * review what will run, choose dry-run vs live, run it, see per-agent results.
 */
export function Migrate() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const session = params.get('session') ?? '';
  const wizard = useWizardOptional();

  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  // Per-environment destination {project, engine, assistant} chosen in Select & Map.
  const [dest, setDest] = useState<Record<string, GeminiDest>>({});
  const [dryRun, setDryRun] = useState(true);
  const [prefixWithEnv, setPrefixWithEnv] = useState(false);

  const [started, setStarted] = useState(false);
  const [ranDry, setRanDry] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<MigrationResult[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const runRef = useRef<(dry: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    if (!session) return;
    fetchSession(session).then(setSummary).catch(() => setSummary(null));
    try {
      const d = JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
      const m = JSON.parse(sessionStorage.getItem(`csge_dest_${session}`) || '{}');
      if (Array.isArray(d)) setUnits(d);
      if (m && typeof m === 'object') setDest(m);
    } catch {
      /* no saved selection */
    }
    return () => esRef.current?.close();
  }, [session, wizard?.toolEpoch]);

  useEffect(() => {
    if (!wizard) return;
    return wizard.onMigrateRequest(({ dryRun: dry }) => {
      setDryRun(dry);
      void runRef.current(dry);
    });
  }, [wizard]);

  const totalAgents = units.reduce((n, u) => n + u.botIds.length, 0);
  const canStart = totalAgents > 0 && (dryRun || !!summary?.saOk);

  const openStream = () => {
    setStarted(true);
    setDone(null);
    setResults([]);
    setPct(0);
    setStatus('Starting…');
    const es = new EventSource(migrateStreamUrl(session));
    esRef.current = es;
    es.onmessage = (e) => {
      const evt = JSON.parse(e.data) as ProgressEvent;
      if (evt.type === 'progress') {
        setPct(evt.pct);
        setStatus(evt.msg);
      } else if (evt.type === 'agent') {
        setResults((r) => [...r.filter((x) => x.sourceId !== evt.result.sourceId), evt.result]);
      } else if (evt.type === 'done') {
        setDone(evt.summary);
        setResults(evt.results);
        es.close();
      }
    };
    es.onerror = () => {
      setStatus('Connection lost.');
      es.close();
    };
  };

  // Build the plan from the Select-Data selection + Select-&-Map projects, then run.
  const run = async (dry: boolean) => {
    if (totalAgents === 0) return;
    const scope: MigrationScope = {
      kind: 'selection',
      units: units.map((u) => ({ env: u.env, botIds: u.botIds })),
    };
    setBusy(true);
    const p = await planMigration(session, scope, { prefixWithEnv, environmentMap: dest }, dry).catch(() => null);
    setBusy(false);
    if (!p) {
      setStatus('Could not build the migration plan.');
      return;
    }
    setRanDry(dry);
    openStream();
  };
  runRef.current = run;

  const downloadReport = async () => {
    const res = await fetch('/api/migrate/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName: summary?.orgName ?? 'Organization', results }),
    });
    const md = await res.text();
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'migration-report.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  const behLabel: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 14 };

  return (
    <div className="card wide">
      {!started && (
        <>
          <h2>Review &amp; run</h2>
          <p className="lead">
            Your selected agents and target projects are ready. Run a dry run first to preview, then
            migrate live.
          </p>

          {totalAgents === 0 ? (
            <>
              <div className="infobox">No agents selected yet — go back and pick agents to migrate.</div>
              <button className="btn primary" onClick={() => navigate(`/select-data?session=${session}`)}>
                Go to Select Agents →
              </button>
            </>
          ) : (
            <>
              <div className="infobox">
                <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }}>
                  {totalAgents} agent{totalAgents === 1 ? '' : 's'} → Gemini Enterprise
                </div>
                {units.map((u) => (
                  <div key={u.env} className="row" style={{ border: 'none', padding: '6px 0' }}>
                    <span>
                      {u.name} · {u.botIds.length} agent{u.botIds.length === 1 ? '' : 's'}
                    </span>
                    <span className="val">→ {dest[u.env]?.engine || 'gemini-enterprise'}</span>
                  </div>
                ))}
              </div>

              <div className="infobox">
                <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 10 }}>Behavior</div>
                <label style={behLabel}>
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                  Dry run (preview only — nothing created in Gemini)
                  <span className="chip">recommended first</span>
                </label>
                <label style={behLabel}>
                  <input type="checkbox" checked={prefixWithEnv} onChange={(e) => setPrefixWithEnv(e.target.checked)} />
                  Prefix agent names with their source environment
                </label>
              </div>

              {!dryRun && !summary?.saOk && (
                <div className="error">
                  Live migration needs a verified Google connection.
                  {summary?.saReason ? <><br />{summary.saReason}</> : ' Use a dry run to preview, or connect Google.'}
                </div>
              )}

              <div className="wizard-actions">
                <button className="wbtn" onClick={() => navigate(`/connectors?session=${session}`)}>
                  ← Back
                </button>
                <button className="wbtn primary" disabled={!canStart || busy} onClick={() => run(dryRun)}>
                  {busy ? 'Preparing…' : dryRun ? 'Start Dry Run →' : 'Start Migration →'}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {started && (
        <>
          <h2>
            {done
              ? ranDry
                ? 'Dry run complete'
                : 'Migration complete'
              : ranDry
                ? 'Dry run running…'
                : 'Migration running…'}
          </h2>
          <div className="lead" style={{ marginBottom: 12 }}>{status}</div>
          <div className="progbar" style={{ marginBottom: 20 }}>
            <div className="progfill" style={{ width: `${pct}%` }} />
          </div>

          {results.length > 0 && (
            <div className="agentlist">
              {results.map((r) => (
                <AgentCard key={r.sourceId} r={r} dry={ranDry} />
              ))}
            </div>
          )}

          {done && (
            <div className="donebox">
              <h3>{ranDry ? '✓ Dry run complete' : '✓ Migration complete'}</h3>
              <p>{done}</p>
              {ranDry && (
                <p className="lead" style={{ marginTop: 4 }}>
                  Nothing was created in Gemini yet. Review the preview above, then run it live.
                </p>
              )}
              <div className="actions" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                {ranDry && (
                  <button
                    className="btn primary"
                    style={{ width: 'auto' }}
                    onClick={() => run(false)}
                    disabled={!summary?.saOk || busy}
                  >
                    Start Live Migration →
                  </button>
                )}
                <button className="btn google" style={{ width: 'auto' }} onClick={downloadReport}>
                  Download report
                </button>
                {!ranDry && (
                  <a className="btn google" style={{ width: 'auto' }} href="https://business.gemini.google" target="_blank" rel="noreferrer">
                    Open Gemini Enterprise →
                  </a>
                )}
              </div>
              {ranDry && !summary?.saOk && (
                <p className="lead" style={{ marginTop: 10, color: 'var(--fail)' }}>
                  Live migration needs a verified service account (Google connected).
                </p>
              )}
              <button className="wbtn" style={{ marginTop: 14 }} onClick={() => navigate(`/select-data?session=${session}`)}>
                ← Back to agents
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AgentCard({ r, dry }: { r: MigrationResult; dry: boolean }) {
  const isDry = dry || r.error === 'dry-run (not created)';
  const realError = !isDry && r.error;
  let auto = 0;
  let adapt = 0;
  let review = 0;
  for (const f of r.fidelity) {
    if (f.status === 'mapped') auto++;
    else if (f.status === 'partial') adapt++;
    else review++;
  }
  return (
    <div className="agentrow">
      <div className="head">
        <span>{r.name}</span>
        <span className="chips">
          {isDry ? (
            <span className="chip" style={{ background: 'var(--tint)', color: 'var(--brand)', borderColor: 'var(--brand-l)' }}>
              ▶ ready to migrate
            </span>
          ) : (
            <>
              <Chip on={r.created} label="created" />
              <Chip on={r.deployed} label="deployed" />
              {r.permissionHandoff ? (
                <span className="chip warn">handoff</span>
              ) : (
                <Chip on={r.shared} label="shared" />
              )}
              {r.verified !== undefined && <Chip on={r.verified} label="verified" />}
            </>
          )}
        </span>
      </div>
      {realError && <div className="fidelity" style={{ color: 'var(--fail)' }}>{realError}</div>}
      {r.verifySample && <div className="fidelity">“{r.verifySample}”</div>}
      {r.permissionHandoff && (
        <div className="fidelity">
          Permission handoff: {r.permissionHandoff.grantUsers.length} user(s),{' '}
          {r.permissionHandoff.grantGroups.length} group(s),{' '}
          {r.permissionHandoff.unresolved.length} unresolved
        </div>
      )}
      {r.fidelity.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          {auto > 0 && <span className="tag supported">{auto} auto</span>}
          {adapt > 0 && <span className="tag partial">{adapt} adapt</span>}
          {review > 0 && <span className="tag manual">{review} needs review</span>}
        </div>
      )}
    </div>
  );
}

function Chip({ on, label }: { on: boolean; label: string }) {
  return <span className={`chip ${on ? 'ok' : 'warn'}`}>{on ? '✓' : '—'} {label}</span>;
}
