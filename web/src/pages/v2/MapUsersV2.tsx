import { useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Btn, Chip, NoteRow, Panel, PanelHead, Select, SelectBar, SkeletonRows, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { markProgress, useResource } from '../../v2/data/cache.ts';
import { useSource, type CandidatePage, type UserRow } from '../../v2/data/index.ts';

/**
 * Map users - who owns each migrated agent in Gemini.
 *
 * Stripped to one job on 2026-08-25: fetch the licensed destination accounts, match each
 * source person to one automatically, and let a human correct any row. The band, the
 * mapping summary, Accept-all, Undo, the non-human fold, the Sync button and the whole
 * inspector are gone - they described the work instead of doing it.
 *
 * WHAT DID NOT GO, because each would break the feature silently:
 *
 *  - The per-row dropdown. Auto-matching with no correction path is a one-way door, and
 *    the failure it hides is the expensive one: alex@filefuze.co matching
 *    alex@migrationn.com when those are two different people hands agent ownership, and
 *    the knowledge attached to it, to the wrong human. The previous design refused to
 *    auto-apply for exactly that reason; auto-applying is only safe while the result
 *    stays visible and editable.
 *  - The `licence unreadable` chip. When the Discovery Engine seat read fails the server
 *    filters NOTHING and reports licenceCheck 'unavailable'. Auto-matching over that
 *    unfiltered list maps people onto accounts with no Gemini seat, and they look mapped.
 *  - The `list truncated` chip. The candidate read is capped; past the cap auto-match
 *    skips people with nothing on screen to say so.
 *  - The empty state. A directory-consent failure and an empty tenant are identical
 *    without it.
 */
/** "read 4 min ago" — vague on purpose; a timestamp implies a precision nobody needs here. */
function readAgo(at?: number): string {
  if (!at) return '';
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return 'read just now';
  if (mins < 60) return `read ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `read ${hrs} hr ago`;
}

export default function MapUsersV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [showAll, setShowAll] = useState(false);
  /** Corrections made here, on top of what the server holds. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [toast, setToast] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  /**
   * Cached, and NOT revalidated on mount.
   *
   * Both directions through the wizard remount this route, so revalidating here meant a full
   * re-read of both directories plus the licence set every time someone stepped back to fix
   * one row — roughly eight outbound calls per visit, for data that had not changed. Freshness
   * is now an explicit act (Rescan) rather than a side effect of navigation, and `readAt` puts
   * the age on screen so a stale list cannot pass for a current one.
   */
  const dirRes = useResource<UserRow[]>(
    `users-dir:${session}`, () => source.users.directory(session), Boolean(session),
  );
  const cands = useResource<CandidatePage>(
    `cands:${session}:${showAll ? 'all' : 'filtered'}`,
    () => source.users.candidates(session, '', showAll),
    Boolean(session),
  );
  const rows = dirRes.data ?? [];
  const dir: CandidatePage = cands.data ?? { users: [] };
  const loading = rows.length === 0 && dirRes.loading;
  const error = session ? dirRes.error : 'no_session';

  /**
   * SYSTEM, application users and deleted accounts. Dataverse records them as owners like
   * anyone else and there is no Google account to map them to. Dropped from this screen
   * rather than folded away: a row nobody can act on is not a decision, and counting them
   * made a finished screen read as unfinished - "3 of 78 mapped" when all 3 people were.
   */
  const isPerson = (r: UserRow): boolean =>
    r.sourceEmail.includes('@') && !/^user:/i.test(r.sourceEmail) && r.sourceName !== 'SYSTEM';
  const people = rows.filter(isPerson);

  const effective = (r: UserRow): string | undefined => draft[r.sourceEmail] ?? r.mapped;

  /**
   * Auto-match once per set of unmatched people, then persist.
   *
   * Keyed on that set rather than run on every render: revalidateOnMount re-reads the
   * directory on every visit, and re-matching on each read would overwrite a correction
   * the moment a background refresh landed behind it. Only people with NO saved mapping
   * are sent, so a decision already made is never a candidate for replacement.
   */
  const matchedFor = useRef<string>('');
  /** Set by Rescan so the next match also rebuilds the server's cached org profile. */
  const forceProfile = useRef(false);
  useEffect(() => {
    if (!session || loading || error) return;
    const unmatched = people.filter((r) => !r.mapped);
    const key = unmatched.map((r) => r.sourceEmail).sort().join(',');
    if (!unmatched.length || matchedFor.current === key) return;
    matchedFor.current = key;
    void (async () => {
      try {
        const match = await source.users.autoMatch(session, unmatched, forceProfile.current);
        forceProfile.current = false;
        if (!Object.keys(match).length) return;
        await source.users.save(session, match);
        markProgress(session, {
          usersMapped: people.filter((r) => r.mapped || match[r.sourceEmail]).length,
        });
        setToast(`Matched ${Object.keys(match).length} of ${people.length}.`);
        window.setTimeout(() => setToast(''), 2600);
        dirRes.sync();
      } catch {
        // Best-effort. A failed match leaves every row as it was and the dropdowns still
        // work; blocking the screen on it would be worse than the gap.
      }
    })();
  }, [session, loading, error, people, source, dirRes]);

  /**
   * Re-read both directories and re-run the match.
   *
   * `matchedFor` is cleared so auto-match runs again — without that the effect would see the
   * same unmatched set and skip, and Rescan would silently refresh the lists while leaving
   * the matches derived from the old ones.
   */
  const rescan = (): void => {
    matchedFor.current = '';
    forceProfile.current = true;
    dirRes.sync();
    cands.sync();
  };

  const save = async (): Promise<void> => {
    if (!Object.keys(draft).length) return;
    await source.users.save(session, draft);
    markProgress(session, { usersMapped: people.filter((r) => effective(r)).length });
    setDraft({});
    dirRes.sync();
  };

  const userRow = (r: UserRow): JSX.Element => {
    const target = effective(r);
    const options = [
      ...dir.users.map((c) => ({ id: c.email, label: c.name ? `${c.name} - ${c.email}` : c.email })),
      // Keep whatever is already chosen selectable even when it is outside the page of
      // candidates currently loaded, or opening the row would silently blank it.
      ...(target && !dir.users.some((c) => c.email === target)
        ? [{ id: target, label: target }] : []),
    ];
    return (
      <div className="v2-row mapuser" key={r.sourceId} data-agent-target={`user:${r.sourceId}`}>
        <span className="glyph" aria-hidden="true">
          {(r.sourceName ?? r.sourceEmail).slice(0, 2).toUpperCase()}
        </span>
        <span className="nmw">
          <span className="nm">{r.sourceName ?? r.sourceEmail}</span>
          <span className="kind">{r.sourceEmail}</span>
        </span>
        <span className="why ctl">
          <Select
            agentTarget={`user-target:${r.sourceId}`}
            value={target ?? ''}
            placeholder="Choose the Google account"
            options={options}
            onChange={(id) => setDraft((d) => ({ ...d, [r.sourceEmail]: id }))}
          />
        </span>
        <span className="st">
          {target ? <Chip tone="ok">mapped</Chip> : <Chip tone="bad">not matched</Chip>}
        </span>
      </div>
    );
  };

  const unmatched = people.filter((r) => !effective(r)).length;

  const canvas = (
    <>
      <Panel>
        <PanelHead title="Map users" sub="Who owns each agent in Gemini." />
        <SelectBar summary="">
          <Chip tone={dir.filter?.licenceCheck === 'unavailable' ? 'you' : 'plain'}>
            {dir.filter?.licenceCheck === 'unavailable'
              ? 'licence unreadable - list not filtered'
              : `${dir.users.length} licensed account${dir.users.length === 1 ? '' : 's'}`}
          </Chip>
          {dir.truncated && <Chip tone="warn">list truncated</Chip>}
          <Btn tone={showAll ? 'blue' : 'plain'} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Licensed only' : 'Show all users'}
          </Btn>
          {/* Earns its place now that the lists are cached: if data can be stale by design,
              the screen has to say how old it is and offer a way to refresh it. */}
          <span className="kind">{readAgo(dirRes.readAt)}</span>
          <Btn onClick={rescan} disabled={dirRes.syncing || cands.syncing}>
            {dirRes.syncing || cands.syncing ? 'Rescanning...' : 'Rescan'}
          </Btn>
        </SelectBar>

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session'
              ? 'No connected session - connect both clouds first.'
              : `Could not read users: ${error}`}
          </NoteRow>
        )}
        {loading && <SkeletonRows rows={4} controls />}
        {!loading && !error && people.length === 0 && (
          <NoteRow>
            Nobody came back from the source tenant. Check directory read consent on the
            Microsoft app.
          </NoteRow>
        )}

        {people.map(userRow)}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/pair-envs?${params.toString()}`)}
        onNext={async () => { await save(); navigate(`/v2/select-agents?${params.toString()}`); }}
        nextLabel="Continue to agents"
        note={unmatched ? `${unmatched} not matched - those agents keep no owner.` : 'Everyone has a Google account.'}
      />
    </>
  );

  return (
    <V2Layout
      phase="map-users"
      phaseStatus={{ 'map-users': { state: 'current' } }}
      agent={agent}
      manual
      suggestions={[]}
      onPrompt={() => undefined}
      onStop={() => dispatch({ kind: 'idle' })}
      canvas={canvas}
      /* No inspector: every fact this screen holds is already in the row. An empty
         panel would just reserve 300px and read as one that failed to load. */
      inspector={null}
      toast={toast}
    />
  );
}
