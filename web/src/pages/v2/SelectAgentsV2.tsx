import { useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, Btn, Chip, Group, Inspector, InspectorHead, InspectorSection, KeyValue,
  Note, NoteRow, Panel, PanelHead, SelectBar, SkeletonRows, Tick, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { readAgo, useResource } from '../../v2/data/cache.ts';
import { useSource, type AgentRow } from '../../v2/data/index.ts';

/**
 * Select agents.
 *
 * Grouped by environment because that is how a tenant is actually organised, and
 * because everything downstream (connectors, identities, the run itself) is scoped
 * per environment. The group tick is tri-state: a partly-selected environment must
 * never look fully selected.
 */
export default function SelectAgentsV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  // Cache-first. Walking back here used to re-read Dataverse and reset the
  // selection to "everything", quietly discarding the choice you had just made.
  const paired = useResource(
    `pairs:${session}`, () => source.pair.read(session), Boolean(session),
  );
  const usable = (paired.data ?? []).filter((p) => p.project && p.engine);
  const envKey = usable.map((p) => p.env).sort().join('|');
  const agents = useResource<AgentRow[]>(
    `agents:${session}:${envKey}`,
    // Only environments with a destination: an agent in an unpaired environment
    // has nowhere to go, and offering it would be offering a dead end.
    () => source.agents.list(session, usable.map((p) => p.env)),
    Boolean(session) && usable.length > 0,
  );
  const rows = agents.data ?? [];
  const pairs = usable;
  const loading = paired.loading || agents.loading;
  const syncing = paired.syncing || agents.syncing;
  const error = !session ? 'no_session' : paired.error || agents.error;

  // The saved selection wins over "everything": a selection is a decision, and a
  // remount is not a reason to throw a decision away.
  useEffect(() => {
    if (rows.length === 0) return;
    setChosen((prev) => {
      if (prev.size > 0) return prev;
      try {
        const saved: Array<{ env: string; botIds: string[] }> =
          JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
        const ids = new Set(saved.flatMap((x) => x.botIds));
        const known = rows.filter((r) => ids.has(r.botId)).map((r) => r.botId);
        if (known.length > 0) return new Set(known);
      } catch {
        /* fall through to selecting everything */
      }
      return new Set(rows.map((r) => r.botId));
    });
  }, [rows, session]);

  const byEnv = useMemo(() => {
    const m = new Map<string, AgentRow[]>();
    for (const r of rows) m.set(r.env, [...(m.get(r.env) ?? []), r]);
    return [...m.entries()];
  }, [rows]);

  const selectedRows = rows.filter((r) => chosen.has(r.botId));
  const topics = selectedRows.reduce((n, r) => n + r.topics, 0);
  const knowledge = selectedRows.reduce((n, r) => n + r.knowledge, 0);

  const selected = useMemo(
    () => rows.find((r) => r.botId === picked) ?? selectedRows[0] ?? rows[0] ?? null,
    [rows, picked, selectedRows],
  );

  const toggle = (botId: string): void => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(botId)) next.delete(botId); else next.add(botId);
    return next;
  });

  const toggleEnv = (env: string): void => setChosen((prev) => {
    const ids = rows.filter((r) => r.env === env).map((r) => r.botId);
    const all = ids.every((id) => prev.has(id));
    const next = new Set(prev);
    for (const id of ids) { if (all) next.delete(id); else next.add(id); }
    return next;
  });

  const save = async (): Promise<void> => {
    const selection = pairs.map((p) => ({
      env: p.env,
      botIds: rows.filter((r) => r.env === p.env && chosen.has(r.botId)).map((r) => r.botId),
    })).filter((s) => s.botIds.length > 0);
    await source.agents.saveSelection(session, selection);
    setToast(`${selectedRows.length} agents locked in for this run.`);
    window.setTimeout(() => setToast(''), 2600);
  };

  const canvas = (
    <>
      <Panel>
        <Band>
          <BandCell label="Selected" value={selectedRows.length} note={`of ${rows.length} available`} tone="warn" />
          {/* Dash, not zero: the topic count is not read here (see the inspector). */}
          <BandCell label="Topics" value={topics || '—'} note={topics ? 'will be compiled' : 'not counted here'} />
          <BandCell label="Knowledge" value={knowledge || '—'} note="sources to index" />
          <BandCell label="Environments" value={new Set(selectedRows.map((r) => r.env)).size}
            note="in this run" tone="ok" />
        </Band>
      </Panel>

      <Panel>
        <PanelHead
          title="Select agents"
          sub={`Grouped by environment; only environments with a Gemini app appear. Everything after this step — connectors, identities, the run — is scoped to what you pick here · ${readAgo(agents.readAt)}`}
          actions={
            <>
              {syncing && <Chip tone="run">syncing</Chip>}
              <Btn onClick={() => { paired.sync(); agents.sync(); }} disabled={syncing}>
                {syncing ? 'Syncing…' : 'Sync'}
              </Btn>
            </>
          }
        />
        <SelectBar summary={`${selectedRows.length} of ${rows.length} selected`}>
          <Btn onClick={() => setChosen(new Set(rows.map((r) => r.botId)))}>Select all</Btn>
          <Btn onClick={() => setChosen(new Set())}>Clear</Btn>
        </SelectBar>

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session' ? 'No connected session — connect both clouds first.' : `Could not read agents: ${error}`}
          </NoteRow>
        )}
        {loading && <SkeletonRows rows={5} />}

        {!loading && !error && rows.length === 0 && (
          <NoteRow>
            No agents in the paired environments. Pair an environment that has agents, or check
            that this admin can see them.
          </NoteRow>
        )}

        {byEnv.map(([env, list]) => {
          const on = list.filter((r) => chosen.has(r.botId)).length;
          const state = on === 0 ? 'off' : on === list.length ? 'on' : 'mixed';
          return (
            <Group
              key={env}
              title={list[0]?.envName ?? env}
              id={env.replace('https://', '')}
              count={`${on} of ${list.length}`}
              open={!shut.has(env)}
              onToggleOpen={() => setShut((prev) => {
                const next = new Set(prev);
                if (next.has(env)) next.delete(env); else next.add(env);
                return next;
              })}
              tick={<Tick state={state} label={`Select all in ${list[0]?.envName ?? env}`} onToggle={() => toggleEnv(env)} />}
            >
              {list.map((r) => (
                <div
                  key={r.botId}
                  className={`v2-row${chosen.has(r.botId) ? ' pick' : ''}`}
                  data-agent-target={`agent:${r.botId}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setPicked(r.botId); toggle(r.botId); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggle(r.botId); }}
                >
                  <Tick state={chosen.has(r.botId) ? 'on' : 'off'} label={r.name} onToggle={() => toggle(r.botId)} />
                  <span className="nmw">
                    <span className="nm">{r.name}</span>
                    <span className="kind">
                      {r.owner ?? 'no owner recorded'}
                      {r.topics ? ` · ${r.topics} topics` : ''}
                      {r.knowledge ? ` · ${r.knowledge} knowledge` : ''}
                    </span>
                  </span>
                  <span className="why">
                    {r.owner ? '' : 'Nobody owns this agent in Dataverse'}
                  </span>
                  <span className="st">
                    {chosen.has(r.botId) ? <Chip tone="ok">in this run</Chip> : <Chip>skipped</Chip>}
                  </span>
                  <span className="act" />
                </div>
              ))}
            </Group>
          );
        })}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/map-users?${params.toString()}`)}
        onNext={async () => { await save(); navigate(`/v2/connectors?${params.toString()}`); }}
        nextLabel="Continue to connectors"
        blocked={selectedRows.length === 0}
        note={selectedRows.length
          ? `${selectedRows.length} agents will be assessed before anything is written`
          : 'Select at least one agent'}
      />
    </>
  );

  const inspector = (
    <Inspector>
      {selected ? (
        <>
          <InspectorHead
            kind="Agent"
            title={selected.name}
            status={chosen.has(selected.botId) ? <Chip tone="ok">in this run</Chip> : <Chip>skipped</Chip>}
          />
          <InspectorSection title="Facts">
            <dl>
              <KeyValue k="Environment" v={selected.envName} />
              <KeyValue k="Owner" v={selected.owner ?? 'none recorded'} />
              <KeyValue k="Bot id" v={selected.botId} />
              {selected.topics ? <KeyValue k="Topics" v={selected.topics} /> : null}
              {selected.knowledge ? <KeyValue k="Knowledge" v={selected.knowledge} /> : null}
            </dl>
          </InspectorSection>
          {!selected.topics && (
            <InspectorSection title="Why no topic count">
              <Note>
                Knowledge counts are read from this list. Topics are not: the number of topic rows
                in Dataverse does not agree with the number that ends up staged, and until that is
                understood a topic count here would contradict the one shown later. Two numbers
                that disagree discredit each other, so this screen shows neither.
              </Note>
            </InspectorSection>
          )}
          {!selected.owner && (
            <InspectorSection title="Ownership">
              <Note tone="you">
                Dataverse records no owner, so nobody inherits this agent in Gemini either.
                That will be stated in the report rather than quietly assigned.
              </Note>
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
      phase="select-agents"
      phaseStatus={{
        'select-agents': { state: 'current', count: selectedRows.length || undefined },
      }}
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={canvas}
      inspector={inspector}
      toast={toast}
    />
  );
}
