import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Btn, Chip, Fold, NoteRow, Panel, PanelHead, Select, SkeletonRows,
} from './primitives.tsx';
import { invalidateCache, markStale, primeResource, readAgo, useResource } from '../../v2/data/cache.ts';
import { useSource, type DestOption, type EnvPair, type EnvRow } from '../../v2/data/index.ts';

/**
 * Environment → Gemini app pairing, as a panel rather than a phase.
 *
 * Two things this screen learned from a real tenant:
 *
 *  - Environments with no Dataverse access are real but useless: they report 0
 *    agents and cannot be paired at all. They are folded away rather than listed
 *    first, because a list should be about what you can act on. Never removed —
 *    an environment silently missing from the list is a support ticket.
 *  - Nothing is re-read on mount. Walking back to this screen used to re-scan
 *    Dataverse and flicker a pairing you had just made back to "Choose project".
 *    Cached values render immediately; `Sync` is the only thing that re-reads.
 */
export function EnvPairing({ session, onChange }: {
  session: string;
  onChange?: (paired: number, total: number) => void;
}) {
  const source = useSource();

  const envs = useResource<EnvRow[]>(
    `envs:${session}`, () => source.pair.environments(session), Boolean(session),
  );
  const dests = useResource<DestOption[]>(
    `dests:${session}`, () => source.pair.destinations(session), Boolean(session),
  );
  const saved = useResource<EnvPair[]>(
    `pairs:${session}`, () => source.pair.read(session), Boolean(session),
  );

  const envList = envs.data ?? [];
  const destList = dests.data ?? [];

  // Local edits sit on top of what the server has, so a pairing survives this
  // component unmounting and remounting as you walk the flow.
  const [edits, setEdits] = useState<Record<string, EnvPair>>({});
  const [saveError, setSaveError] = useState('');

  const pairs = useMemo<EnvPair[]>(
    () => envList.map((env) => edits[env.url]
      ?? (saved.data ?? []).find((p) => p.env === env.url)
      ?? { env: env.url }),
    [envList, edits, saved.data],
  );

  const mapped = pairs.filter((p) => p.project && p.engine);
  useEffect(() => { onChange?.(mapped.length, envList.length); }, [mapped.length, envList.length, onChange]);

  // Saved on every edit: this panel has no footer of its own, so a Save button
  // would be a button whose absence loses the pairing on navigation.
  const set = useCallback((env: string, patch: Partial<EnvPair>): void => {
    setEdits((prev) => {
      const base = prev[env] ?? pairs.find((p) => p.env === env) ?? { env };
      const next = { ...base, ...patch };
      const all = pairs.map((p) => (p.env === env ? next : p));
      // Write through the cache, then drop what depends on it. Without this the
      // agent list keeps answering from the pairing that existed a moment ago.
      primeResource(`pairs:${session}`, all);
      invalidateCache(`agents:${session}`);
      // Stale, not gone: see saveSelection. The rail must not lose a finished
      // phase because something upstream changed.
      markStale(session, `conn:${session}`);
      void source.pair.save(session, all)
        .then(() => setSaveError(''))
        .catch(() => setSaveError('Could not save that pairing — it is set here but not stored.'));
      return { ...prev, [env]: next };
    });
  }, [pairs, session, source]);

  // ONLY the environment list decides whether there is a skeleton, because the
  // skeleton stands in for the ROWS. Gating it on the destination list as well
  // left three placeholder rows pinned above the two real environments for as
  // long as the project listing took, with the header still claiming to be
  // reading — a screen that says it is loading while showing loaded data.
  const loading = envs.loading;
  // The pickers, not the rows, are what a pending project list actually affects.
  const destsPending = dests.loading || (dests.data === undefined && !dests.error);
  const syncing = envs.syncing || dests.syncing || saved.syncing;
  const error = envs.error || dests.error;

  const row = (env: EnvRow): JSX.Element => {
    const pair = pairs.find((p) => p.env === env.url);
    const project = destList.find((d) => d.project === pair?.project);
    return (
      <div className="v2-row" key={env.url} data-agent-target={`env:${env.url}`}>
        <span className="glyph" aria-hidden="true">{env.name.slice(0, 2).toUpperCase()}</span>
        <span className="nmw">
          <span className="nm">{env.name}</span>
          <span className="kind">{env.agents} agents · {env.topics} topics</span>
        </span>
        <span className="why ctl">
          {env.accessible ? (
            <>
              <Select
                agentTarget={`env-project:${env.url}`}
                value={pair?.project ?? ''}
                // Say which thing is still being read. A disabled picker with no
                // reason reads as broken.
                placeholder={destsPending ? 'Reading projects…' : 'Choose project'}
                disabled={destsPending}
                options={destList.map((d) => ({
                  id: d.project,
                  // A project with no Gemini app is a dead end the customer should
                  // see before picking it, not after.
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
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--v2-ink-3)' }}>
              No Dataverse access, so nothing can be read from it — pairing it would do nothing.
            </span>
          )}
        </span>
        <span className="st">
          {!env.accessible
            ? <Chip tone="bad">no access</Chip>
            : pair?.project && pair?.engine
              ? <Chip tone="ok">paired</Chip>
              : <Chip tone="you">not paired</Chip>}
        </span>
      </div>
    );
  };

  const usable = envList.filter((e) => e.accessible);
  const blocked = envList.filter((e) => !e.accessible);

  return (
    <Panel>
      <PanelHead
        title="Point each environment at a Gemini app"
        sub={loading
          ? 'Reading environments…'
          : `Discovered from the connected project — nothing here is hardcoded · ${readAgo(envs.readAt)}`}
        actions={
          <>
            {syncing && <Chip tone="run">syncing</Chip>}
            <Btn
              onClick={() => { envs.sync(); dests.sync(); saved.sync(); }}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync'}
            </Btn>
          </>
        }
      />

      {error && (
        <NoteRow tone="bad">
          {error === 'no_session'
            ? 'No connected session — connect both clouds first.'
            : `Could not read environments: ${error}`}
        </NoteRow>
      )}
      {saveError && <NoteRow tone="bad">{saveError}</NoteRow>}

      {loading && <SkeletonRows rows={3} controls />}

      {!loading && !error && envList.length === 0 && (
        <NoteRow>No Copilot Studio environments were visible to this admin.</NoteRow>
      )}

      {usable.map(row)}

      {/* True, but not actionable. Folded, never dropped. */}
      {blocked.length > 0 && (
        <Fold
          title={`${blocked.length} environment${blocked.length > 1 ? 's' : ''} without Dataverse access`}
          note="cannot be read, so cannot be migrated"
          count={undefined}
        >
          {blocked.map(row)}
        </Fold>
      )}
    </Panel>
  );
}
