import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Chip, NoteRow, Panel, PanelHead, Select, SkeletonRows,
} from './primitives.tsx';
import { invalidateCache, markStale, primeResource, useResource } from '../../v2/data/cache.ts';
import {
  useSource, type DestOption, type EnvPair, type EnvRow, type PairSaveResult,
} from '../../v2/data/index.ts';
import { IcoCheck } from '../../icons.tsx';
import { CopilotStudioMark, GeminiMark } from './productMarks.tsx';

/**
 * Environment → Gemini app pairing, as a phase-in-place rather than a phase
 * of its own — its own distinct block on the Connect page, not merged into
 * the cards above it. The two used to share one panel with a hairline
 * divider; that read as one continuous task when it is really two: connect
 * the clouds, then decide where each environment goes. Real whitespace
 * between two distinct blocks (matching the cards' own floating-card
 * treatment) reads clearer than either one shared box or a divider line.
 *
 * One thing this screen learned from a real tenant:
 *
 *  - Nothing is re-read on mount. Walking back to this screen used to re-scan
 *    Dataverse and flicker a pairing you had just made back to "Choose project".
 *    Cached values render immediately; `Sync` is the only thing that re-reads.
 *
 * Environments with no Dataverse access (not real Copilot Studio environments —
 * nothing to extract from them) are filtered out entirely rather than shown
 * folded away: a list should be about what you can actually act on.
 */
export function EnvPairing({ session, onChange, found }: {
  session: string;
  onChange?: (paired: number, total: number) => void;
  /** Counts discovered on Connect — shown in this panel's header now that the
   *  "This migration" summary strip above the cards is gone; there is nowhere
   *  else left to say how much was found. */
  found?: { environments: number; agents: number; topics: number };
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
  /**
   * What the server made of the pairing, once it had it.
   *
   * Two things it has always answered and nothing ever showed: that the environments
   * disagree on a project (so the credential destination did NOT move, and a pick that
   * changed nothing looked like one that worked), and whether secrets can be written to
   * the project just chosen - which used to surface only after a token had been typed,
   * naming a project the person had not selected.
   */
  const [saveResult, setSaveResult] = useState<PairSaveResult | null>(null);

  const pairs = useMemo<EnvPair[]>(
    () => envList.map((env) => edits[env.url]
      ?? (saved.data ?? []).find((p) => p.env === env.url)
      ?? { env: env.url }),
    [envList, edits, saved.data],
  );

  const mapped = pairs.filter((p) => p.project && p.engine);
  // Denominator is accessible environments only — one without Dataverse access
  // can never be paired, so counting it here would leave "X of Y" permanently
  // short of Y with no row left on screen to explain why.
  const pairable = envList.filter((e) => e.accessible).length;
  useEffect(() => { onChange?.(mapped.length, pairable); }, [mapped.length, pairable, onChange]);

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
      .then((r) => { setSaveError(''); setSaveResult(r); })
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
  /**
   * A cached project list is on screen AND a fresh read is still running.
   *
   * `loading` is false in this state by design — cached data renders instantly so walking
   * back through the wizard does not flicker. But the picker then looks settled while the
   * list underneath it can still change: open it early and you see one project, wait, and
   * it becomes four, because the first read fell back to just the connected project (see
   * routes/destination.ts, which unshifts it when OAuth enumeration returns nothing) and
   * the real enumeration landed afterwards. A list that grows under the cursor is a
   * correctness problem, not a cosmetic one — you can pick the wrong destination from a
   * list that had not finished. Say it is still arriving instead of implying it has.
   */
  const destsRefreshing = dests.syncing && !destsPending;
  // Named separately, not folded into one `error` string — a projects-list
  // failure surfacing as "could not read environments" pointed anyone
  // debugging it at the wrong half of this screen entirely.
  const envsError = envs.error;
  const destsError = dests.error;

  // Only ever called with accessible environments now — inaccessible ones are
  // filtered out before rendering, never shown folded away (see the file doc
  // comment above).
  const row = (env: EnvRow): JSX.Element => {
    const pair = pairs.find((p) => p.env === env.url);
    const project = destList.find((d) => d.project === pair?.project);
    return (
      <div className="v2-row" key={env.url} data-agent-target={`env:${env.url}`}>
        {/* The product, not the first two letters of the name. Every row here is a
            Copilot Studio environment being pointed at a Gemini app, and "CL"/"FI"
            said nothing about that -- the one thing this screen exists to make
            obvious is which side is which. Decorative: the environment name sits
            immediately beside it, so the mark adds no information a screen reader
            needs read out twice. */}
        <CopilotStudioMark s={22} />
        <span className="nmw">
          <span className="nm" title={env.name}>{env.name}</span>
          <span className="kind">{env.agents} agents · {env.topics} topics</span>
        </span>
        <span className="why ctl envpair-ctl">
          {/* Pairs with the Copilot Studio mark on the left: these two pickers are the
              Gemini half of the row. Marks the destination without spending a column
              on a word the panel heading already says. */}
          <GeminiMark s={18} />
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
            // Just the project's name. The seat count used to ride along here, which
            // made every option a two-part string to read past at the exact moment the
            // only question is "which project" — and seats are not what the choice turns
            // on. Nothing else in the web reads the count, so it is no longer carried.
            options={destList.filter((d) => d.engines.length > 0).map((d) => ({
              id: d.project,
              label: d.name ?? d.project,
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
          {pair?.project && pair?.engine
            ? <Chip tone="ok" icon={<IcoCheck s={9} />}>paired</Chip>
            : <Chip tone="you">not paired</Chip>}
        </span>
      </div>
    );
  };

  const usable = envList.filter((e) => e.accessible);

  return (
    <Panel>
      <PanelHead
        title="Point each environment at a Gemini app"
        sub={loading
          ? 'Reading environments…'
          : destsRefreshing ? 'Checking for more Gemini projects…' : undefined}
        actions={found && (
          <span className="found">
            <span>
              <span className="n">{found.environments}</span>
              <label>Environments</label>
            </span>
            <span>
              <span className="n">{found.agents}</span>
              <label>Agents</label>
            </span>
            <span>
              <span className="n">{found.topics}</span>
              <label>Topics</label>
            </span>
          </span>
        )}
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
      {/* Pairings ARE stored in this case — only the credential destination stayed put.
          Saying nothing let someone change a project and believe their credentials had
          followed it. */}
      {saveResult?.ambiguous && (
        <NoteRow tone="you">
          Your environments point at different Google projects, so there is no single place
          to keep this customer's credentials — they stay in
          {' '}<b>{saveResult.credentialProject || 'the project already in use'}</b>. Point every
          environment at one project to move them.
        </NoteRow>
      )}
      {saveResult && saveResult.secretAccess && !saveResult.secretAccess.ok && (
        <NoteRow tone="bad">
          {saveResult.secretAccess.detail
            ?? `Credentials cannot be stored in "${saveResult.credentialProject}" yet.`}
        </NoteRow>
      )}

      {loading && <SkeletonRows rows={3} controls />}

      {!loading && !envsError && envList.length === 0 && (
        <NoteRow>No Copilot Studio environments were visible to this admin.</NoteRow>
      )}
      {!loading && !envsError && envList.length > 0 && usable.length === 0 && (
        <NoteRow>
          {`${envList.length} environment${envList.length > 1 ? 's were' : ' was'} found, but none have Dataverse access — nothing to migrate.`}
        </NoteRow>
      )}

      {usable.map(row)}
    </Panel>
  );
}
