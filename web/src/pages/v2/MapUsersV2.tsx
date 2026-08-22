import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, Btn, Chip, Inspector, InspectorActions, InspectorHead, InspectorSection,
  KeyValue, Note, NoteRow, Panel, PanelHead, Select, SelectBar, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { useSource, type UserRow } from '../../v2/data/index.ts';

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

  const [rows, setRows] = useState<UserRow[]>([]);
  const [candidates, setCandidates] = useState<Array<{ email: string; name?: string }>>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const load = useCallback(async (): Promise<void> => {
    if (!session) { setLoading(false); setError('no_session'); return; }
    setLoading(true);
    try {
      const [list, cands] = await Promise.all([
        source.users.list(session),
        source.users.candidates(session, '').catch(() => []),
      ]);
      setRows(list);
      setCandidates(cands);
      setDraft({});
      setError('');
    } catch (e) {
      setError((e as Error).message || 'users_failed');
    } finally {
      setLoading(false);
    }
  }, [session, source]);

  useEffect(() => { void load(); }, [load]);

  /** The row as it stands now: saved value, or the unsaved edit on top of it. */
  const effective = (r: UserRow): { target?: string; state: UserRow['state'] } => {
    const d = draft[r.sourceId];
    if (d) return { target: d, state: 'mapped' };
    if (r.mapped) return { target: r.mapped, state: 'mapped' };
    return { target: undefined, state: r.suggested ? 'suggested' : 'unmapped' };
  };

  const mapped = rows.filter((r) => effective(r).state === 'mapped');
  const suggested = rows.filter((r) => effective(r).state === 'suggested');
  const unmapped = rows.filter((r) => effective(r).state === 'unmapped');
  const dirty = Object.keys(draft).length > 0;

  const selected = useMemo(
    () => rows.find((r) => r.sourceId === picked) ?? rows[0] ?? null,
    [rows, picked],
  );

  const save = async (): Promise<void> => {
    if (!dirty) return;
    await source.users.save(session, draft);
    setToast(`Saved ${Object.keys(draft).length} mapping(s).`);
    window.setTimeout(() => setToast(''), 2600);
    await load();
  };

  const acceptAllSuggestions = (): void => {
    // Bulk-accept is offered, but it is still an explicit act by a person — and it
    // only ever touches rows where we actually have a proposal.
    const next: Record<string, string> = { ...draft };
    for (const r of rows) if (!r.mapped && r.suggested) next[r.sourceId] = r.suggested;
    setDraft(next);
  };

  const canvas = (
    <>
      <Panel>
        <Band>
          <BandCell label="People found" value={rows.length} note="touched by your agents" />
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
          sub="Only the people your selected agents actually reference — owners, editors and shared groups. Everyone else in the tenant is irrelevant to this run."
          actions={<Btn onClick={() => void load()} disabled={loading}>{loading ? 'Reading…' : 'Re-read'}</Btn>}
        />
        <SelectBar summary={`${mapped.length} of ${rows.length} mapped`}>
          <Btn onClick={acceptAllSuggestions} disabled={suggested.length === 0}>
            Accept all {suggested.length} suggestions
          </Btn>
          <Btn onClick={() => setDraft({})} disabled={!dirty}>Undo changes</Btn>
        </SelectBar>

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session' ? 'No connected session — connect both clouds first.' : `Could not read users: ${error}`}
          </NoteRow>
        )}
        {!loading && !error && rows.length === 0 && (
          <NoteRow>Your selected agents do not reference any named person or group.</NoteRow>
        )}

        {rows.map((r) => {
          const eff = effective(r);
          const options = [
            ...candidates.map((c) => ({ id: c.email, label: c.name ? `${c.name} — ${c.email}` : c.email })),
            // Keep whatever is already chosen selectable even if it is not in the
            // candidate page we happen to have loaded.
            ...(eff.target && !candidates.some((c) => c.email === eff.target)
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
                  onChange={(id) => setDraft((d) => ({ ...d, [r.sourceId]: id }))}
                />
                {eff.state === 'suggested' && r.suggested && (
                  <Btn tone="amber" onClick={() => setDraft((d) => ({ ...d, [r.sourceId]: r.suggested as string }))}>
                    Use {r.suggested}
                  </Btn>
                )}
              </span>
              <span className="st">
                {eff.state === 'mapped'
                  ? <Chip tone={draft[r.sourceId] ? 'warn' : 'ok'}>{draft[r.sourceId] ? 'unsaved' : 'mapped'}</Chip>
                  : eff.state === 'suggested'
                    ? <Chip tone="you">suggestion</Chip>
                    : <Chip tone="bad">not mapped</Chip>}
              </span>
            </div>
          );
        })}
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
                onClick={() => setDraft((d) => ({ ...d, [selected.sourceId]: selected.suggested as string }))}>
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
        connect: { state: 'done' },
        'pair-envs': { state: 'done' },
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
