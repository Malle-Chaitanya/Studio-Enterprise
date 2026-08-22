import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, BandRule, Btn, Chip, Inspector, InspectorHead, InspectorSection, KeyValue,
  Note, NoteRow, Panel, PanelHead, Row, Toggle, WizardFooter, type ChipTone,
} from '../../components/v2/primitives.tsx';
import { useSource, type RunAgent, type RunLine } from '../../v2/data/index.ts';

const AGENT_CHIP: Record<RunAgent['state'], ChipTone> = {
  queued: 'plain', running: 'run', done: 'ok', failed: 'bad',
};

/**
 * Migrate.
 *
 * The run itself. Progress is whatever the server streams — no line appears here
 * that the server did not send, and the percentage is the server's, not a timer
 * pretending to be one.
 *
 * Dry run is the default on purpose. It exercises extract and mapping and writes
 * nothing to Gemini, so a customer can see the whole run before the first real
 * write. Turning it off is a deliberate act.
 */
export default function MigrateV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [dryRun, setDryRun] = useState<'dry' | 'live'>('dry');
  const [lines, setLines] = useState<RunLine[]>([]);
  const [agents, setAgents] = useState<RunAgent[]>([]);
  const [pct, setPct] = useState(0);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);
  const stopRef = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Always leave the stream closed behind us — an EventSource that outlives the
  // screen keeps a server connection open for a run nobody is watching.
  useEffect(() => () => stopRef.current?.(), []);

  useEffect(() => {
    // Follow the tail only while the run is live, so reading back through the log
    // is not yanked away on every new line.
    if (running && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, running]);

  const planned = useMemo(() => {
    try {
      const selection: Array<{ env: string; botIds: string[] }> =
        JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
      return selection.reduce((n, s) => n + s.botIds.length, 0);
    } catch {
      return 0;
    }
  }, [session]);

  const start = useCallback(async (): Promise<void> => {
    setLines([]);
    setAgents([]);
    setPct(0);
    setFinished(null);
    setError('');
    setRunning(true);
    dispatch({ kind: 'thinking', note: dryRun === 'dry' ? 'Dry run — nothing will be written.' : 'Migrating.' });

    stopRef.current?.();
    stopRef.current = source.migrate.subscribe(session, (u) => {
      if (u.pct !== undefined) setPct(u.pct);
      if (u.line) setLines((prev) => [...prev, u.line as RunLine]);
      if (u.agent) {
        const next = u.agent;
        setAgents((prev) => {
          const i = prev.findIndex((a) => a.name === next.name);
          if (i === -1) return [...prev, next];
          const copy = [...prev];
          copy[i] = next;
          return copy;
        });
        dispatch({
          kind: next.state === 'running' ? 'tool_start' : 'tool_end',
          tool: 'migrate_agent',
          ok: next.state !== 'failed',
          note: next.state === 'running' ? `Migrating ${next.name}…` : `${next.name}: ${next.note ?? next.state}`,
        });
      }
      if (u.finished) {
        setRunning(false);
        setFinished(u.finished.summary);
        dispatch({ kind: 'done', note: u.finished.summary });
      }
    });

    try {
      await source.migrate.start(session, { dryRun: dryRun === 'dry' });
    } catch (e) {
      setRunning(false);
      setError((e as Error).message || 'plan_failed');
      dispatch({ kind: 'idle' });
    }
  }, [session, source, dryRun]);

  const done = agents.filter((a) => a.state === 'done').length;
  const failed = agents.filter((a) => a.state === 'failed').length;

  const canvas = (
    <>
      <Panel>
        <Band
          aside={
            <>
              <Chip tone={dryRun === 'dry' ? 'warn' : 'bad'}>
                {dryRun === 'dry' ? 'writes nothing' : 'writes for real'}
              </Chip>
              <Toggle
                value={dryRun}
                options={[{ id: 'dry', label: 'Dry run' }, { id: 'live', label: 'Migrate' }]}
                onChange={(v) => setDryRun(v)}
              />
            </>
          }
        >
          <BandCell label="In this run" value={planned || agents.length || '—'} note="agents" tone="warn" />
          <BandCell label="Done" value={done || '—'} note="created in Gemini" tone="ok" />
          <BandCell label="Failed" value={failed || '—'} note="see the log" tone={failed ? 'bad' : 'plain'} />
          <BandCell label="Progress" value={`${Math.round(pct)}%`} note={running ? 'running' : finished ? 'finished' : 'not started'} />
        </Band>
        <BandRule pct={pct} />
      </Panel>

      <Panel>
        <PanelHead
          title={running ? 'Running' : finished ? 'Run finished' : 'Ready to run'}
          sub={dryRun === 'dry'
            ? 'A dry run extracts and maps everything, then stops. Nothing is created, published or shared.'
            : 'This writes to Gemini Enterprise. Re-running is safe — agents are matched by name, so nothing is duplicated.'}
          actions={
            <Btn tone={dryRun === 'dry' ? 'blue' : 'amber'} onClick={() => void start()} disabled={running}>
              {running ? 'Running…' : dryRun === 'dry' ? 'Start dry run' : 'Start migration'}
            </Btn>
          }
        />

        {error && <NoteRow tone="bad">Could not start the run: {error}</NoteRow>}
        {!running && !finished && lines.length === 0 && (
          <NoteRow>
            Nothing has run yet. {planned ? `${planned} agents are selected.` : 'No agents are selected — go back and pick some.'}
          </NoteRow>
        )}

        {agents.map((a) => (
          <Row
            key={a.name}
            glyph={a.name.slice(0, 2).toUpperCase()}
            name={a.name}
            why={a.note ?? (a.state === 'running' ? 'Extracting and mapping…' : '')}
            status={<Chip tone={AGENT_CHIP[a.state]}>{a.state}</Chip>}
          />
        ))}
      </Panel>

      {lines.length > 0 && (
        <Panel>
          <PanelHead title="Log" sub="Exactly what the server reported, in order." />
          <div className="v2-log" ref={logRef}>
            {lines.map((l, i) => (
              <div className={`ln ${l.level}`} key={`${i}-${l.msg}`}>
                <span className="m" aria-hidden="true">
                  {l.level === 'ok' ? '✓' : l.level === 'warn' ? '!' : l.level === 'fail' ? '×' : '·'}
                </span>
                <span>{l.msg}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <WizardFooter
        onBack={() => navigate(`/v2/connectors?${params.toString()}`)}
        onNext={() => navigate(`/v2/report?${params.toString()}`)}
        nextLabel="See the report"
        blocked={!finished}
        note={finished ?? (running ? 'Run in progress' : 'Run the migration to get a report')}
      />
    </>
  );

  const inspector = (
    <Inspector>
      <InspectorHead
        kind="Run"
        title={running ? 'In progress' : finished ? 'Finished' : 'Not started'}
        status={running ? <Chip tone="run">running</Chip> : finished ? <Chip tone="ok">finished</Chip> : <Chip>idle</Chip>}
      />
      <InspectorSection title="This run">
        <dl>
          <KeyValue k="Mode" v={dryRun === 'dry' ? 'dry run' : 'live'} />
          <KeyValue k="Agents" v={planned || agents.length} />
          <KeyValue k="Done" v={done} />
          <KeyValue k="Failed" v={failed} />
        </dl>
      </InspectorSection>
      <InspectorSection title="What a run does">
        <Note>Phase 1 reads each agent from Dataverse and stages it in the database.</Note>
        <Note>Phase 2 creates, publishes, shares and then smoke-tests it in Gemini.</Note>
        <Note tone="ok">
          Staging in between is why a failed run can be retried without re-reading the source.
        </Note>
        {failed > 0 && (
          <Note tone="bad">
            A failure here does not roll back what already succeeded. Re-run when the cause is
            fixed — agents already created are matched by name, not duplicated.
          </Note>
        )}
      </InspectorSection>
      {agent.ledger.length > 0 && (
        <InspectorSection title="What the agent did">
          {agent.ledger.slice(-12).map((l, i) => (
            <div className={`v2-ldg ${l.state === 'ok' ? '' : l.state}`} key={`${i}-${l.text}`}>
              <span className="m" aria-hidden="true">
                {l.state === 'ok' ? '✓' : l.state === 'live' ? '◍' : l.state === 'stop' ? '◉' : '!'}
              </span>
              <span>{l.text}</span>
            </div>
          ))}
        </InspectorSection>
      )}
    </Inspector>
  );

  return (
    <V2Layout
      phase="migrate"
      phaseStatus={{
        connect: { state: 'done' },
        'pair-envs': { state: 'done' },
        'map-users': { state: 'done' },
        'select-agents': { state: 'done' },
        review: { state: 'done' },
        connectors: { state: 'done' },
        migrate: { state: 'current', count: agents.length || undefined },
      }}
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => { stopRef.current?.(); setRunning(false); dispatch({ kind: 'idle' }); }}
      canvas={canvas}
      inspector={inspector}
    />
  );
}
