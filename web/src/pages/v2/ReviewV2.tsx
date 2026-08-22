import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, Btn, Chip, Inspector, InspectorHead, InspectorSection, KeyValue, Note,
  NoteRow, Panel, PanelHead, Row, Toggle, WizardFooter, type ChipTone,
} from '../../components/v2/primitives.tsx';
import { useSource, type AgentRow, type ReviewRow, type Verdict } from '../../v2/data/index.ts';

const VERDICT_CHIP: Record<Verdict, ChipTone> = { clean: 'ok', 'needs-review': 'you', lost: 'bad' };

/** The worst verdict present decides the row's colour: a single lost behaviour
 *  matters more than twenty clean ones, and must not be averaged away. */
function worst(counts: Record<Verdict, number>): Verdict {
  if (counts.lost > 0) return 'lost';
  if (counts['needs-review'] > 0) return 'needs-review';
  return 'clean';
}

/**
 * Review what changes — the phase that used to be missing.
 *
 * Before anything is written to Gemini, each selected agent is assessed and the
 * verdict shown: what maps cleanly, what a human will have to check afterwards,
 * and what cannot come across at all. The same facts appear in the report at the
 * end, but by then the customer has no decision left to make.
 *
 * The agent run here is one real call per agent, in order. The cursor moves when a
 * verdict arrives and not before.
 */
