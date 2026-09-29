import { useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Btn, Chip, Group, Inspector, InspectorHead, InspectorSection, KeyValue,
  Note, NoteRow, Panel, SelectBar, SkeletonRows, Tick, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { useResource } from '../../v2/data/cache.ts';
import { useSource, type AgentRow } from '../../v2/data/index.ts';
import { IcoChevronLeft, IcoChevronRight, IcoRefresh, IcoSearch } from '../../icons.tsx';

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
