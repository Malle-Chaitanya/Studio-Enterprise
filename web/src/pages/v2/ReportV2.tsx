import { useEffect, useMemo, useReducer, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band,
  BandCell,
  Chip,
  Inspector,
  InspectorHead,
  InspectorSection,
  Note,
  NoteRow,
  Panel,
  PanelHead,
  SkeletonRows,
} from '../../components/v2/primitives.tsx';
import { fetchRun } from '../../api.ts';
import type { MigrationResult } from '../../types.ts';

/**
 * What the customer sees when a migration finishes.
 *
 * Deliberately success-forward: the headline is what the migrated agent can DO —
 * connectors and tools — because that is the question being asked, and a screen that
 * opens with a list of caveats reads as a failed migration even when nothing failed.
 *
 * It is not, however, allowed to be greener than the run was. A live run on 2026-08-23
 * reported "deployed" while the ADK deploy had 500'd and silently degraded to a low-code
 * agent with no connector tools at all: every headline number here is therefore derived
 * from the per-agent records, never stated independently, and `worth knowing` opens by
 * itself the moment anything is `lost`. Overclaiming a migration is a trust failure, not
 * a UX preference — see .claude/rules/security-rules.md.
 *
 * The exhaustive view stays in the .xlsx (services/report.ts): per-operation mappings,
 * verification evidence, unwired connectors, knowledge candidates. Putting all of it on
 * screen is what made the previous report screen something the customer asked to remove.
 */

/** Notes worth a customer's attention. `mapped` is the happy path and says nothing new. */
const NOTEWORTHY = new Set(['lost', 'partial', 'needs-review']);

/**
 * Notes this SCREEN does not show. They are not dropped: `renderReportExcel` still writes
 * every one of them, and that file is the record.
 *
 * `web-browsing` is here by product decision — an alternative is being chosen, and until
 * then putting a permanent-sounding loss on the success screen misrepresents where it
 * stands. It is the only entry, and the list is deliberately explicit rather than a
 * pattern: a rule broad enough to hide a category is a rule that will one day hide
 * something nobody chose to hide.
 */
const HIDDEN_ON_SCREEN = new Set(['capability:web-browsing']);

/**
 * Collapse a connector's per-operation notes into one line.
 *
 * A run that lacked one credential emitted ELEVEN 'lost' notes for one connector, which
 * reads as eleven broken things instead of one unconfigured connector. `tool:<Connector> -
 * <operation>` is the shape the mapper emits, so the connector name is the part before the
 * first ' - '.
 */
