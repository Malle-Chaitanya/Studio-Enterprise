import { useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, Btn, Chip, Inspector, InspectorActions, InspectorHead, InspectorSection,
  Fold, KeyValue, Note, NoteRow, Panel, PanelHead, Select, SelectBar, SkeletonRows, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { markProgress, readAgo, useResource } from '../../v2/data/cache.ts';
import { useSource, type CandidatePage, type UserRow } from '../../v2/data/index.ts';

/**
 * Map users.
 *
 * Deliberately plain. The earlier design showed a confidence percentage per row;
 * it was removed on purpose — a number like "82%" next to a person's name invites
 * accepting a guess without reading it, and getting an identity wrong means the
 * wrong human owns an agent. So there are exactly three states: mapped, suggested
 * (ours, unaccepted), and not mapped. A suggestion is never applied on its own.
 */
export default function MapUsersV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  // Off by default: the filtered list is the right default, but an admin hunting a
  // missing colleague must be able to see the account that was hidden.
  const [showAll, setShowAll] = useState(false);
  /** Unsaved edits, kept on top of what the server has. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  // Cache-first: walking back here must not re-read the tenant, and must not
  // blank a mapping you were part-way through making.
  //
  // Directory only — no "referenced by your agents" flag. This screen sits
  // BEFORE Select Agents in the flow, so there is never a real selection to
  // reference yet; the "referenced" split used to show a "None of your
  // selected agents name a person" message even when no agents had been
  // selected at all, which read as broken rather than as a stage of the
  // wizard. Dropping it also drops the cost that came with it — computing
  // "referenced" required one ACL read per agent (via source.users.list),
  // which is why this screen used to sit empty for tens of seconds. Who
  // actually gets migrated, and who owns what, is decided on Select Agents;
  // this screen's job is just "map the directory," full stop.
  //
  // revalidateOnMount=true: who's licensed and who's mapped can each change
  // from OUTSIDE this screen (a licence assigned in Google Admin, a pairing
  // changed on the previous screen, an override saved elsewhere) — a cached
  // answer here can be silently wrong, not just old. Cached data still
  // paints instantly; this only adds a quiet background refresh behind it.
  const dirRes = useResource<UserRow[]>(
    `users-dir:${session}`, () => source.users.directory(session), Boolean(session), true,
  );
  const cands = useResource<CandidatePage>(
    `cands:${session}:${showAll ? 'all' : 'filtered'}`,
    () => source.users.candidates(session, '', showAll),
    Boolean(session),
    true,
  );
  const rows = dirRes.data ?? [];
  const dir: CandidatePage = cands.data ?? { users: [] };
  // A skeleton only while there is genuinely nothing to show.
  const loading = rows.length === 0 && dirRes.loading;
  const error = session ? dirRes.error : 'no_session';


  /** The row as it stands now: saved value, or the unsaved edit on top of it. */
  const effective = (r: UserRow): { target?: string; state: UserRow['state'] } => {
    const d = draft[r.sourceEmail];
    if (d) return { target: d, state: 'mapped' };
    if (r.mapped) return { target: r.mapped, state: 'mapped' };
    return { target: undefined, state: r.suggested ? 'suggested' : 'unmapped' };
  };

  /**
   * SYSTEM, application users and deleted accounts.
   *
   * Dataverse records these as owners like anyone else — SYSTEM owns agents built
   * by the platform, and a deleted user leaves an id with no address. They are not
   * people and there is no Google account to map them to, so they are folded away
   * rather than listed among the humans. Folded, not dropped: SYSTEM owning an
   * agent is why that agent arrives in Gemini with no owner, and someone chasing
   * that needs to be able to find it.
   */
  const isPerson = (r: UserRow): boolean =>
    r.sourceEmail.includes('@') && !/^user:/i.test(r.sourceEmail) && r.sourceName !== 'SYSTEM';
  const people = rows.filter(isPerson);
  const nonHuman = rows.filter((r) => !isPerson(r));
  const mapped = rows.filter((r) => effective(r).state === 'mapped');
  const suggested = rows.filter((r) => effective(r).state === 'suggested');
  const unmapped = rows.filter((r) => effective(r).state === 'unmapped');
  const dirty = Object.keys(draft).length > 0;

  /**
   * The one sentence that makes the filtered directory honest.
   *
   * `licenceCheck: 'unavailable'` is the case that matters: the licence signal
   * could not be read, so NOTHING was filtered on it. Calling that "licensed
   * users" would claim a check that never ran.
   */
  const directoryLine = ((): string => {
    const f = dir.filter;
    const n = dir.users.length;
    if (!f) return `${n} destination account${n === 1 ? '' : 's'} available`;
    if (showAll) {
      const na = f.excludedNoAddress
        ? `, except ${f.excludedNoAddress} with no email address to map by`
        : '';
      return `${n} accounts — showing everything, including disabled and unlicensed${na}`;
    }
    const hidden: string[] = [];
    if (f.excludedInactive) hidden.push(`${f.excludedInactive} disabled`);
    if (f.excludedGuest) hidden.push(`${f.excludedGuest} guest`);
    if (f.licenceCheck === 'applied' && f.excludedUnlicensed) hidden.push(`${f.excludedUnlicensed} unlicensed`);
    const head = `${n} account${n === 1 ? '' : 's'} available`;
    // No hedge needed: every exclusion now has a bucket, so returned + excluded
    // closes against the unfiltered total. If a reason is ever added server-side
    // without a count, put "at least" back rather than implying a closed sum.
    const tail = hidden.length ? ` · ${hidden.join(', ')} hidden` : '';
    // Not a filter decision, so it is stated separately: these accounts have no
    // address at all, which is a fact about the directory, not about a licence.
    const none = f.excludedNoAddress
      ? ` · ${f.excludedNoAddress} with no email address to map by`
      : '';
    if (f.licenceCheck === 'unavailable') {
      return `${head}${tail}${none} · licence status could not be read, so all active users are shown`;
    }
    return `${head}${tail}${none}`;
  })();

  const selected = useMemo(
    () => rows.find((r) => r.sourceId === picked) ?? rows[0] ?? null,
    [rows, picked],
  );

  const save = async (): Promise<void> => {
    if (!dirty) return;
    await source.users.save(session, draft);
    // Recorded as an act, so the rail keeps its tick even if the user cache is
    // later dropped by an unrelated decision.
    markProgress(session, { usersMapped: mapped.length + Object.keys(draft).length });
    setToast(`Saved ${Object.keys(draft).length} mapping(s).`);
    window.setTimeout(() => setToast(''), 2600);
    // Re-read so the saved values become the baseline and `draft` can be cleared
    // without the rows appearing to lose their mapping.
    setDraft({});
    dirRes.sync();
  };

  const acceptAllSuggestions = (): void => {
    // Bulk-accept is offered, but it is still an explicit act by a person — and it
    // only ever touches rows where we actually have a proposal.
    const next: Record<string, string> = { ...draft };
    for (const r of rows) if (!r.mapped && r.suggested) next[r.sourceEmail] = r.suggested;
    setDraft(next);
  };

  /** One person. Referenced people and directory people render identically —
   *  the difference is which list they are in, not how much they are trusted. */
  const userRow = (r: UserRow): JSX.Element => {
    const eff = effective(r);
    const options = [
      ...dir.users.map((c) => ({ id: c.email, label: c.name ? `${c.name} — ${c.email}` : c.email })),
      // Keep whatever is already chosen selectable even if it is not in the
      // candidate page we happen to have loaded.
      ...(eff.target && !dir.users.some((c) => c.email === eff.target)
        ? [{ id: eff.target, label: eff.target }] : []),
    ];
    return (
      <div
        key={r.sourceId}
        className={`v2-row${selected?.sourceId === r.sourceId ? ' pick' : ''}`}
        data-agent-target={`user:${r.sourceId}`}
        role="button"
        tabIndex={0}
        onClick={() => setPicked(r.sourceId)}
        onKeyDown={(e) => { if (e.key === 'Enter') setPicked(r.sourceId); }}
      >
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
            value={eff.target ?? ''}
            placeholder="Choose the Google account"
            options={options}
            onChange={(id) => setDraft((d) => ({ ...d, [r.sourceEmail]: id }))}
          />
          {eff.state === 'suggested' && r.suggested && (
            // Label stays short so it cannot collide with the status chip; the
            // full address is in the title and in the inspector.
            <Btn
              tone="amber"
              title={`Use ${r.suggested}`}
              onClick={() => setDraft((d) => ({ ...d, [r.sourceEmail]: r.suggested as string }))}
            >
              Use suggestion
            </Btn>
          )}
        </span>
        <span className="st">
          {eff.state === 'mapped'
            ? <Chip tone={draft[r.sourceEmail] ? 'warn' : 'ok'}>{draft[r.sourceEmail] ? 'unsaved' : 'mapped'}</Chip>
            : eff.state === 'suggested'
              ? <Chip tone="you">suggestion</Chip>
              : <Chip tone="bad">not mapped</Chip>}
        </span>
      </div>
    );
  };

  const canvas = (
    <>
      <Panel>
        <Band>
          <BandCell label="In directory" value={rows.length} note="mappable in total" />
          <BandCell label="Mapped" value={mapped.length} note="will carry across" tone="ok" />
          <BandCell label="Suggested" value={suggested.length} note="waiting for you"
            tone={suggested.length ? 'amber' : 'plain'} />
          <BandCell label="Not mapped" value={unmapped.length} note="ownership will be dropped"
            tone={unmapped.length ? 'bad' : 'ok'} />
        </Band>
      </Panel>

      <Panel>
        <PanelHead
          title="Map users"
          // No manual Sync button: directory, mapping and licence state all
          // refresh automatically in the background on every visit to this
          // screen (see the revalidateOnMount resources above) — a button whose
          // only job was "go check if this went stale" is redundant once
          // staleness itself is handled.
          sub={`Who owns each agent in Gemini. Unmapped people keep nothing · ${readAgo(dirRes.readAt)}`}
        />
        <SelectBar summary={`${mapped.length} of ${rows.length} mapped`}>
          <Btn onClick={acceptAllSuggestions} disabled={suggested.length === 0}>
            Accept all {suggested.length} suggestions
          </Btn>
          <Btn onClick={() => setDraft({})} disabled={!dirty}>Undo changes</Btn>
        </SelectBar>

        {/* What the destination directory left out. Without this, a filtered list
            and a small organisation look identical, and the admin looking for a
            colleague who is not in it cannot tell which they are seeing. */}
        <div className="v2-selbar">
          <span className="big">{directoryLine}</span>
          <span className="sp">
            {dir.filter?.licenceCheck === 'unavailable' && <Chip tone="you">licence unreadable</Chip>}
            {dir.truncated && <Chip tone="warn">list truncated</Chip>}
            <Btn tone={showAll ? 'blue' : 'plain'} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Hiding nothing' : 'Show all users'}
            </Btn>
          </span>
        </div>

        {/* When most of the destination directory has no seat, the grid looks broken
            unless we say why. Three targets against seventy sources is a licensing
            fact, not a failed read. */}
        {!showAll && dir.filter?.licenceCheck === 'applied' && dir.filter.excludedUnlicensed > dir.users.length && (
          <NoteRow tone="you">
            Only {dir.users.length} destination account{dir.users.length === 1 ? '' : 's'} hold a
            Gemini seat. The other {dir.filter.excludedUnlicensed} need one assigned in Google
            Admin before they can be mapped.
          </NoteRow>
        )}

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session' ? 'No connected session — connect both clouds first.' : `Could not read users: ${error}`}
          </NoteRow>
        )}
        {loading && <SkeletonRows rows={4} controls />}

        {!loading && !error && rows.length === 0 && (
          <NoteRow>
            Nobody came back from the source tenant. Check directory read consent on the Microsoft
            app.
          </NoteRow>
        )}

        {people.map(userRow)}

        {nonHuman.length > 0 && (
          <Fold
            title={`${nonHuman.length} non-human owner${nonHuman.length > 1 ? 's' : ''}`}
            note="SYSTEM, app users and deleted accounts — nothing to map them to"
          >
            {nonHuman.map(userRow)}
          </Fold>
        )}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/pair-envs?${params.toString()}`)}
        onNext={async () => { await save(); navigate(`/v2/select-agents?${params.toString()}`); }}
        nextLabel="Continue to agents"
        note={unmapped.length
          ? `${unmapped.length} unmapped — those agents will migrate without an owner`
          : dirty ? 'Unsaved changes will be saved when you continue' : 'Everyone is mapped'}
      />
    </>
  );

  const inspector = (
    <Inspector>
      {selected ? (
        <>
          <InspectorHead
            kind="Person"
            title={selected.sourceName ?? selected.sourceEmail}
            status={(() => {
              const s = effective(selected).state;
              return s === 'mapped' ? <Chip tone="ok">mapped</Chip>
                : s === 'suggested' ? <Chip tone="you">suggestion</Chip>
                : <Chip tone="bad">not mapped</Chip>;
            })()}
          />
          <InspectorSection title="Identity">
            <dl>
              <KeyValue k="Source" v={selected.sourceEmail} />
              <KeyValue k="Destination" v={effective(selected).target ?? 'none'} />
            </dl>
          </InspectorSection>
          <InspectorSection title="Destination directory">
        <Note tone={dir.filter?.licenceCheck === 'unavailable' ? 'you' : undefined}>
          {dir.filter?.licenceCheck === 'unavailable'
            ? 'We could not read licence status from the destination, so no licence filter was applied. Some accounts listed may have no Gemini Enterprise seat.'
            : showAll
              ? 'Showing every account, including suspended ones and accounts with no Gemini seat.'
              : 'Active accounts with a Gemini Enterprise seat. Suspended, archived and unlicensed accounts are hidden — use "Show all users" to see them.'}
        </Note>
        {/* A named plan explains a short list; the word "licensed" does not. */}
        {dir.filter?.requiredPlans?.length ? (
          <Note>
            Licence filter: {dir.filter.requiredPlans.join(', ')}. An account without that plan is
            not offered, because it could not use what was migrated to it.
          </Note>
        ) : null}
        {dir.filter?.excludedNoAddress ? (
          <Note tone="you">
            {dir.filter.excludedNoAddress} account{dir.filter.excludedNoAddress === 1 ? ' has' : 's have'}
            {' '}no email address or UPN at all. Not a licence problem — there is nothing to map
            them by, so they are never offered, even with "Show all users".
          </Note>
        ) : null}
      </InspectorSection>
      <InspectorSection title="What mapping decides">
            <Note>Who owns the migrated agent in Gemini Enterprise.</Note>
            <Note>Who it is shared with, if the Copilot agent was shared with this person.</Note>
            {effective(selected).state !== 'mapped' && (
              <Note tone="bad">
                Left unmapped, the agent still migrates — but nobody inherits ownership, and
                the sharing this person had is dropped. That is recorded in the report.
              </Note>
            )}
          </InspectorSection>
          {selected.suggested && !selected.mapped && (
            <InspectorActions>
              <Btn wide tone="amber"
                onClick={() => setDraft((d) => ({ ...d, [selected.sourceEmail]: selected.suggested as string }))}>
                Use {selected.suggested}
              </Btn>
            </InspectorActions>
          )}
        </>
      ) : (
        <InspectorHead kind="Person" title={loading ? 'Reading…' : 'Nothing selected'} />
      )}
    </Inspector>
  );

  return (
    <V2Layout
      phase="map-users"
      phaseStatus={{
        'map-users': { state: 'current', count: `${mapped.length}/${rows.length}` },
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
