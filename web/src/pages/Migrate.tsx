import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSession, migrateStreamUrl, planMigration, type GeminiDest } from '../api.ts';
import { useWizardOptional } from '../context/WizardContext.tsx';
import { IcoDownload } from '../icons.tsx';
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

  const [started, setStarted] = useState(false);
  const [ranDry, setRanDry] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<MigrationResult[]>([]);
  const [done, setDone] = useState<string | null>(null);
  // Deliberately NOT remembered across runs. This acknowledges a specific set of sources
  // seen a moment ago; if the selection changes, it has to be given again.
  const [ackAclLoss, setAckAclLoss] = useState(false);
  const [forceRedeploy, setForceRedeploy] = useState(false);
  // Agents the server refused to migrate until the permission loss is acknowledged.
  const aclBlocked = results.filter((r) => r.error === 'acl_acknowledgement_required');
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
  // `ack` defaults to the checkbox state (used by the cold-start live path below), but a
  // caller that already has its own basis for proceeding — e.g. "Start Live Migration"
  // right after a dry run — can pass it explicitly instead of requiring the checkbox too.
  const run = async (dry: boolean, ack: boolean = ackAclLoss) => {
    if (totalAgents === 0) return;
    const scope: MigrationScope = {
      kind: 'selection',
      units: units.map((u) => ({ env: u.env, botIds: u.botIds })),
    };
    setBusy(true);
    const p = await planMigration(
      session,
      scope,
      { environmentMap: dest },
      dry,
      ack,
      // A dry run creates nothing, so forcing a redeploy is meaningless there — and passing it
      // anyway would let the checkbox change what the preview says without changing what a
      // live run would do.
      dry ? false : forceRedeploy,
    ).catch(() => null);
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'migration-report.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  };

  const behLabel: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 14 };

  return (
    <div className="card wide">
      {!started && (
        <>
          <h2>Review &amp; run</h2>

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
                {/*
                  Only offered on a LIVE run: a dry run creates nothing, so there is nothing to
                  redeploy and the checkbox would imply otherwise.

                  Without this the second migration of an agent that already exists was always
                  skipped, and the only way to pick up a fixed tool was to delete the agent by
                  hand in the Google console. The wording says what actually happens — the same
                  agent is repointed, not duplicated, and the old Reasoning Engine is left
                  behind — because "force" on its own reads as "might break something".
                */}
                {!dryRun && (
                  <label style={behLabel}>
                    <input
                      type="checkbox"
                      checked={forceRedeploy}
                      onChange={(e) => setForceRedeploy(e.target.checked)}
                    />
                    Redeploy agents that already exist (instead of skipping them)
                    <span className="chip">for re-runs</span>
                  </label>
                )}
                {!dryRun && forceRedeploy && (
                  <p className="lead" style={{ margin: '6px 0 0 26px', fontSize: 13 }}>
                    Each agent is updated in place — same agent, not a duplicate. Its previous
                    Reasoning Engine is not deleted automatically and may keep billing until you
                    remove it.
                  </p>
                )}
              </div>

              {!dryRun && !summary?.saOk && (
                <div className="error">
                  Live migration needs a verified Google connection.
                  {summary?.saReason ? <><br />{summary.saReason}</> : ' Use a dry run to preview, or connect Google.'}
                </div>
              )}

              <div className="wizard-actions">
                <button className="wbtn" onClick={() => navigate(`/connector-config?session=${session}`)}>
                  ← Back
                </button>
                <button
                  className="wbtn primary"
                  disabled={!canStart || busy}
                  onClick={() => {
                    wizard?.notifyAction(dryRun ? 'Started a dry run' : 'Started the live migration');
                    void run(dryRun);
                  }}
                >
                  {busy ? 'Preparing…' : dryRun ? 'Start Dry Run →' : 'Start Migration →'}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {started && (
        <>
          <div className="report-header">
            <h2>
              {done
                ? ranDry
                  ? 'Dry run complete'
                  : 'Migration complete'
                : ranDry
                  ? 'Dry run running…'
                  : 'Migration running…'}
            </h2>
            {done && (
              <button type="button" className="mu-iconbtn primary" title="Download report" onClick={downloadReport}>
                <IcoDownload s={13} />
              </button>
            )}
          </div>
          {!done && <div className="lead" style={{ marginBottom: 12 }}>{status}</div>}
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

          {/*
            Permission-loss gate. The server stops between extraction and insert when a
            migration would drop source permissions, because the data store it would create
            cannot carry them and the flag is immutable once set. Nothing has been created
            at this point, so this is the last moment the choice is still free.

            The checkbox starts unticked every time and is not remembered: it acknowledges
            the specific sources listed right above it, not a standing preference.
          */}
          {done && aclBlocked.length > 0 && (
            <div className="donebox" style={{ borderColor: 'var(--fail)' }}>
              <h3>Stopped — knowledge permissions cannot be preserved</h3>
              <p>
                Nothing was created. {aclBlocked.length} agent(s) use knowledge whose source
                permissions will not survive the migration.
              </p>
              <div style={{ margin: '10px 0' }}>
                {aclBlocked.map((r) => (
                  <div key={r.sourceId} style={{ marginBottom: 10 }}>
                    <strong>{r.name}</strong>
                    <ul style={{ margin: '4px 0 0 18px' }}>
                      {r.fidelity
                        .filter((f) => f.component.startsWith('acl:'))
                        .map((f) => (
                          <li key={f.component} style={{ fontSize: 13 }}>
                            {f.component.slice(4)} — {f.detail}
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={ackAclLoss}
                  onChange={(e) => setAckAclLoss(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  I understand these knowledge sources will be readable by everyone who can use
                  the migrated agent, including people who cannot open the originals, and that
                  this cannot be changed afterwards without deleting and re-indexing the data
                  store.
                </span>
              </label>
              <div className="wizard-actions" style={{ marginTop: 14 }}>
                <button
                  className="btn primary"
                  disabled={!ackAclLoss || busy}
                  onClick={() => runRef.current(false)}
                >
                  Migrate anyway
                </button>
                <button className="wbtn" onClick={() => navigate(`/select-data?session=${session}`)}>
                  ← Change what migrates
                </button>
              </div>
            </div>
          )}

          {done && aclBlocked.length === 0 && (
            <div className="donebox">
              <h3>{ranDry ? '✓ Dry run complete' : '✓ Migration complete'}</h3>
              <p>{done}</p>
              {ranDry && (
                <p className="lead" style={{ marginTop: 4 }}>
                  Nothing was created in Gemini yet. Review the preview above, then run it live.
                </p>
              )}
              {ranDry && !summary?.saOk && (
                <p className="lead" style={{ marginTop: 10, color: 'var(--fail)' }}>
                  Live migration needs a verified service account (Google connected).
                </p>
              )}
              <div className="wizard-actions" style={{ marginTop: 14 }}>
                <button className="wbtn" onClick={() => navigate(`/select-data?session=${session}`)}>
                  ← Back to agents
                </button>
                {ranDry && (
                  <button
                    className="wbtn primary"
                    onClick={() => {
                      wizard?.notifyAction('Started the live migration after a dry run');
                      // The dry run already surfaced every fidelity/ACL note for this exact
                      // selection, so going live from here doesn't re-ask for the same
                      // acknowledgement — pass it explicitly instead of routing through the
                      // checkbox gate below (that gate stays for a cold-start live run that
                      // skipped the dry run entirely).
                      void run(false, true);
                    }}
                    disabled={!summary?.saOk || busy}
                  >
                    Start Live Migration →
                  </button>
                )}
              </div>
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
        {!isDry && (
          <span className="chips">
            <Chip on={r.created} label="created" />
            <Chip on={r.deployed} label="deployed" />
            <Chip on={r.shared} label="shared" />
            {r.verified !== undefined && (
              <VerifyChip status={r.verifyStatus ?? (r.verified ? 'verified' : 'failed')} />
            )}
          </span>
        )}
      </div>
      {realError && <div className="fidelity" style={{ color: 'var(--fail)' }}>{realError}</div>}
      {r.verifySample && <div className="fidelity">“{r.verifySample}”</div>}
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

/**
 * Verification is three-valued, and collapsing it to a tick or a dash is what let an
 * unproven agent read as a good one.
 *
 * `unverified` means the probe could not run — the agent exists but nothing established
 * that it works. It is shown distinctly from a real failure because the reader's next
 * action differs: a failure is a defect to chase, an unknown is a check still owed.
 */
function VerifyChip({ status }: { status: 'verified' | 'failed' | 'unknown' }) {
  if (status === 'verified') return <span className="chip ok">✓ verified</span>;
  if (status === 'failed') return <span className="chip warn">— verification failed</span>;
  return <span className="chip warn" title="The agent was created, but no probe could confirm it works. Check it by hand.">? unverified</span>;
}
