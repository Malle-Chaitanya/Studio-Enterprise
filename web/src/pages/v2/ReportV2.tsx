import { useEffect, useMemo, useReducer, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Inspector,
  InspectorHead,
  InspectorSection,
  Note,
  Panel,
  SkeletonRows,
} from '../../components/v2/primitives.tsx';
import { fetchRun, fetchRuns } from '../../api.ts';
import type { MigrationResult, RunHeader } from '../../types.ts';

/**
 * What the customer sees when a migration finishes.
 *
 * Success-forward by request: the headline is what the migrated agent can DO --
 * connectors, tools, sub-agents -- because that is the question being asked, and a screen
 * opening with a list of caveats reads as a failed migration even when nothing failed.
 * The exhaustive view stays in the .xlsx (services/report.ts); putting all of it on screen
 * is what made the previous report screen something the customer asked to have removed.
 *
 * It is not allowed to be greener than the run was. On 2026-08-23 a live run reported
 * "deployed" while the ADK deploy had 500'd and silently degraded to a low-code agent with
 * no connector tools at all. So every number here is derived from the per-agent records
 * rather than stated on its own, and anything genuinely lost opens by itself.
 */

/** Notes worth a customer's attention. `mapped` is the happy path and says nothing new. */
const NOTEWORTHY = new Set(['lost', 'partial', 'needs-review']);

/**
 * Notes this SCREEN does not show. They are not dropped: renderReportExcel still writes
 * every one of them, and that file is the record.
 *
 * `web-browsing` is here by product decision -- an alternative is being chosen, and until
 * then a permanent-sounding loss on the success screen misstates where it stands. The list
 * is deliberately explicit rather than a pattern: a rule broad enough to hide a category
 * is a rule that will one day hide something nobody chose to hide.
 */
const HIDDEN_ON_SCREEN = new Set(['capability:web-browsing']);

/**
 * Collapse a connector's per-operation notes onto one line.
 *
 * A run missing one credential emitted ELEVEN 'lost' notes for a single connector, which
 * reads as eleven broken things instead of one connector nobody had configured yet. Both
 * component shapes the mapper emits are handled; the second was found only by rendering a
 * real run, sitting there as 28 more ungrouped rows.
 */