export default function ReviewV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [reviews, setReviews] = useState<Record<string, ReviewRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [mode, setMode] = useState<'agent' | 'manual'>('agent');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const load = useCallback(async (): Promise<void> => {
    if (!session) { setLoading(false); setError('no_session'); return; }
    setLoading(true);
    try {
      const selection: Array<{ env: string; botIds: string[] }> =
        JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
      const list = await source.agents.list(session, selection.map((s) => s.env));
      const ids = new Set(selection.flatMap((s) => s.botIds));
      setAgents(ids.size ? list.filter((a) => ids.has(a.botId)) : list);
      setError('');
    } catch (e) {
      setError((e as Error).message || 'agents_failed');
    } finally {
      setLoading(false);
    }
  }, [session, source]);

  useEffect(() => { void load(); }, [load]);

  /** Assess every agent, one real call at a time. */
  const runReview = useCallback(async (): Promise<void> => {
    if (agents.length === 0) {
      dispatch({ kind: 'done', note: 'No agents selected, so there is nothing to assess.' });
      return;
    }
    dispatch({ kind: 'thinking', note: 'Assessing each agent against Gemini…' });
    let lost = 0;
    let review = 0;

    for (const a of agents) {
      const target = `review:${a.botId}`;
      dispatch({ kind: 'tool_start', tool: 'assess_agent', target, note: `Assessing ${a.name}…` });
      try {
        const row = await source.review.assess(session, { botId: a.botId, name: a.name, env: a.env });
        setReviews((prev) => ({ ...prev, [a.botId]: row }));
        lost += row.counts.lost;
        review += row.counts['needs-review'];
        dispatch({
          kind: 'tool_end', tool: 'assess_agent', target, ok: row.counts.lost === 0,
          note: row.counts.lost
            ? `${a.name}: ${row.counts.lost} behaviour${row.counts.lost > 1 ? 's' : ''} cannot come across.`
            : row.counts['needs-review']
              ? `${a.name}: maps, with ${row.counts['needs-review']} thing${row.counts['needs-review'] > 1 ? 's' : ''} to check after.`
              : `${a.name}: maps cleanly.`,
        });
      } catch {
        dispatch({
          kind: 'tool_end', tool: 'assess_agent', target, ok: false,
          note: `Could not assess ${a.name}. It is not marked clean — it is unknown.`,
        });
      }
    }

    // The summary is counted from the verdicts that actually came back.
    dispatch(lost > 0
      ? { kind: 'awaiting_human',
          note: `${lost} behaviour${lost > 1 ? 's' : ''} will be lost across ${agents.length} agents. Read those before you continue — this is your decision, not mine.` }
      : { kind: 'done',
          note: review > 0
            ? `All ${agents.length} agents map. ${review} thing${review > 1 ? 's' : ''} will need checking after the run.`
            : `All ${agents.length} agents map cleanly.` });
  }, [agents, session, source]);

  const assessed = Object.values(reviews);
  const totals = assessed.reduce<Record<Verdict, number>>(
    (acc, r) => ({
      clean: acc.clean + r.counts.clean,
      'needs-review': acc['needs-review'] + r.counts['needs-review'],
      lost: acc.lost + r.counts.lost,
    }),
    { clean: 0, 'needs-review': 0, lost: 0 },
  );
  const lostAgents = assessed.filter((r) => r.counts.lost > 0);

  const selected = useMemo(() => {
    const a = agents.find((x) => x.botId === picked) ?? agents[0] ?? null;
    return a ? { agent: a, review: reviews[a.botId] ?? null } : null;
  }, [agents, picked, reviews]);

  const canvas = (
    <>
      <Panel>
        <Band
          aside={
            <>
              <Chip>Mode</Chip>
              <Toggle
                value={mode}
                options={[{ id: 'agent', label: 'Agent' }, { id: 'manual', label: 'Manual' }]}
                onChange={setMode}
              />
            </>
          }
        >
          <BandCell label="Assessed" value={`${assessed.length}/${agents.length}`} note="agents" tone="warn" />
          <BandCell label="Clean" value={totals.clean || '—'} note="maps as-is" tone="ok" />
          <BandCell label="Needs review" value={totals['needs-review'] || '—'} note="check after the run"
            tone={totals['needs-review'] ? 'amber' : 'plain'} />
          <BandCell label="Will be lost" value={totals.lost || '—'} note="cannot come across"
            tone={totals.lost ? 'bad' : 'plain'} />
        </Band>
      </Panel>

      <Panel>
        <PanelHead
          title="What migrating will actually do"
          sub="One assessment per agent, read from the source before anything is written. Nothing here is a prediction — it is what the extractor found."
          actions={
            <Btn tone="blue" onClick={() => void runReview()} disabled={loading || agents.length === 0}>
              {assessed.length ? 'Assess again' : 'Assess all agents'}
            </Btn>
          }
        />

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session' ? 'No connected session — connect both clouds first.' : `Could not read agents: ${error}`}
          </NoteRow>
        )}
        {!loading && !error && agents.length === 0 && (
          <NoteRow>No agents selected. Go back and pick the agents to migrate.</NoteRow>
        )}
        {!loading && agents.length > 0 && assessed.length === 0 && (
          <NoteRow>
            Not assessed yet. Run the assessment — until then this screen knows nothing about
            these agents, and says so rather than showing green ticks.
          </NoteRow>
        )}

        {agents.map((a) => {
          const r = reviews[a.botId];
          const v = r ? worst(r.counts) : null;
          return (
            <Row
              key={a.botId}
              agentTarget={`review:${a.botId}`}
              glyph={a.name.slice(0, 2).toUpperCase()}
              name={a.name}
              sub={a.envName}
              why={r
                ? r.findings.filter((f) => f.verdict !== 'clean').slice(0, 1).map((f) => f.detail).join('') || 'Everything maps'
                : 'Not assessed yet'}
              selected={selected?.agent.botId === a.botId}
              onSelect={() => setPicked(a.botId)}
              status={r
                ? <Chip tone={VERDICT_CHIP[v as Verdict]}>
                    {v === 'lost' ? `${r.counts.lost} lost` : v === 'needs-review' ? `${r.counts['needs-review']} to check` : 'clean'}
                  </Chip>
                : <Chip>unknown</Chip>}
              action={r ? <Chip tone={r.effort === 'high' ? 'bad' : r.effort === 'medium' ? 'warn' : 'ok'}>{r.effort} effort</Chip> : null}
            />
          );
        })}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/select-agents?${params.toString()}`)}
        onNext={() => navigate(`/v2/connectors?${params.toString()}`)}
        nextLabel="Continue to connectors"
        note={assessed.length === 0
          ? 'You can continue without assessing — but then nobody has seen what will be lost'
          : lostAgents.length
            ? `${lostAgents.length} agent${lostAgents.length > 1 ? 's' : ''} will lose behaviour. Continuing accepts that.`
            : 'Nothing will be lost'}
      />
    </>
  );

  const inspector = (
    <Inspector>
      {selected ? (
        <>
          <InspectorHead
            kind="Agent"
            title={selected.agent.name}
            status={selected.review
              ? <Chip tone={VERDICT_CHIP[worst(selected.review.counts)]}>
                  {worst(selected.review.counts) === 'clean' ? 'maps cleanly' : worst(selected.review.counts)}
                </Chip>
              : <Chip>not assessed</Chip>}
          />
          <InspectorSection title="Facts">
            <dl>
              <KeyValue k="Environment" v={selected.agent.envName} />
              <KeyValue k="Owner" v={selected.agent.owner ?? 'none recorded'} />
              {selected.review && <KeyValue k="Effort" v={selected.review.effort} />}
            </dl>
          </InspectorSection>

          {selected.review ? (
            <InspectorSection title={`Findings (${selected.review.findings.length})`}>
              {selected.review.findings.map((f, i) => (
                <Note key={`${i}-${f.component}`}
                  tone={f.verdict === 'lost' ? 'bad' : f.verdict === 'needs-review' ? 'you' : 'ok'}>
                  <b>{f.component}</b> — {f.detail}
                </Note>
              ))}
            </InspectorSection>
          ) : (
            <InspectorSection title="Findings">
              <Note>Nothing read yet for this agent.</Note>
            </InspectorSection>
          )}

          {agent.ledger.length > 0 && (
            <InspectorSection title="What the agent did">
              {agent.ledger.map((l, i) => (
                <div className={`v2-ldg ${l.state === 'ok' ? '' : l.state}`} key={`${i}-${l.text}`}>
                  <span className="m" aria-hidden="true">
                    {l.state === 'ok' ? '✓' : l.state === 'live' ? '◍' : l.state === 'stop' ? '◉' : '!'}
                  </span>
                  <span>{l.text}</span>
                </div>
              ))}
            </InspectorSection>
          )}
        </>
      ) : (
        <InspectorHead kind="Agent" title={loading ? 'Reading…' : 'Nothing selected'} />
      )}
    </Inspector>
  );

  return (
    <V2Layout
      phase="review"
      phaseStatus={{
        connect: { state: 'done' },
        'pair-envs': { state: 'done' },
        'map-users': { state: 'done' },
        'select-agents': { state: 'done', count: agents.length || undefined },
        review: { state: 'current', count: assessed.length ? `${assessed.length}/${agents.length}` : undefined },
      }}
      agent={agent}
      manual={mode === 'manual'}
      suggestions={['Assess every agent', 'What will be lost?']}
      onPrompt={(text) => {
        if (/assess|review|lost|check|fidelity/i.test(text)) { void runReview(); return; }
        setToast('On this screen I can assess the selected agents. Try "assess every agent".');
        window.setTimeout(() => setToast(''), 3200);
      }}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={canvas}
      inspector={inspector}
      toast={toast}
    />
  );
}
