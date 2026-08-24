import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Chip, Fold, NoteRow, Panel, PanelHead, Select, SkeletonRows,
} from './primitives.tsx';
import { invalidateCache, markStale, primeResource, useResource } from '../../v2/data/cache.ts';
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

  // revalidateOnMount=true on both: this screen has no manual Sync button
  // anymore, so a cached empty/wrong result (an earlier slow read that hadn't
  // finished, a project list read before Google was even fully connected, an
  // engine added since) would otherwise have NO way to ever correct itself —
  // removing the escape hatch without this would make a bad cache permanent
  // instead of just annoying. `saved` (the pairing itself) is excluded: it
  // reads the customer's own in-progress edits from local storage, not a
  // discovery call — there is nothing external for it to go stale against.
  const envs = useResource<EnvRow[]>(
    `envs:${session}`, () => source.pair.environments(session), Boolean(session), true,
  );
  const dests = useResource<DestOption[]>(
    `dests:${session}`, () => source.pair.destinations(session), Boolean(session), true,
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
  //
  // Side effects run HERE, in the event handler, not inside the setEdits
  // updater below. An updater is only supposed to compute the next state —
  // React is allowed to invoke it more than once (StrictMode double-invokes
  // every updater in development specifically to catch impure ones), and a
  // sessionStorage write + cache invalidation living inside one is exactly
  // the kind of side effect that rule exists to catch. Confirmed live
  // 2026-08-24: picking a project, refreshing, and re-picking still left
  // `csge_dest_<session>` as null — the pairing looked "paired" in the UI
  // (derived from `pairs`, which already includes the in-flight edit) while
  // the actual persisted write never reliably landed.
  const set = useCallback((env: string, patch: Partial<EnvPair>): void => {
    const base = pairs.find((p) => p.env === env) ?? { env };
    const next = { ...base, ...patch };
    const all = pairs.map((p) => (p.env === env ? next : p));
    // Write through the cache, then drop what depends on it. Without this the
    // agent list keeps answering from the pairing that existed a moment ago.
    primeResource(`pairs:${session}`, all);
    invalidateCache(`agents:${session}`);
    // Map Users' licensed-account list is scoped to whichever project(s) are
    // actually paired (see pairedProjects/google-users) — a pairing change
    // changes that scope, so the candidate list must not keep answering from
    // whatever project was paired (or auto-discovered) a moment ago.
    invalidateCache(`cands:${session}:all`);
    invalidateCache(`cands:${session}:filtered`);
    // Stale, not gone: see saveSelection. The rail must not lose a finished
    // phase because something upstream changed.
    markStale(session, `conn:${session}`);
    void source.pair.save(session, all)
      .then(() => setSaveError(''))
      .catch(() => setSaveError('Could not save that pairing — it is set here but not stored.'));
    setEdits((prev) => ({ ...prev, [env]: next }));
  }, [pairs, session, source]);

  // ONLY the environment list decides whether there is a skeleton, because the
  // skeleton stands in for the ROWS. Gating it on the destination list as well
  // left three placeholder rows pinned above the two real environments for as
  // long as the project listing took, with the header still claiming to be
  // reading — a screen that says it is loading while showing loaded data.
  const loading = envs.loading;
  // The pickers, not the rows, are what a pending project list actually affects.
  const destsPending = dests.loading || (dests.data === undefined && !dests.error);
  // Named separately, not folded into one `error` string — a projects-list
  // failure surfacing as "could not read environments" pointed anyone
  // debugging it at the wrong half of this screen entirely.
  const envsError = envs.error;
  const destsError = dests.error;

  const row = (env: EnvRow): JSX.Element => {
    const pair = pairs.find((p) => p.env === env.url);
    const project = destList.find((d) => d.project === pair?.project);
    return (
      <div className="v2-row" key={env.url} data-agent-target={`env:${env.url}`}>
        <span className="glyph" aria-hidden="true">{env.name.slice(0, 2).toUpperCase()}</span>
        <span className="nmw">
          <span className="nm" title={env.name}>{env.name}</span>
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
                // Only projects that actually have a Gemini app are real choices here —
                // a project with none is not a disabled option worth scrolling past, it
                // is not a destination at all. Filtering it out of the list (rather than
                // greying it in) is the difference between "14 things to read before you
                // find the 3 that matter" and "3 things to read."
                options={destList.filter((d) => d.engines.length > 0).map((d) => ({
                  id: d.project,
                  // Seat count is undefined (not 0) when it couldn't be read — that must
                  // not be said out loud as "no seats" when it just means "couldn't verify".
                  label: d.licenseCount === undefined
                    ? (d.name ?? d.project)
                    : `${d.name ?? d.project} — ${d.licenseCount} seat${d.licenseCount === 1 ? '' : 's'}`,
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
              No Dataverse access — nothing to migrate here.
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
        sub={loading ? 'Reading environments…' : undefined}
      />

      {envsError && (
        <NoteRow tone="bad">
          {envsError === 'no_session'
            ? 'No connected session — connect both clouds first.'
            : `Could not read environments: ${envsError}`}
        </NoteRow>
      )}
      {destsError && destsError !== 'no_session' && (
        <NoteRow tone="bad">{`Could not read Google Cloud projects, so "Choose project" has nothing to list: ${destsError}`}</NoteRow>
      )}
      {saveError && <NoteRow tone="bad">{saveError}</NoteRow>}

      {loading && <SkeletonRows rows={3} controls />}

      {!loading && !envsError && envList.length === 0 && (
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