function groupKey(component: string): string {
  if (component.startsWith('tool:')) {
    const label = component.slice('tool:'.length);
    const dash = label.indexOf(' - ');
    return dash === -1 ? label : label.slice(0, dash);
  }
  if (component.startsWith('connector:')) {
    const id = component.split(':')[1] ?? component;
    return id.replace(/^shared_/, '');
  }
  return component;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "11m 42s" — omitted entirely rather than guessed when the run has no end time. */
function duration(from?: string, to?: string): string | undefined {
  if (!from || !to) return undefined;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function when(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ReportV2() {
  const { runId: runIdParam } = useParams<{ runId?: string }>();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const [results, setResults] = useState<MigrationResult[] | null>(null);
  const [header, setHeader] = useState<RunHeader | null>(null);
  const [error, setError] = useState('');
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    if (!session) { setError('This report needs a session.'); return; }
    let live = true;
    (async () => {
      try {
        // The rail links to /v2/report with no id, so resolve the latest run here rather
        // than making the rail carry one it would have to keep up to date.
        const id = runIdParam ?? (await fetchRuns(session, 1))[0]?.runId;
        if (!id) { if (live) setError('No migration has been run yet.'); return; }
        const r = await fetchRun(session, id);
        if (!live) return;
        setResults(r.results);
        setHeader(r.run ?? null);
      } catch (e) {
        if (!live) return;
        // run_not_found covers "someone else's run" too -- the server refuses to tell them
        // apart, and repeating that refusal here keeps the answer honest.
        setError((e as Error).message === 'run_not_found'
          ? 'That run was not found for your account.'
          : 'Could not read this run.');
      }
    })();
    return () => { live = false; };
  }, [session, runIdParam]);

  const t = useMemo(() => {
    const rows = results ?? [];
    // A connector wired for several agents is still one system reconnected.
    const connectors = new Set<string>();
    let tools = 0;
    let toolsKnown = false;
    let subAgents = 0;
    for (const r of rows) {
      for (const c of r.connectorsWired ?? []) {
        connectors.add(c.name);
        tools += c.toolCount;
        toolsKnown = true;
      }
      subAgents += r.subAgents ?? 0;
    }
    const raw = rows.flatMap((r) =>
      r.fidelity.filter((f) => NOTEWORTHY.has(f.status) && !HIDDEN_ON_SCREEN.has(f.component)));
    const grouped = new Map<string, { label: string; status: string; count: number; detail: string }>();
    for (const n of raw) {
      const label = groupKey(n.component);
      const key = `${label}::${n.status}`;
      const seen = grouped.get(key);
      if (seen) seen.count += 1;
      else grouped.set(key, { label, status: n.status, count: 1, detail: n.detail });
    }
    return {
      rows,
      live: rows.filter((r) => r.created && !r.error).length,
      failed: rows.filter((r) => r.error).length,
      connectors: connectors.size,
      tools,
      // Runs recorded before connectorsWired existed have no counts. A zero would be a
      // claim about the agent; "--" is a claim about our own record-keeping, which is the
      // true one.
      toolsKnown,
      subAgents,
      notes: [...grouped.values()],
      lost: raw.filter((n) => n.status === 'lost').length,
    };
  }, [results]);

  useEffect(() => { if (t.lost > 0) setShowNotes(true); }, [t.lost]);

  const download = async (): Promise<void> => {
    if (!results) return;
    const res = await fetch('/api/migrate/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName: header?.orgName, results }),
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'migration-report.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  };

  const took = duration(header?.startedAt, header?.finishedAt);
  const at = when(header?.startedAt);

  return (
    <V2Layout
      phase="report"
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={
        <Panel>
          {error && <div className="v2-rep-empty">{error}</div>}
          {!results && !error && <SkeletonRows rows={5} />}

          {results && (
            <div className="v2-rep">
              <div className={`v2-rep-banner ${t.failed ? 'warn' : 'ok'}`}>
                <span className="tick" aria-hidden="true">{t.failed ? '!' : '✓'}</span>
                <div>
                  <strong>
                    {t.failed
                      ? `Migrated ${plural(t.live, 'agent')} — ${t.failed} did not`
                      : 'Migration complete'}
                  </strong>
                  <div className="sub">
                    Copilot Studio → Gemini Enterprise
                    {at ? ` · ${at}` : ''}{took ? ` · ${took}` : ''}
                  </div>
                  {header?.orgName && <div className="sub">{header.orgName}</div>}
                </div>
                <button type="button" className="v2-btn" onClick={() => void download()}>
                  Download full report (.xlsx)
                </button>
              </div>

              <div className="v2-rep-stats">
                <Stat n={String(t.live)} label={`${t.live === 1 ? 'agent' : 'agents'}\nmigrated`} />
                <Stat n={String(t.connectors)} label={'connectors\nlive'} />
                <Stat n={t.toolsKnown ? String(t.tools) : '—'} label={'tools\nreproduced'} />
                <Stat n={String(t.subAgents)} label={'sub-agents\nfrom topics'} />
              </div>

              {t.rows.map((r) => (
                <section key={r.sourceId} className="v2-rep-agent">
                  <header>
                    <div>
                      <h3>{r.name}</h3>
                      {r.capabilities && (
                        <p className="sub">
                          {plural(r.capabilities.total, 'capability', 'capabilities')} ·{' '}
                          {r.capabilities.exact} reproduced exactly
                        </p>
                      )}
                    </div>
                    <span className={`v2-rep-live ${r.error ? 'bad' : 'ok'}`}>
                      {r.error ? r.error : '✓ Live in Gemini'}
                    </span>
                  </header>

                  {(r.connectorsWired?.length ?? 0) > 0 && (
                    <>
                      <h4>Connectors &amp; tools</h4>
                      <table className="v2-rep-table">
                        <tbody>
                          {r.connectorsWired!.map((c) => (
                            <tr key={c.name}>
                              <td className="ok" aria-hidden="true">✓</td>
                              <td>{c.name}</td>
                              <td className="mono num">{plural(c.toolCount, 'tool')}</td>
                              <td className="dim">{c.actsAs ? `acts as ${c.actsAs}` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  <h4>Checks</h4>
                  <ul className="v2-rep-checks">
                    <Check ok={r.created} label="Agent created" />
                    {/* A draft that stayed a draft is the source's intent kept faithfully,
                        not a half-finished deploy -- calling it "not published" would
                        report a correct outcome as a defect. */}
                    <Check
                      ok={r.deployed || !!r.draftPreserved}
                      label={r.deployed ? 'Published' : r.draftPreserved ? 'Draft preserved' : 'Published'}
                    />
                    <Check ok={r.shared} label="Shared" />
                    {/* unknown is not failure: the probe could not run, so nobody has
                        checked yet. The customer's next action differs for each. */}
                    <Check
                      ok={r.verifyStatus === 'verified'}
                      pending={r.verifyStatus !== 'verified' && r.verifyStatus !== 'failed'}
                      label={
                        r.verifyStatus === 'verified' ? 'Answered a live test question'
                          : r.verifyStatus === 'failed' ? 'Live test question failed'
                          : 'Not verified yet'
                      }
                    />
                  </ul>
                </section>
              ))}

              {t.notes.length > 0 && (
                <section className="v2-rep-worth">
                  <header>
                    <h4>Worth knowing</h4>
                    <button type="button" className="v2-linkish" onClick={() => setShowNotes((v) => !v)}>
                      {t.notes.length} {t.notes.length === 1 ? 'item' : 'items'} {showNotes ? '▴' : '▾'}
                    </button>
                  </header>
                  {showNotes && (
                    <ul>
                      {t.notes.map((n) => (
                        <li key={`${n.label}-${n.status}`} className={n.status === 'lost' ? 'lost' : undefined}>
                          <strong>{n.label}</strong>
                          {n.count > 1 ? ` (${plural(n.count, 'action')})` : ''} — {n.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
          )}
        </Panel>
      }
      inspector={
        <Inspector>
          <InspectorHead kind="Report" title={header?.runId ?? runIdParam ?? 'latest run'} />
          <InspectorSection title="What this is">
            <Note>
              One migration run, read back from the server rather than from this browser —
              so it stays readable after the run, the tab, and the container that ran it are
              gone.
            </Note>
          </InspectorSection>
          <InspectorSection title="Deeper detail">
            <Note>
              Per-operation mappings, verification evidence, unwired connectors and
              knowledge candidates are in the .xlsx rather than on this screen.
            </Note>
          </InspectorSection>
        </Inspector>
      }
    />
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="v2-rep-stat">
      <div className="n mono">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function Check({ ok, label, pending }: { ok: boolean; label: string; pending?: boolean }) {
  return (
    <li className={ok ? 'ok' : pending ? 'pending' : 'bad'}>
      <span aria-hidden="true">{ok ? '✓' : pending ? '·' : '✕'}</span> {label}
    </li>
  );
}