function groupKey(component: string): string {
  // `tool:<Connector> - <operation>` — the display-name shape.
  if (component.startsWith('tool:')) {
    const label = component.slice('tool:'.length);
    const dash = label.indexOf(' - ');
    return dash === -1 ? label : label.slice(0, dash);
  }
  // `connector:<connectorId>:<Operation>` — the id shape, used by the per-operation
  // `partial` notes. Found only by running this against a real run: it produced 28
  // ungrouped rows next to the 11 the first shape had just collapsed. Rendered as the
  // connector id with the `shared_` prefix off, because that is what the customer
  // recognises and inventing a display name here would be a second source of truth.
  if (component.startsWith('connector:')) {
    const id = component.split(':')[1] ?? component;
    return id.replace(/^shared_/, '');
  }
  return component;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function ReportV2() {
  const { runId } = useParams<{ runId: string }>();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const [results, setResults] = useState<MigrationResult[] | null>(null);
  const [error, setError] = useState('');
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    if (!session || !runId) {
      setError('This report needs a run id and a session.');
      return;
    }
    let live = true;
    fetchRun(session, runId)
      .then((r) => { if (live) setResults(r.results); })
      .catch((e: Error) => {
        if (!live) return;
        // run_not_found covers "someone else's run" too — the server refuses to
        // distinguish them, and repeating that refusal here keeps the answer honest.
        setError(e.message === 'run_not_found'
          ? 'That run was not found for your account.'
          : 'Could not read this run.');
      });
    return () => { live = false; };
  }, [session, runId]);

  const totals = useMemo(() => {
    const rows = results ?? [];
    // One connector may be wired for several agents; the customer is asking how many
    // distinct systems the migration reconnected, so count names, not rows.
    const connectors = new Set<string>();
    let tools = 0;
    let toolsKnown = false;
    for (const r of rows) {
      for (const c of r.connectorsWired ?? []) {
        connectors.add(c.name);
        tools += c.toolCount;
        toolsKnown = true;
      }
    }
    const notes = rows.flatMap((r) =>
      r.fidelity.filter((f) => NOTEWORTHY.has(f.status) && !HIDDEN_ON_SCREEN.has(f.component)));
    // One line per (connector, status), carrying how many operations it covers, so the
    // customer reads "Google Drive - 11 actions" and not eleven near-identical rows.
    const grouped = new Map<string, { label: string; status: string; count: number; detail: string }>();
    for (const n of notes) {
      const label = groupKey(n.component);
      const key = `${label}::${n.status}`;
      const seen = grouped.get(key);
      if (seen) seen.count += 1;
      else grouped.set(key, { label, status: n.status, count: 1, detail: n.detail });
    }
    return {
      agents: rows.length,
      live: rows.filter((r) => r.created && !r.error).length,
      connectors: connectors.size,
      tools,
      // Runs recorded before connectorsWired existed have no counts. Showing "0 tools"
      // would be a claim about the agent rather than about our own record-keeping.
      toolsKnown,
      notes: [...grouped.values()],
      lost: notes.filter((n) => n.status === 'lost').length,
      failed: rows.filter((r) => r.error).length,
    };
  }, [results]);

  useEffect(() => {
    // Anything actually lost is not something to make the reader go looking for.
    if (totals.lost > 0) setShowNotes(true);
  }, [totals.lost]);

  const download = async (): Promise<void> => {
    if (!results) return;
    const res = await fetch('/api/migrate/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'migration-report.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  };

  const heading = totals.failed > 0
    ? `Migrated ${plural(totals.live, 'agent')} — ${totals.failed} did not`
    : `Migration complete`;

  return (
    <V2Layout
      phase="migrate"
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={
        <Panel>
          <PanelHead
            title={heading}
            sub="Copilot Studio → Gemini Enterprise"
            actions={
              results
                ? <button type="button" className="v2-btn" onClick={() => void download()}>
                    Download full report (.xlsx)
                  </button>
                : undefined
            }
          />

          {error && <NoteRow tone="bad">{error}</NoteRow>}
          {!results && !error && <SkeletonRows rows={4} />}

          {results && (
            <>
              <Band>
                <BandCell label="agents migrated" value={String(totals.live)} tone="ok" />
                <BandCell label="connectors live" value={String(totals.connectors)} tone="ok" />
                <BandCell
                  label="tools reproduced"
                  value={totals.toolsKnown ? String(totals.tools) : '—'}
                  note={totals.toolsKnown ? undefined : 'not recorded for this run'}
                  tone={totals.toolsKnown ? 'ok' : 'plain'}
                />
                <BandCell
                  label="needs a look"
                  value={String(totals.notes.length)}
                  tone={totals.lost > 0 ? 'amber' : 'plain'}
                />
              </Band>

              {results.map((r) => (
                <div key={r.sourceId} className="v2-report-agent">
                  <Row
                    name={r.name}
                    error={r.error}
                    created={r.created}
                    deployed={r.deployed}
                    draftPreserved={r.draftPreserved}
                    shared={r.shared}
                    verifyStatus={r.verifyStatus}
                  />
                  {(r.connectorsWired ?? []).map((c) => (
                    <NoteRow key={c.name}>
                      {c.name} · {plural(c.toolCount, 'tool')}
                    </NoteRow>
                  ))}
                </div>
              ))}

              {totals.notes.length > 0 && (
                <>
                  <NoteRow>
                    <button
                      type="button"
                      className="v2-btn"
                      onClick={() => setShowNotes((s) => !s)}
                    >
                      {showNotes ? 'Hide' : 'Show'} what changed ({totals.notes.length})
                    </button>
                  </NoteRow>
                  {showNotes && totals.notes.map((n) => (
                    <NoteRow key={`${n.label}-${n.status}`} tone={n.status === 'lost' ? 'bad' : undefined}>
                      <strong>{n.label}</strong>
                      {n.count > 1 ? ` — ${plural(n.count, 'action')}` : ''} · {n.detail}
                    </NoteRow>
                  ))}
                </>
              )}
            </>
          )}
        </Panel>
      }
      inspector={
        <Inspector>
          <InspectorHead kind="Report" title={runId ?? 'run'} />
          <InspectorSection title="What this is">
            <Note>
              The record of one migration run, read back from the server — not from this
              browser. It stays readable after the run, the tab, and the server that ran it
              are gone.
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

/** One agent's outcome. The four states are shown apart because they fail apart. */
function Row({ name, error, created, deployed, draftPreserved, shared, verifyStatus }: {
  name: string;
  error?: string;
  created: boolean;
  deployed: boolean;
  draftPreserved?: boolean;
  shared: boolean;
  verifyStatus?: 'verified' | 'failed' | 'unknown';
}) {
  return (
    <NoteRow tone={error ? 'bad' : undefined}>
      <strong>{name}</strong>{' '}
      {error
        ? <Chip tone="bad">{error}</Chip>
        : (
          <>
            <Chip tone={created ? 'ok' : 'bad'}>created</Chip>{' '}
            {/* A draft that stayed a draft is the source's intent faithfully kept, not a
                half-finished deploy — saying "not published" would report it as a defect. */}
            <Chip tone={deployed ? 'ok' : draftPreserved ? 'plain' : 'warn'}>
              {deployed ? 'published' : draftPreserved ? 'draft preserved' : 'not published'}
            </Chip>{' '}
            <Chip tone={shared ? 'ok' : 'plain'}>{shared ? 'shared' : 'not shared'}</Chip>{' '}
            {/* unknown is not failure: the probe could not run, so nobody has checked yet. */}
            <Chip tone={verifyStatus === 'verified' ? 'ok' : verifyStatus === 'failed' ? 'bad' : 'warn'}>
              {verifyStatus === 'verified' ? 'answered a test question'
                : verifyStatus === 'failed' ? 'test question failed'
                : 'not verified yet'}
            </Chip>
          </>
        )}
    </NoteRow>
  );
}
