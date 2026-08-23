import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { FidelityCard, FidelityDetail, useFidelity, worstVerdict } from '../../components/v2/fidelity.tsx';
import { readCache, useResource } from '../../v2/data/cache.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, BandRule, Btn, Chip, Inspector, InspectorHead, InspectorSection, KeyValue,
  Ledger, Note, NoteRow, Panel, PanelHead, Row, Toggle, WizardFooter, type ChipTone,
} from '../../components/v2/primitives.tsx';
import {
  useSource, type RunAgent, type RunHandoff, type RunLine,
} from '../../v2/data/index.ts';

const AGENT_CHIP: Record<RunAgent['state'], ChipTone> = {
  queued: 'plain', running: 'run', staged: 'ok', created: 'warn', verified: 'ok', failed: 'bad',
};

/**
 * The four evidence verdicts, in the words a customer needs.
 *
 * `prose_only` is not a pass: the agent talked, nothing was proven to run. And
 * `not_probed` is a check nobody has done, which is why neither is green.
 */
const EVIDENCE_LABEL: Record<NonNullable<RunAgent['evidence']>['verdict'], string> = {
  tools_confirmed: 'its own tools ran and returned data',
  wrong_agent_tools: 'answered using another agent’s tools',
  prose_only: 'replied in prose — no tool was proven to run',
  not_probed: 'not probed — nothing was checked',
};

const EVIDENCE_TONE: Record<NonNullable<RunAgent['evidence']>['verdict'], 'ok' | 'bad' | 'you'> = {
  tools_confirmed: 'ok', wrong_agent_tools: 'bad', prose_only: 'you', not_probed: 'you',
};

