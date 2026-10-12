import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Btn, Group, Inspector, InspectorHead, InspectorSection, KeyValue,
  Note, NoteRow, Panel, SelectBar, SkeletonRows, Tick, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { useResource } from '../../v2/data/cache.ts';
import { useSource, type AgentRow } from '../../v2/data/index.ts';
import { IcoChevronLeft, IcoChevronRight, IcoPencil, IcoRefresh, IcoSearch } from '../../icons.tsx';
import { fetchDestinationNames, saveDestinationName } from '../../api.ts';
import { CopilotStudioMark, GeminiMark, GoogleMark, MicrosoftMark } from '../../components/v2/productMarks.tsx';

const PAGE_SIZES = [25, 50, 100, 200] as const;

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
  /** Narrows the rows on screen only — same as Map users' own search box —
   *  the selection, counts and footer note all still run over every agent. */
  const [q, setQ] = useState('');
  /** Real pagination over the flat agent list, same bottom bar as Map users
   *  (page X of Y, rows-per-page, prev/next) instead of one long internally
   *  scrolled box with no sense of how much more there is. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[1]);

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

  /**
   * The destination name, per agent — absent means "use the source name", so an
   * agent nobody renamed shows and saves exactly as it did before this existed.
   * Only edited values live in `destDrafts`; everything else reads straight from
   * the fetched overrides (or falls back to the source name), so there is no
   * "hydrate local state from an async fetch" step to get wrong.
   */
  const destRes = useResource(
    `destnames:${session}`,
    () => fetchDestinationNames(session, rows.map((r) => r.botId)),
    Boolean(session) && rows.length > 0,
  );
  const [destDrafts, setDestDrafts] = useState<Record<string, string>>({});
  const destFor = (r: AgentRow): string => destDrafts[r.botId] ?? destRes.data?.[r.botId] ?? r.name;
  const saveDestIfChanged = async (r: AgentRow): Promise<void> => {
    const value = destFor(r).trim();
    const baseline = destRes.data?.[r.botId] ?? r.name;
    if (value === baseline || !value) return;
    try {
      await saveDestinationName(session, r.botId, value);
    } catch (e) {
      setToast(`Could not save that name: ${(e as Error).message}`);
      window.setTimeout(() => setToast(''), 4600);
    }
  };
  const syncing = paired.syncing || agents.syncing;
  const error = !session ? 'no_session' : paired.error || agents.error;

  /**
   * Pre-tick ONCE per session, never again.
   *
   * This used to re-run whenever `rows` changed identity -- which a background sync
   * does on its own -- and its only guard was `prev.size > 0`. An empty selection is
   * indistinguishable from "not seeded yet" under that guard, so pressing Clear and
   * waiting for the next sync silently re-ticked every agent. Reported live: one
   * agent wanted, eighteen selected. Clearing is a decision; a refetch must not
   * overrule it.
   *
   * The saved selection still wins over "everything": a selection is a decision, and
   * a remount is not a reason to throw a decision away.
   */
  const seeded = useRef('');
  useEffect(() => {
    if (rows.length === 0 || seeded.current === session) return;
    seeded.current = session;
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

  /** Narrows what's ON SCREEN only — selection, the save payload, and the
   *  footer note all still run over every agent (`rows`), same as Map
   *  users' own search: a search can never quietly hide someone from a
   *  decision already made about them. */
  const needle = q.trim().toLowerCase();
  const searched = needle
    ? rows.filter((r) => r.name.toLowerCase().includes(needle)
      || (r.owner ?? '').toLowerCase().includes(needle))
    : rows;

  /** Resets to page 1 whenever the underlying list, search, or page size
   *  changes — page 3 of an old 90-agent list reads as page 3 of nothing
   *  once a search or directory re-read drops it to 12 agents. */
  useEffect(() => { setPage(1); }, [rows.length, q, pageSize]);
  const totalPages = Math.max(1, Math.ceil(searched.length / pageSize));
  const pageClamped = Math.min(page, totalPages);
  const pageRows = searched.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);

  /** Grouped by environment WITHIN the current page only — an environment
   *  that straddles a page boundary shows its own header again on the next
   *  page, the same tradeoff any paginated-and-grouped table makes. */
  const byEnv = useMemo(() => {
    const m = new Map<string, AgentRow[]>();
    for (const r of pageRows) m.set(r.env, [...(m.get(r.env) ?? []), r]);
    return [...m.entries()];
  }, [pageRows]);

  const selectedRows = rows.filter((r) => chosen.has(r.botId));
  const topics = selectedRows.reduce((n, r) => n + r.topics, 0);
  const knowledge = selectedRows.reduce((n, r) => n + r.knowledge, 0);

  /**
   * Only an EXPLICIT click resolves to a single agent's Facts. Falling back to
   * "whichever agent happens to be first in the list" used to fill this panel
   * with an agent nobody clicked and that was not even visible on screen —
   * confusing, because it read as a guide to the one wrong thing. No pick yet
   * means no agent is selected; the panel below shows the page's own guide
   * instead.
   */
  const selected = useMemo(
    () => (picked ? rows.find((r) => r.botId === picked) ?? null : null),
    [rows, picked],
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
    // A failed save must SAY so. This write is what the next screen's per-agent
    // decisions are keyed to, so swallowing it would hand the customer a Connectors
    // page with no Teams or Drive question on it and no reason why.
    try {
      await source.agents.saveSelection(session, selection);
    } catch (e) {
      setToast(`Could not record the selection: ${(e as Error).message}`);
      window.setTimeout(() => setToast(''), 6000);
      return;
    }
    setToast(`${selectedRows.length} agents locked in for this run.`);
    window.setTimeout(() => setToast(''), 2600);
  };

  const canvas = (
    <>
      {/* Outside the card, first — same treatment as Connect Clouds' and Map
          users' own headings (`.v2-canvas-h`): a plain page-level title +
          small description sitting directly on the canvas, not tucked inside
          a panel's own header row. */}
      <div className="v2-canvas-h">
        <h2>Select agents</h2>
        <div className="sub">Pick which agents to migrate to Gemini Enterprise.</div>
      </div>

      <Panel>
        {/* Search on the left, same shape as Map users' own search box.
            Select all / Clear / Refresh stay as the dedicated toolbar row's
            actions. "Auto Map" is Map users' own term for auto-MATCHING
            destinations — this button does something unrelated (re-reads the
            agent list from the source side), so it gets the plain name for
            what it does instead of borrowing that one's label. The "N of M
            selected" count is dropped here — it's already the first stat in
            the bottom bar below, so showing it twice was redundant. */}
        <SelectBar
          summary={
            <span className="v2-mapsearch v2-mapsearch--wide">
              <IcoSearch s={13} />
              <input
                className="v2-field"
                type="search"
                placeholder="Search agents"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search agents by name or owner"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </span>
          }
        >
          <Btn onClick={() => setChosen(new Set(rows.map((r) => r.botId)))}>Select all</Btn>
          <Btn onClick={() => setChosen(new Set())}>Clear</Btn>
          <Btn onClick={() => { paired.sync(); agents.sync(); }} disabled={syncing} title="Re-read agents from the source side">
            <span className="v2-ico-lb">
              <IcoRefresh s={13} spinning={syncing} />
              {syncing ? 'Refreshing…' : 'Refresh'}
            </span>
          </Btn>
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
        {!loading && !error && rows.length > 0 && searched.length === 0 && (
          <NoteRow>No agent matches &quot;{q}&quot;.</NoteRow>
        )}

        {!loading && !error && searched.length > 0 && (
          <div className="v2-scrollbox tight">
        {/* Same flex shape as the real rows below (checkbox + nmw + why), so these
            labels sit exactly above the columns they name instead of needing a
            hand-tuned offset that drifts the moment either side changes. */}
        {/* VENDOR marks on the headings, PRODUCT marks on the rows: the column is
            "the Microsoft side" / "the Google side", and each row then names the
            specific product moving across it (Copilot Studio -> Gemini). Both sizes
            are 16 on purpose -- the mark is a flex child ahead of `.nmw`, so a 14px
            heading mark over a 16px row mark would push the two Source columns 2px
            out of line down the whole list. */}
        <div className="v2-row v2-rowhead2 v2-row--agentsel">
          <span className="v2-rowhead2-check" aria-hidden="true" />
          <MicrosoftMark s={16} />
          <span className="nmw">Source name</span>
          <span className="why"><GoogleMark s={16} /> Destination name</span>
        </div>
        {byEnv.map(([env, list]) => {
          const on = list.filter((r) => chosen.has(r.botId)).length;
          const state = on === 0 ? 'off' : on === list.length ? 'on' : 'mixed';
          return (
            <Group
              key={env}
              title={list[0]?.envName ?? env}
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
                  className={`v2-row v2-row--agentsel${chosen.has(r.botId) ? ' pick' : ''}`}
                  data-agent-target={`agent:${r.botId}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setPicked(r.botId); toggle(r.botId); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggle(r.botId); }}
                >
                  <Tick state={chosen.has(r.botId) ? 'on' : 'off'} label={r.name} onToggle={() => toggle(r.botId)} />
                  {/* Per ROW, not just in the heading. The destination name defaults to
                      the source name, so the overwhelming case is the same string twice
                      — at which point a heading two rows up is the only thing saying
                      which column is which, and it scrolls away. */}
                  <CopilotStudioMark s={16} />
                  <span className="nmw">
                    <span className="nm">{r.name}</span>
                    <span className="kind">
                      {r.owner ?? 'no owner recorded'}
                      {r.topics ? ` · ${r.topics} topics` : ''}
                    </span>
                  </span>
                  {/* The destination name — an input always, but styled to read as
                      plain text until hovered or focused, with a pencil hint that it
                      can be changed. Defaults to the source name (see `destFor`); an
                      edit here is what mapper.ts actually names the agent in Gemini,
                      not just a label on this screen. */}
                  <span className="why">
                    <span className="v2-destname">
                      <GeminiMark s={16} />
                      <input
                        className="v2-destname-input"
                        value={destFor(r)}
                        // An <input>'s own box never sizes to its value's length on its
                        // own (CSS width:auto falls back to a fixed ~20-character box
                        // regardless of content — that was the earlier truncation bug).
                        // `size` is the real fix: it's the one thing that genuinely sizes
                        // the box to this row's own text, short or long, with no fixed
                        // width and no oversized empty box for a short name either.
                        size={Math.max(destFor(r).length, 1)}
                        onChange={(e) => setDestDrafts((d) => ({ ...d, [r.botId]: e.target.value }))}
                        onBlur={() => void saveDestIfChanged(r)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        aria-label={`Destination name for ${r.name}`}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="v2-destname-edit"
                        aria-label={`Edit destination name for ${r.name}`}
                        onClick={(e) => {
                          // Stop the row's own onClick from also firing — otherwise
                          // clicking the pencil toggled the agent's selection instead
                          // of doing the one thing this button is for.
                          e.stopPropagation();
                          const input = e.currentTarget.previousElementSibling as HTMLInputElement | null;
                          input?.focus();
                          input?.select();
                        }}
                      >
                        <IcoPencil s={11} />
                      </button>
                    </span>
                  </span>
                </div>
              ))}
            </Group>
          );
        })}
          </div>
        )}
      </Panel>

      {/* Its own strip below the table, not the table's last row — same shape
          as Map users' standalone pagination bar: real counts on the left
          (over the FULL list, not just this page), paging controls on the
          right. Zero is a real, honest count here (nothing detected), not an
          unknown — shown as 0, not a dash. */}
      {!loading && !error && rows.length > 0 && (
        <div className="v2-pagebar v2-pagebar-standalone">
          <span className="v2-pagebar-stats">
            <span>Selected agents <strong>{selectedRows.length}</strong></span>
            <span>Topics <strong>{topics}</strong></span>
            <span>Knowledge sources <strong>{knowledge}</strong></span>
          </span>
          <span className="v2-pagebar-ctl">
            <span className="v2-pagebar-of">
              Page {pageClamped} of {totalPages}
            </span>
            <label className="v2-pagebar-size">
              Rows per page
              <select
                className="v2-select"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <Btn
              className="v2-card-icon-btn"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pageClamped <= 1}
              title="Previous page"
            >
              <IcoChevronLeft s={13} />
            </Btn>
            <Btn
              className="v2-card-icon-btn"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={pageClamped >= totalPages}
              title="Next page"
            >
              <IcoChevronRight s={13} />
            </Btn>
          </span>
        </div>
      )}

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
          <InspectorHead kind="Agent" title={selected.name} />
          <InspectorSection title="Facts">
            <dl>
              <KeyValue k="Environment" v={selected.envName} />
              <KeyValue k="Owner" v={selected.owner ?? 'none recorded'} />
              {selected.topics ? <KeyValue k="Topics" v={selected.topics} /> : null}
              {selected.knowledge ? <KeyValue k="Knowledge" v={selected.knowledge} /> : null}
            </dl>
          </InspectorSection>
          {!selected.owner && (
            <InspectorSection title="Ownership">
              <Note tone="you">
                Dataverse records no owner, so nobody inherits this agent in Gemini either.
                That will be stated in the report rather than quietly assigned.
              </Note>
            </InspectorSection>
          )}
          <InspectorSection title="What happens if you pick this agent">
            <Note>Read from Microsoft Copilot Studio, including its name, topics, and knowledge sources.</Note>
            <Note>Re-created in Google Gemini Enterprise under the same name.</Note>
            <Note tone="ok">Anything that can't carry over is flagged on the next screen, before the run starts.</Note>
          </InspectorSection>
        </>
      ) : loading ? (
        <InspectorHead kind="Agent" title="Reading…" />
      ) : (
        <>
          <InspectorHead kind="Phase" title="Select agents" />
          <InspectorSection title="Overview">
            <dl>
              <KeyValue k="Total agents" v={rows.length} />
              <KeyValue k="Selected" v={selectedRows.length} />
              <KeyValue k="Topics" v={topics} />
              <KeyValue k="Knowledge sources" v={knowledge} />
            </dl>
          </InspectorSection>
          <InspectorSection title="How this works">
            <Note>Pick which agents move to Gemini Enterprise. Click a row to see its details here.</Note>
            <Note tone="ok">Nothing is written until you continue.</Note>
          </InspectorSection>
        </>
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
