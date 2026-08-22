import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, Btn, Chip, Inspector, InspectorHead, InspectorSection, KeyValue, Note,
  NoteRow, Panel, PanelHead, Select, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { useSource, type DestOption, type EnvPair, type EnvRow } from '../../v2/data/index.ts';

/**
 * Environments → projects.
 *
 * Each Copilot Studio environment is pointed at one Gemini app. This is the step
 * the old wizard called "Select & Map Environments"; the name now says what it
 * does. A project with no Gemini app is offered but marked, because picking one
 * is a dead end the customer should see before they pick it, not after.
 */
export default function PairEnvsV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [dests, setDests] = useState<DestOption[]>([]);
  const [pairs, setPairs] = useState<EnvPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const load = useCallback(async (): Promise<void> => {
    if (!session) { setLoading(false); setError('no_session'); return; }
    setLoading(true);
    try {
      const [e, d, p] = await Promise.all([
        source.pair.environments(session),
        source.pair.destinations(session),
        source.pair.read(session),
      ]);
      setEnvs(e);
      setDests(d);
      // Keep a row for every environment, so an unmapped one is visibly unmapped
      // rather than missing.
      setPairs(e.map((env) => p.find((x) => x.env === env.url) ?? { env: env.url }));
      setError('');
    } catch (err) {
      setError((err as Error).message || 'environments_failed');
    } finally {
      setLoading(false);
    }
  }, [session, source]);

  useEffect(() => { void load(); }, [load]);

  const set = (env: string, patch: Partial<EnvPair>): void => {
    setPairs((prev) => prev.map((p) => (p.env === env ? { ...p, ...patch } : p)));
  };

  const mapped = pairs.filter((p) => p.project && p.engine);
  const selected = useMemo(
    () => envs.find((e) => e.url === picked) ?? envs[0] ?? null,
    [envs, picked],
  );
  const selectedPair = pairs.find((p) => p.env === selected?.url);

  const save = async (): Promise<void> => {
    await source.pair.save(session, pairs);
    setToast(`Saved ${mapped.length} pairing${mapped.length === 1 ? '' : 's'}.`);
    window.setTimeout(() => setToast(''), 2600);
  };

  const canvas = (
    <>
      <Panel>
        <Band>
          <BandCell label="Environments" value={envs.length} note="found in the tenant" />
          <BandCell label="Paired" value={mapped.length} note="ready to migrate"
            tone={mapped.length ? 'ok' : 'amber'} />
          <BandCell label="Agents in scope" value={envs.filter((e) => mapped.some((m) => m.env === e.url))
            .reduce((n, e) => n + e.agents, 0)} note="from paired environments" tone="warn" />
          <BandCell label="Unreachable" value={envs.filter((e) => !e.accessible).length}
            note="did not respond" tone={envs.some((e) => !e.accessible) ? 'bad' : 'plain'} />
        </Band>
      </Panel>

      <Panel>
        <PanelHead
          title="Point each environment at a Gemini app"
          sub="Discovered from the connected project — nothing here is hardcoded. An environment with no app is simply not migrated."
          actions={<Btn onClick={() => void load()} disabled={loading}>{loading ? 'Reading…' : 'Re-read'}</Btn>}
        />

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session' ? 'No connected session — connect both clouds first.' : `Could not read environments: ${error}`}
          </NoteRow>
        )}
        {!loading && !error && envs.length === 0 && (
          <NoteRow>No Copilot Studio environments were visible to this admin.</NoteRow>
        )}

        {envs.map((env) => {
          const pair = pairs.find((p) => p.env === env.url);
          const project = dests.find((d) => d.project === pair?.project);
          return (
            <div
              key={env.url}
              className={`v2-row${selected?.url === env.url ? ' pick' : ''}`}
              data-agent-target={`env:${env.url}`}
              role="button"
              tabIndex={0}
              onClick={() => setPicked(env.url)}
              onKeyDown={(e) => { if (e.key === 'Enter') setPicked(env.url); }}
            >
              <span className="glyph" aria-hidden="true">{env.name.slice(0, 2).toUpperCase()}</span>
              <span className="nmw">
                <span className="nm">{env.name}</span>
                <span className="kind">{env.agents} agents · {env.topics} topics</span>
              </span>
              <span className="why ctl">
                <Select
                  agentTarget={`env-project:${env.url}`}
                  value={pair?.project ?? ''}
                  placeholder="Choose project"
                  options={dests.map((d) => ({
                    id: d.project,
                    label: d.engines.length ? (d.name ?? d.project) : `${d.name ?? d.project} — no Gemini app`,
                    disabled: d.engines.length === 0,
                  }))}
                  onChange={(id) => set(env.url, { project: id, engine: undefined })}
                />
                <Select
                  agentTarget={`env-engine:${env.url}`}
                  value={pair?.engine ?? ''}
                  placeholder={project ? 'Choose app' : 'Project first'}
                  disabled={!project || project.engines.length === 0}
                  options={(project?.engines ?? []).map((e) => ({ id: e.id, label: e.displayName }))}
                  onChange={(id) => set(env.url, { engine: id })}
                />
              </span>
              <span className="st">
                {!env.accessible
                  ? <Chip tone="bad">unreachable</Chip>
                  : pair?.project && pair?.engine
                    ? <Chip tone="ok">paired</Chip>
                    : <Chip tone="you">not paired</Chip>}
              </span>
            </div>
          );
        })}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/connect?${params.toString()}`)}
        onNext={async () => { await save(); navigate(`/v2/map-users?${params.toString()}`); }}
        nextLabel="Continue to users"
        blocked={mapped.length === 0}
        note={mapped.length
          ? `${mapped.length} of ${envs.length} environments will migrate`
          : 'Pair at least one environment to continue'}
      />
    </>
  );

  const inspector = (
    <Inspector>
      {selected ? (
        <>
          <InspectorHead
            kind="Environment"
            title={selected.name}
            status={selectedPair?.engine
              ? <Chip tone="ok">paired</Chip>
              : <Chip tone="you">not paired</Chip>}
          />
          <InspectorSection title="Source">
            <dl>
              <KeyValue k="Org URL" v={selected.url.replace('https://', '')} />
              <KeyValue k="Agents" v={selected.agents} />
              <KeyValue k="Topics" v={selected.topics} />
              <KeyValue k="Reachable" v={selected.accessible ? 'yes' : 'no'} />
            </dl>
          </InspectorSection>
          <InspectorSection title="Destination">
            <dl>
              <KeyValue k="Project" v={selectedPair?.project ?? 'not chosen'} />
              <KeyValue k="Gemini app" v={selectedPair?.engine ?? 'not chosen'} />
            </dl>
          </InspectorSection>
          {!selected.accessible && (
            <InspectorSection title="Why it is unreachable">
              <Note tone="bad">
                This environment did not answer during discovery. Its counts may be stale, and
                agents in it cannot be extracted until it responds.
              </Note>
            </InspectorSection>
          )}
        </>
      ) : (
        <InspectorHead kind="Environment" title={loading ? 'Reading…' : 'Nothing selected'} />
      )}
    </Inspector>
  );

  return (
    <V2Layout
      phase="pair-envs"
      phaseStatus={{
        connect: { state: 'done' },
        'pair-envs': { state: 'current', count: `${mapped.length}/${envs.length}` },
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