/** What each state is allowed to say. "created" must not read as success. */
const AGENT_LABEL: Record<RunAgent['state'], string> = {
  queued: 'queued', running: 'running',
  // Staged is a SUCCESS for a dry run: the agent was read and mapped, and nothing
  // was written because nothing was supposed to be.
  staged: 'staged · nothing written',
  created: 'created · unverified',
  verified: 'verified', failed: 'failed',
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
  /**
   * We attached to a run that was already going, rather than starting it.
   *
   * The log is not rebuilt from anything this browser wrote down: the server owns
   * the run and replays every event we missed when we attach. One copy of the
   * transcript, held where the run is.
   */
  const [rejoined, setRejoined] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  /** Set when the server stopped and asked for a human. Cleared on the next run,
   *  because a stale handoff tells someone to act on something already dealt with. */
  const [awaiting, setAwaiting] = useState<RunHandoff | null>(null);
  /** The event stream dropped. Distinct from a failed run. */
  const [streamLost, setStreamLost] = useState(false);
  /** Seconds since the run started with nothing heard back, so silence is visibly
   *  silence rather than an unexplained 0%. */
  const [silentFor, setSilentFor] = useState(0);
  // The fidelity assessment follows the run: Connectors is opened on demand now,
  // so this is the last screen where seeing a loss can still change a decision.
  const fid = useFidelity(session);
  /** Connectors still missing credentials. Read here because Connectors is no
   *  longer a step everyone walks — nobody would otherwise find out. */

  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);
  const stopRef = useRef<(() => void) | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Always leave the stream closed behind us — an EventSource that outlives the
  // screen keeps a server connection open for a run nobody is watching.
  useEffect(() => () => stopRef.current?.(), []);

  // Count the silence. Reset by any line arriving, so this only ever shows how
  // long we have genuinely heard nothing.
  useEffect(() => {
    if (!running) return;
    setSilentFor(0);
    const id = window.setInterval(() => setSilentFor((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running, lines.length, pct]);

  useEffect(() => {
    // Follow the tail only while the run is live, so reading back through the log
    // is not yanked away on every new line.
    if (running && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, running]);

  // Cached, like every other read: opening this screen must not re-scan the
  // tenant. `undefined` means we have not looked — never "all clear".
  const connRes = useResource(
    `conn:${session}`, () => source.connectors.scan(session), Boolean(session),
  );
  const blockers = connRes.data
    ? connRes.data.rows.filter((r) => r.state === 'needs-you').length
    : null;

  // The environment's NAME. A truncated Dataverse org URL is not information — it
  // is the same forty characters on every row with the useful part cut off.
  const envName = useCallback((url: string): string => {
    const envs = readCache<{ value: Array<{ name: string; url: string }> }>(`envs:${session}`)?.value;
    // No name means we have not read the environment list in this session. Return
    // empty and render nothing: "this environment" looked like an answer.
    return envs?.find((e) => e.url === url)?.name ?? '';
  }, [session]);

  const planned = useMemo(() => {
    try {
      const selection: Array<{ env: string; botIds: string[] }> =
        JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
      return selection.reduce((n, s) => n + s.botIds.length, 0);
    } catch {
      return 0;
    }
  }, [session]);

  /**
   * Attach to the run's stream.
   *
   * Separate from starting one, because those are now genuinely different acts:
   * the server owns the run in a registry, so attaching replays what we missed and
   * joins the live tail. It used to be that opening the stream WAS starting a run,
   * which is why coming back to this screen re-executed the whole migration.
   */
  const attach = useCallback((): void => {
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
      // A real tool call. This is the ONLY thing that moves the cursor during a
      // run — an unresolvable target is ignored by DrivingLayer, so a hint the
      // screen cannot honour costs nothing.
      if (u.step) {
        dispatch(u.step.phase === 'start'
          ? { kind: 'tool_start', tool: u.step.tool, target: u.step.target, note: u.step.msg }
          : { kind: 'tool_end', tool: u.step.tool, target: u.step.target,
              // ok stays the plain boolean; outcome carries the middle state. An
              // unknown verify is amber in the ledger, never a tick and never red.
              ok: u.step.ok !== false, outcome: u.step.outcome, note: u.step.msg });
      }
      if (u.handoff) {
        // The run has stopped and needs a person. Amber, and the reason is kept so
        // the screen can say what is being asked rather than just that something is.
        setAwaiting(u.handoff);
        setRunning(false);
        dispatch({ kind: 'awaiting_human', target: u.handoff.target, note: u.handoff.msg });
      }
      if (u.streamError) {
        // The run may still be going on the server; what died is our view of it.
        // Saying "failed" would be a claim about the migration we cannot make.
        setRunning(false);
        setStreamLost(true);
        dispatch({ kind: 'idle' });
      }
      if (u.finished) {
        setRunning(false);
        setFinished(u.finished.summary);
        setStopping(false);
        dispatch({ kind: 'done', note: u.finished.summary });
      }
    });
  }, [session, source]);

  // Rejoin a run that is already going. Covers walking back a screen and forward
  // again, and also closing the tab entirely and coming back: the run belongs to
  // the server, not to this component's lifetime.
  useEffect(() => {
    if (!session) return;
    let live = true;
    void (async () => {
      try {
        const st = await source.migrate.runState(session);
        if (!live || (st.phase !== 'running' && st.phase !== 'stopping')) return;
        setRunning(true);
        setRejoined(true);
        setStopping(st.phase === 'stopping' || Boolean(st.stopRequested));
        dispatch({ kind: 'thinking', note: 'Rejoined a run that was already going.' });
        attach();
      } catch {
        /* no run state is not an error: it just means nothing to rejoin */
      }
    })();
    return () => { live = false; };
    // Deliberately once per session: re-running this on every `attach` identity
    // change would re-attach in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, source]);

  const stop = useCallback(async (): Promise<void> => {
    setStopping(true);
    try {
      await source.migrate.stop(session);
    } catch (e) {
      setStopping(false);
      // 409 means the run already ended between rendering the button and pressing it.
      setError((e as Error).message === 'no_active_run'
        ? 'That run had already finished, so there was nothing to stop.'
        : `Could not stop the run: ${(e as Error).message}`);
    }
  }, [session, source]);

  const start = useCallback(async (): Promise<void> => {
    setLines([]);
    setAgents([]);
    setPct(0);
    setFinished(null);
    setError('');
    setRunning(true);
    setAwaiting(null);
    setStreamLost(false);
    setSilentFor(0);
    setRejoined(false);
    setStopping(false);
    dispatch({ kind: 'thinking', note: dryRun === 'dry' ? 'Dry run — nothing will be written.' : 'Migrating.' });

    // The plan POST still lands BEFORE we attach: the stream starts a run only when
    // a plan exists, and refuses with 400 `no_plan` otherwise. (It no longer EXECUTES
    // per connection — the server keeps the run in a registry — but the ordering is
    // still what makes the first attach find something to join.)
    try {
      await source.migrate.start(session, {
        dryRun: dryRun === 'dry',
        // Stated in the panel above this button. Without it the server stops
        // mid-run and waits, which for this product is a worse outcome than a
        // clearly-worded warning next to the action.
        acknowledgeAclLoss: true,
      });
    } catch (e) {
      setRunning(false);
      setError((e as Error).message || 'plan_failed');
      dispatch({ kind: 'idle' });
      return; // no plan on the server means the stream would only 400 again
    }

    attach();
  }, [session, source, dryRun, attach]);

  /**
   * Does this run invert a permission?
   *
   * The server's verdict, per agent, not a guess from knowledge counts: a public
   * website source has knowledge but no permissions to lose, and asking someone to
   * accept an exposure that is not happening is the same overclaiming in reverse.
   */
  const inverting = Object.values(fid.reviews).filter((r) => r.permissionLoss?.inverts);
  const aclInPlay = inverting.length > 0;

  const staged = agents.filter((a) => a.state === 'staged').length;
  const verified = agents.filter((a) => a.state === 'verified').length;
  // Written but unproven. Counted apart from verified, never added to it.
  const unverified = agents.filter((a) => a.state === 'created').length;
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
          {dryRun === 'dry'
            ? <BandCell label="Staged" value={staged || '—'} note="read, mapped, not written" tone="ok" />
            : <BandCell label="Verified" value={verified || '—'} note="answered a probe" tone="ok" />}
          {dryRun === 'dry'
            ? <BandCell label="Would create" value={staged || '—'} note="if you run it live" />
            : <BandCell label="Unverified" value={unverified || '—'} note="written, not proven"
              tone={unverified ? 'amber' : 'plain'} />}
          <BandCell label="Failed" value={failed || '—'} note="see the log" tone={failed ? 'bad' : 'plain'} />
          <BandCell label="Progress" value={`${Math.round(pct)}%`} note={running ? 'running' : finished ? 'finished' : 'not started'} />
        </Band>
        <BandRule pct={pct} />
      </Panel>

      <FidelityCard fid={fid} />

      {/* Before a run this screen said almost nothing: a title, a toggle and a
          button. What a person needs to see first is WHICH agents are about to be
          touched and what each one is going to cost, from the assessment already
          read for the panel on the right. */}
      {!running && !finished && fid.agents.length > 0 && (
        <Panel>
          <PanelHead
            title={`${fid.agents.length} agent${fid.agents.length > 1 ? 's' : ''} in this run`}
            sub={dryRun === 'dry'
              ? 'Each one is read from Copilot Studio and mapped. Nothing is written.'
              : 'Each one is created in Gemini Enterprise, published, shared and then probed.'}
          />
          {fid.agents.map((a) => {
            const r = fid.reviews[a.botId];
            const worst = r ? worstVerdict(r.counts) : undefined;
            return (
              <div className="v2-row" key={a.botId} data-agent-target={`agent:${a.botId}`}>
                <span className="nmw">
                  <span className="nm">{a.name}</span>
                  {envName(a.env) && <span className="kind">{envName(a.env)}</span>}
                </span>
                <span className="why">
                  {!r
                    ? (fid.unknown.includes(a.name)
                      ? 'could not be assessed — unknown, not clean'
                      : 'reading what it will cost…')
                    : worst === 'lost'
                      ? `${r.counts.lost} cannot come across`
                      : worst === 'needs-review'
                        ? `${r.counts['needs-review']} to check after`
                        : 'nothing lost'}
                </span>
                <span className="st">
                  {!r
                    ? <Chip tone="plain">{fid.unknown.includes(a.name) ? 'unknown' : 'reading'}</Chip>
                    : worst === 'lost'
                      ? <Chip tone="bad">lossy</Chip>
                      : worst === 'needs-review' ? <Chip tone="you">check</Chip> : <Chip tone="ok">clean</Chip>}
                </span>
              </div>
            );
          })}
        </Panel>
      )}

      {/* Connectors are opened on demand, so this screen has to say when something
          needs credentials — otherwise a run starts against connectors that cannot
          authenticate and every agent using them fails for a reason nobody saw. */}
      {!running && !finished && blockers !== null && blockers > 0 && (
        <Panel>
          <PanelHead
            title={`${blockers} connector${blockers > 1 ? 's' : ''} still need credentials`}
            sub="Agents that use them will migrate, but their actions will not work until the credentials are in place."
            actions={
              <Btn tone="amber" onClick={() => navigate(`/v2/connectors?${params.toString()}`)}>
                Open connectors
              </Btn>
            }
          />
        </Panel>
      )}

      <Panel>
        <PanelHead
          title={running
            ? 'Running'
            : finished
              // "Run finished" beside a column of red chips read as "finished
              // badly". A dry run that staged everything succeeded, and the title
              // should say which of the two happened.
              ? (dryRun === 'dry' && staged > 0 && failed === 0
                ? `Dry run finished — ${staged} agent${staged === 1 ? '' : 's'} ready to migrate`
                : failed > 0 ? 'Run finished with failures' : 'Run finished')
              : 'Ready to run'}
          sub={dryRun === 'dry'
            ? 'A dry run extracts and maps everything, then stops. Nothing is created, published or shared.'
            // Said once, beside the button that does it. The permission sentence is
            // only shown when the server says a permission actually inverts, and it
            // is the server's own summary rather than our paraphrase of it.
            : `This writes to Gemini Enterprise. Re-running is safe — agents are matched by name.${
              aclInPlay
                ? ` ${inverting[0].permissionLoss?.summary
                  || 'Indexed knowledge loses its source permissions: anyone who can use an agent can read what it indexed.'}${
                  inverting.length > 1 ? ` Affects ${inverting.length} agents.` : ''}`
                : ''}`}
          actions={running
            ? (
              // "Stop after this agent", never "Cancel": the stop is cooperative.
              // The agent being created finishes, the rest stay staged, and the run
              // ends as stopped. A button labelled Cancel would promise an abort
              // this cannot deliver.
              <Btn tone="plain" onClick={() => void stop()} disabled={stopping}>
                {stopping ? 'Stopping after this agent…' : 'Stop after this agent'}
              </Btn>
            )
            : (
              <Btn tone={dryRun === 'dry' ? 'blue' : 'amber'} onClick={() => void start()}>
                {dryRun === 'dry'
                  ? 'Start dry run'
                  : aclInPlay
                    ? 'Start migration and accept permission loss'
                    : 'Start migration'}
              </Btn>
            )}
        />

        {stopping && (
          <NoteRow tone="you">
            Stop requested. The agent being created right now still finishes — stopping mid-write
            would leave a half-made agent — and the rest stay staged in the database. A stopped run
            resumes from the insert without re-reading Copilot Studio.
          </NoteRow>
        )}

        {rejoined && (
          <NoteRow tone="you">
            This run was already going when you came back to this screen, so we rejoined it. Every
            line above was replayed by the server — nothing was lost by navigating away, and
            leaving never cancelled anything.
          </NoteRow>
        )}

        {streamLost && (
          <NoteRow tone="bad">
            The connection to the server dropped, so we stopped receiving progress. The run itself
            carries on — it belongs to the server, not to this page. Reload and we rejoin it,
            replaying what was missed.
          </NoteRow>
        )}

        {running && lines.length === 0 && silentFor > 6 && (
          <NoteRow tone="you">
            Started {silentFor} seconds ago and the server has not reported anything yet. Reading
            the first agent from Dataverse takes a few seconds; if this passes about a minute with
            nothing, the run is not progressing.
          </NoteRow>
        )}

        {error && (
          <NoteRow tone="bad">
            Could not start the run — {error.startsWith('no_agents_selected')
              ? 'no agents are selected. Go back to Select agents and choose at least one.'
              : error.startsWith('no_destination')
                ? 'no environment is pointed at a Gemini app. Set that on Connect.'
                : error}
          </NoteRow>
        )}

        {/* The run stopped for a person. Named reason, because "action required"
            with no subject is the thing operators learn to ignore. */}
        {awaiting && <NoteRow tone="you">{awaiting.msg}</NoteRow>}

        {!running && !finished && lines.length === 0 && (
          <>
            {/* The panel above already lists the agents and this panel's own sub
                line already says what a run does. A third sentence repeating both
                is the "too much text" — kept only for the case it alone covers,
                which is having nothing selected at all. */}
            {/* Counted from the assessment as well as the stored selection: the
                selection lives in sessionStorage, so reading it alone claimed
                "nothing selected" directly above a list of nine agents. */}
            {!planned && fid.agents.length === 0 && fid.state !== 'reading' && (
              <NoteRow tone="you">
                No agents are selected — go back to Select agents and pick some.
              </NoteRow>
            )}
            {fid.state === 'reading' && (
              <NoteRow>
                {fid.progress
                  ? `Assessing what will change: ${fid.progress.done} of ${fid.progress.total} — ${fid.progress.name}. Around five seconds each, so this takes a moment.`
                  : 'Reading the agents you selected…'}
              </NoteRow>
            )}
            {blockers === null && (
              <NoteRow tone="you">
                Connector credentials have not been checked in this session, so nothing here
                claims they are in place.
              </NoteRow>
            )}
          </>
        )}

        {agents.map((a) => (
          <Row
            key={a.name}
            // Must match the server's step target exactly, or the cursor points at
            // nothing. The id is the Copilot source id, stable across the run.
            agentTarget={a.sourceId ? `agent:${a.sourceId}` : undefined}
            glyph={a.name.slice(0, 2).toUpperCase()}
            name={a.name}
            why={a.note ?? (a.state === 'running' ? 'Extracting and mapping…' : '')}
            status={<Chip tone={AGENT_CHIP[a.state]}>{AGENT_LABEL[a.state]}</Chip>}
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
        // The fidelity report screen was removed on request, so this is the end of
        // the flow. What a run cost stays on this screen while it is here, and the
        // server keeps it per run.
        note={finished ?? (running ? 'Run in progress' : 'Nothing has run yet')}
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
          <KeyValue k="Verified" v={verified} />
          <KeyValue k="Unverified" v={unverified} />
          <KeyValue k="Failed" v={failed} />
        </dl>
      </InspectorSection>
      {/* Why we believe the ticks. `wrong_agent_tools` is the reason this exists:
          an agent that answered using someone else's tools is a failure that
          otherwise renders as a pass. */}
      {agents.some((a) => a.evidence) && (
        <InspectorSection title="Verification evidence">
          {agents.filter((a) => a.evidence).map((a) => {
            const e = a.evidence as NonNullable<RunAgent['evidence']>;
            return (
              <div className="v2-fid" key={`ev-${a.name}`}>
                <Note tone={EVIDENCE_TONE[e.verdict]}>
                  <b>{a.name}</b> — {EVIDENCE_LABEL[e.verdict]}
                </Note>
                {e.verdict === 'wrong_agent_tools' && (
                  <Note tone="bad">
                    Fired {e.unexpected.join(', ')}, which belongs to another agent. Wired here:
                    {' '}{e.expected.join(', ') || 'nothing'}.
                  </Note>
                )}
                {e.verdict === 'tools_confirmed' && e.unexpected.length > 0 && (
                  <Note tone="you">
                    Its own tools answered, but {e.unexpected.join(', ')} also fired and was never
                    wired here. Worth a look; not a swap.
                  </Note>
                )}
                {e.missing.length > 0 && e.verdict !== 'wrong_agent_tools' && (
                  <Note tone="you">Never seen: {e.missing.join(', ')}.</Note>
                )}
                {e.verdict === 'tools_confirmed' && !e.returnedData && (
                  <Note tone="you">A tool was called but returned no data.</Note>
                )}
              </div>
            );
          })}
        </InspectorSection>
      )}

      {(fid.state !== 'idle') && (
        <InspectorSection title="What migrating will change">
          <FidelityDetail fid={fid} />
        </InspectorSection>
      )}

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
          <Ledger lines={agent.ledger} limit={12} />
        </InspectorSection>
      )}
    </Inspector>
  );

  return (
    <V2Layout
      phase="migrate"
      phaseStatus={{
        connectors: blockers ? { state: 'needs-you', count: blockers } : undefined,
        migrate: { state: 'current', count: agents.length || undefined },
      }}
      agent={agent}
      manual
      // A migration is the server working, not the agent driving this page. The
      // ledger still records every step; the screen just does not pretend to be
      // under someone else's control while it happens.
      quiet
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => { stopRef.current?.(); setRunning(false); dispatch({ kind: 'idle' }); }}
      canvas={canvas}
      inspector={inspector}
    />
  );
}
