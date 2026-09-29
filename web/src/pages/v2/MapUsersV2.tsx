import { useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Btn, Chip, Inspector, InspectorHead, InspectorSection, KeyValue, Modal, Note, NoteRow, Panel,
  SelectBar, SkeletonRows, Tick, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { markProgress, useResource } from '../../v2/data/cache.ts';
import { useSource, type CandidatePage, type UserRow } from '../../v2/data/index.ts';
import {
  IcoCheck, IcoChevronLeft, IcoChevronRight, IcoDownload, IcoFilter, IcoRefresh, IcoSearch, IcoUpload,
  IcoUsers,
} from '../../icons.tsx';

const PAGE_SIZES = [25, 50, 100, 200] as const;

/**
 * Map users - who owns each migrated agent in Gemini.
 *
 * Stripped to one job on 2026-08-25: fetch the licensed destination accounts, match each
 * source person to one automatically, and let a human correct any row. The band, the
 * mapping summary, Accept-all, Undo, the non-human fold, the Sync button and the whole
 * inspector are gone - they described the work instead of doing it.
 *
 * The correction path itself moved on 2026-09-24, not away: the inline `<select>` on
 * every row was replaced with a picker modal (click the row) to match the reference
 * design's plain text rows. The underlying invariant this screen exists to protect is
 * unchanged — a wrong auto-match (alex@filefuze.co matched to alex@migrationn.com when
 * those are two different people) still hands agent ownership to the wrong human, so
 * every row's match still has to stay visible AND correctable. It just no longer needs
 * to be an always-open input to satisfy that; a click-to-fix modal does too, with a
 * lighter row.
 *
 * WHAT ELSE DID NOT GO, because each would break the feature silently:
 *
 *  - The `licence unreadable` chip. When the Discovery Engine seat read fails the server
 *    filters NOTHING and reports licenceCheck 'unavailable'. Auto-matching over that
 *    unfiltered list maps people onto accounts with no Gemini seat, and they look mapped.
 *  - The `list truncated` chip. The candidate read is capped; past the cap auto-match
 *    skips people with nothing on screen to say so.
 *  - The empty state. A directory-consent failure and an empty tenant are identical
 *    without it.
 */

export default function MapUsersV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  /** Always licensed-only now — the "Licensed"/"All" toggle, the account
   *  count, and the read-age timestamp were removed from the toolbar as
   *  clutter, so nothing can set this true any more. Licensed-only is also
   *  the safer default the toggle used to require an explicit opt-out of. */
  const showAll = false;
  /** Narrows the rows on screen only - auto-match, counts and the footer note all
   *  still run over every person, so filtering can never hide someone from those. */
  const [q, setQ] = useState('');
  /** "All" / "Matched" / "Not matched" — same three-way split as the
   *  reference's own Source/Destination column filters, just against our
   *  mapped/unmapped status instead of waves, which this screen has no
   *  concept of. Surfaced through a single filter icon + dropdown, same
   *  interaction as the reference's column-header filter, rather than
   *  separate pill buttons sitting side by side. */
  const [rowFilter, setRowFilter] = useState<'all' | 'matched' | 'unmatched'>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  /** Real pagination instead of one long internally-scrolled list — same
   *  bottom bar as the reference (page X of Y, rows-per-page, prev/next),
   *  over our own real counts. "Selected" is deliberately not in that bar:
   *  the reference's is a bulk-action count (assign to wave), and this
   *  screen has no bulk action to attach one to — a count with nothing
   *  behind it would be decoration, not information. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[1]);
  const filterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const onClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [filterOpen]);
  /** Corrections made here, on top of what the server holds. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [toast, setToast] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);
  const csvInputRef = useRef<HTMLInputElement>(null);
  /** Import CSV now opens an explaining modal first (required columns, a real
   *  sample template, what happens on upload) instead of firing the file
   *  picker cold — same shape as the reference's own CSV-mapping dialog,
   *  over our actual two-column format. */
  const [csvModalOpen, setCsvModalOpen] = useState(false);
  /** The row currently open in the account-picker modal — click-to-fix, not an
   *  always-open `<select>` per row (see the file header for why the row still
   *  needs SOME correction path). */
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [pickQuery, setPickQuery] = useState('');
  /** Checked rows, keyed by sourceEmail (stable across a directory re-read;
   *  sourceId is not guaranteed to be). Same tri-state pattern as Select
   *  agents' `chosen` — a group header tick must never read as "all" when
   *  only some of its rows are checked. */
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const toggleChosen = (email: string): void => setChosen((s) => {
    const next = new Set(s);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

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
    const isChosen = chosen.has(r.sourceEmail);
    return (
      <button
        type="button"
        className={`v2-row mapuser${isChosen ? ' checked' : ''}`}
        key={r.sourceId}
        data-agent-target={`user:${r.sourceId}`}
        onClick={() => { setEditing(r); setPickQuery(''); }}
      >
        <Tick
          state={isChosen ? 'on' : 'off'}
          label={`Select ${r.sourceName ?? r.sourceEmail}`}
          onToggle={() => toggleChosen(r.sourceEmail)}
        />
        <span className="glyph" aria-hidden="true">
          {(r.sourceName ?? r.sourceEmail).slice(0, 2).toUpperCase()}
        </span>
        <span className="nmw">
          <span className="nm">{r.sourceName ?? r.sourceEmail}</span>
          <span className="kind">{r.sourceEmail}</span>
        </span>
        <span className="why">{target ?? <em className="muted">Not matched</em>}</span>
        <span className="st">
          {target ? <Chip tone="ok">mapped</Chip> : <Chip tone="bad">not matched</Chip>}
        </span>
      </button>
    );
  };

  const unmatched = people.filter((r) => !effective(r)).length;
  const matched = people.length - unmatched;

  const needle = q.trim().toLowerCase();
  const searched = needle
    ? people.filter((r) => (r.sourceName ?? '').toLowerCase().includes(needle)
      || r.sourceEmail.toLowerCase().includes(needle))
    : people;
  const visible = rowFilter === 'unmatched'
    ? searched.filter((r) => !effective(r))
    : rowFilter === 'matched'
      ? searched.filter((r) => effective(r))
      : searched;

  /** Whatever narrowed `visible` (search, the match-status filter) also resets
   *  the page — page 3 of an old 900-row result reads as page 3 of nothing
   *  once a search drops it to 12 rows. */
  useEffect(() => { setPage(1); }, [q, rowFilter, pageSize]);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const pageClamped = Math.min(page, totalPages);
  const pageRows = visible.slice((pageClamped - 1) * pageSize, pageClamped * pageSize);

  /** Tri-state for the page's own "select all" tick — scoped to the page, not
   *  the whole filtered set, so it reads true to what a click on it actually
   *  toggles. The toolbar's "Select all" is the separate, explicit way to
   *  grab everything the current search/filter matches, across every page. */
  const pageChosenCount = pageRows.filter((r) => chosen.has(r.sourceEmail)).length;
  const pageTickState: 'on' | 'off' | 'mixed' = pageChosenCount === 0
    ? 'off'
    : pageChosenCount === pageRows.length ? 'on' : 'mixed';
  const togglePage = (): void => setChosen((s) => {
    const next = new Set(s);
    if (pageTickState === 'on') pageRows.forEach((r) => next.delete(r.sourceEmail));
    else pageRows.forEach((r) => next.add(r.sourceEmail));
    return next;
  });

  /**
   * CSV import — two columns, source email then destination email, header row
   * optional. Only rows whose source email matches someone actually in THIS
   * tenant's directory are applied; everything else is silently wrong data
   * (a typo, a person who left, a different tenant's export) and gets
   * reported rather than written. Landing in `draft`, same as a manual pick —
   * it is not persisted until Continue, same as every other correction here.
   */
  const importCsv = async (file: File): Promise<void> => {
    const text = await file.text();
    const known = new Map(people.map((r) => [r.sourceEmail.toLowerCase(), r.sourceEmail]));
    const next: Record<string, string> = {};
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      if (cells.length < 2 || !cells[0] || !cells[1]) continue;
      const [src, dest] = cells;
      if (!src.includes('@') || !dest.includes('@')) continue; // header row or junk
      const real = known.get(src.toLowerCase());
      if (!real) { skipped += 1; continue; }
      next[real] = dest;
    }
    if (!Object.keys(next).length) {
      setToast(skipped ? `None of ${skipped} row(s) matched anyone in this tenant.` : 'No valid rows found in that CSV.');
    } else {
      setDraft((d) => ({ ...d, ...next }));
      setToast(`Matched ${Object.keys(next).length} from the CSV${skipped ? `, skipped ${skipped} unknown` : ''}.`);
    }
    window.setTimeout(() => setToast(''), 3600);
  };

  /** A real file, built from the two people actually on screen when it's clicked —
   *  not a static asset, so the sample always shows real source emails from THIS
   *  tenant instead of made-up ones nobody here recognizes. */
  const downloadSampleCsv = (): void => {
    const sample = people.slice(0, 2).map((r) => `${r.sourceEmail},destination@example.com`);
    const csv = ['Source email,Destination email', ...sample].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'user-mapping-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const canvas = (
    <>
      {/* Outside the card, same treatment as Connect Clouds' own heading
          (`.v2-canvas-h`) — a plain page-level title + small description
          sitting directly on the canvas, not the panel's own header row. */}
      <div className="v2-canvas-h">
        <h2>Map users</h2>
        <div className="sub">Match each source person to a Google account, so every migrated agent keeps the right owner.</div>
      </div>

      <Panel>

        {/* A dedicated toolbar row for search and the data actions, instead of
            packing everything into the title row. The mapped/unmatched filter
            itself lives on the column header below (`.v2-rowhead`), over the
            Destination column it actually filters — same idea as the
            reference's column-header filter icon, not a toolbar pill. */}
        <SelectBar
          summary={
            <span className="v2-mapsearch">
              <IcoSearch s={13} />
              <input
                className="v2-field"
                type="search"
                placeholder="Search users"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search people by name or email"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </span>
          }
        >
          {/* The one thing worth a chip: licences could not be read, so the
              candidate list is unfiltered — everything else that used to live
              here (the plain count, the Licensed toggle, the read-age
              timestamp) was clutter with no decision attached to it. */}
          {dir.filter?.licenceCheck === 'unavailable' && (
            <Chip tone="you">
              <span className="v2-ico-lb" title="licence unreadable - list not filtered">
                <IcoUsers s={12} />?
              </span>
            </Chip>
          )}
          {dir.truncated && <Chip tone="warn">list truncated</Chip>}
          {/* Real import, not a stub: parses source/destination pairs client-side
              and lands them in the same draft a manual pick would, validated
              against people actually in this tenant (see importCsv above). The
              file picker itself now opens behind an explaining modal instead
              of firing cold — see csvModalOpen below. */}
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importCsv(file);
              setCsvModalOpen(false);
            }}
          />
          <Btn onClick={() => setCsvModalOpen(true)} title="Import source→destination pairs from a CSV">
            <span className="v2-ico-lb"><IcoUpload s={13} />Import CSV</span>
          </Btn>
          <Btn onClick={rescan} disabled={dirRes.syncing || cands.syncing} title="Re-read both directories and re-run auto-match">
            <span className="v2-ico-lb">
              <IcoRefresh s={13} spinning={dirRes.syncing || cands.syncing} />
              {dirRes.syncing || cands.syncing ? 'Matching…' : 'Auto Map'}
            </span>
          </Btn>
          {/* A visible seam before the selection actions — Import CSV/Auto Map
              act on the data itself, Select all/Clear act on the checkboxes;
              sitting in one unbroken row of buttons read as one group of
              equally-related actions when they are really two. */}
          <span className="v2-toolbar-div" aria-hidden="true" />
          {/* Operates on the whole filtered set (`visible`), not just the page —
              the row-head tick above the table is the page-scoped version. */}
          <Btn onClick={() => setChosen(new Set(visible.map((r) => r.sourceEmail)))}>Select all</Btn>
          <Btn onClick={() => setChosen(new Set())} disabled={chosen.size === 0}>Clear</Btn>
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

        {/* Header + rows share ONE horizontal-scroll container so a narrow
            viewport scrolls them together, in sync — two independent scroll
            areas would let the columns drift apart the moment either one
            moved. `.v2-rowhead`'s widths are what `.v2-row`'s own fixed
            column widths need to line up under; a viewport too narrow for
            both scrolls the pair as a unit instead of clipping or squashing
            either one. */}
        {!loading && !error && people.length > 0 && (
          <div className="v2-tablewrap">
            {/* Column headers, same shape as the reference's SOURCE/DESTINATION
                row — the match-status filter now lives here, over the column
                it actually filters, instead of floating in the toolbar next
                to search. */}
            <div className="v2-rowhead">
              {/* Standard table UX: a header tick to select every row on the
                  current page, same as any checkbox-column table — a text
                  "Select all" button alone (still there, in the toolbar, for
                  the whole filtered set across pages) is not where anyone
                  looks first for "select what's on screen". */}
              <Tick
                state={pageTickState}
                label="Select all on this page"
                onToggle={togglePage}
              />
              <span className="v2-rowhead-src">Source</span>
              <span className="v2-rowhead-dest">
                Destination
                <div className="v2-fdd" ref={filterRef}>
                  <button
                    type="button"
                    className={`v2-fdd-trigger v2-fdd-trigger--icon${rowFilter !== 'all' ? ' active' : ''}`}
                    aria-expanded={filterOpen}
                    aria-haspopup="menu"
                    title="Filter by match status"
                    onClick={() => setFilterOpen((v) => !v)}
                  >
                    <IcoFilter s={12} />
                  </button>
                  {filterOpen && (
                    <div className="v2-fdd-menu" role="menu">
                      {([
                        ['all', 'All', people.length],
                        ['matched', 'Matched', matched],
                        ['unmatched', 'Not matched', unmatched],
                      ] as const).map(([id, label, count]) => (
                        <button
                          type="button"
                          key={id}
                          role="menuitem"
                          className={`v2-fdd-item${rowFilter === id ? ' active' : ''}`}
                          onClick={() => { setRowFilter(id); setFilterOpen(false); }}
                        >
                          <span className="v2-fdd-check">{rowFilter === id && <IcoCheck s={11} />}</span>
                          {label}
                          <span className="v2-tabcount">{count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </span>
            </div>

            {/* Bounded and scrolled IN PLACE, same as the reference: the toolbar,
                column header, pagination bar and wizard footer all stay on
                screen — only the rows themselves scroll when a page (up to
                200 rows) is taller than the viewport. Paginating already
                bounds how much there ever is to scroll; this is just what
                keeps that scroll from taking the whole page with it. */}
            <div className="v2-usersbox">
              {visible.length === 0 && (
                <NoteRow>
                  {/* The status filter (All/Matched/Not matched) narrows the search
                      just as much as the text does — a name that's a real match but
                      the wrong status (e.g. "erik" while filtered to Not matched)
                      must say so, or it reads as "no such person" instead of "not
                      with this filter on". */}
                  {needle
                    ? rowFilter === 'all'
                      ? `No one matches "${q}".`
                      : `No ${rowFilter === 'matched' ? 'matched' : 'unmatched'} person matches "${q}".`
                    : rowFilter === 'matched'
                      ? 'No one is matched yet.'
                      : 'Everyone is matched.'}
                </NoteRow>
              )}
              {pageRows.map(userRow)}
            </div>
          </div>
        )}
      </Panel>

      {/* Its own strip below the table, not the table's last row — a real gap
          and its own box so it reads as a footer summary, not one more thing
          scrolling underneath the fade at the bottom of the list. */}
      {!loading && !error && people.length > 0 && (
        <div className="v2-pagebar v2-pagebar-standalone">
          <span className="v2-pagebar-stats">
            <span>Mappings <strong>{people.length}</strong></span>
            <span>Matched <strong>{matched}</strong></span>
            <span>Unmatched <strong>{unmatched}</strong></span>
            <span>Selected <strong>{chosen.size}</strong></span>
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

      {editing && (
        <AccountPicker
          candidates={dir.users}
          current={effective(editing)}
          query={pickQuery}
          onQuery={setPickQuery}
          onPick={(id) => {
            setDraft((d) => ({ ...d, [editing.sourceEmail]: id }));
            setEditing(null);
          }}
          onClear={() => {
            setDraft((d) => ({ ...d, [editing.sourceEmail]: '' }));
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          personName={editing.sourceName ?? editing.sourceEmail}
        />
      )}

      {csvModalOpen && (
        <Modal
          label="Map users from a CSV"
          glyph={<IcoUpload s={16} />}
          title="Map users from a CSV"
          sub="Source email, destination email — one pair per row."
          onClose={() => setCsvModalOpen(false)}
          body={
            <>
              <button
                type="button"
                className="v2-csvdrop"
                onClick={() => csvInputRef.current?.click()}
              >
                <IcoUpload s={20} />
                <strong>Drop your mapping CSV here, or choose a file</strong>
                <span className="muted">UTF-8, comma-delimited</span>
              </button>
              <div className="v2-csvinfo">
                <div className="v2-csvinfo-box">
                  <h6>Required columns</h6>
                  <p>Source email, Destination email</p>
                  <button type="button" className="v2-csvinfo-link" onClick={downloadSampleCsv}>
                    <IcoDownload s={12} />Download sample CSV template
                  </button>
                </div>
                <div className="v2-csvinfo-box">
                  <h6>Before you upload</h6>
                  <ul>
                    <li>Only rows matching someone in this tenant are applied.</li>
                    <li>Unmatched or invalid rows are skipped, then reported.</li>
                  </ul>
                </div>
              </div>
            </>
          }
          footer={
            <>
              <span className="muted">Nothing is written until you continue.</span>
              <span className="sp"><Btn onClick={() => setCsvModalOpen(false)}>Cancel</Btn></span>
            </>
          }
        />
      )}

      <WizardFooter
        onBack={() => navigate(`/v2/pair-envs?${params.toString()}`)}
        onNext={async () => { await save(); navigate(`/v2/select-agents?${params.toString()}`); }}
        nextLabel="Continue to agents"
        note=""
      />
    </>
  );

  const inspector = (
    <Inspector>
      <InspectorHead
        kind="Phase"
        title="Map users"
        status={<Chip tone={unmatched === 0 ? 'ok' : 'you'}>{unmatched === 0 ? 'all matched' : 'needs you'}</Chip>}
      />
      <InspectorSection title="What we hold">
        <dl>
          <KeyValue k="Directory" v={`${people.length} people`} />
          <KeyValue k="Matched" v={matched} />
          <KeyValue k="Unmatched" v={unmatched} />
          <KeyValue k="Selected" v={chosen.size} />
        </dl>
      </InspectorSection>
      <InspectorSection title="How matching works">
        <Note>
          Each source person is matched automatically to a licensed Google account by
          name or email — click any row to fix a wrong or missing match.
        </Note>
        {dir.filter?.licenceCheck === 'unavailable' && (
          <Note tone="you">
            Licence seats could not be read, so the candidate list is unfiltered — check
            a match actually has a Gemini seat before continuing.
          </Note>
        )}
        <Note tone="ok">
          Nothing is written until you continue — corrections stay local until then.
        </Note>
      </InspectorSection>
    </Inspector>
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
      inspector={inspector}
      toast={toast}
    />
  );
}

/**
 * The row's correction path. Click-to-fix, not an always-open `<select>` — see
 * the file header for why a row still has to stay correctable even though the
 * inline dropdown is gone.
 */
function AccountPicker({
  candidates, current, query, onQuery, onPick, onClear, onClose, personName,
}: {
  candidates: CandidatePage['users'];
  current?: string;
  query: string;
  onQuery: (q: string) => void;
  onPick: (email: string) => void;
  onClear: () => void;
  onClose: () => void;
  personName: string;
}) {
  const needle = query.trim().toLowerCase();
  const list = needle
    ? candidates.filter((c) => c.email.toLowerCase().includes(needle)
      || (c.name ?? '').toLowerCase().includes(needle))
    : candidates;
  return (
    <Modal
      label={`Choose the Google account for ${personName}`}
      glyph={<IcoUsers s={16} />}
      title="Choose the Google account"
      sub={personName}
      onClose={onClose}
      body={
        <>
          <span className="v2-mapsearch v2-acctpick-search">
            <IcoSearch s={13} />
            <input
              className="v2-field"
              type="search"
              autoFocus
              placeholder="Search Google accounts"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              aria-label="Search Google accounts"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </span>
          <div className="v2-acctpick-list">
            {current && (
              <button type="button" className="v2-fdd-item" onClick={onClear}>
                <span className="v2-fdd-check" />
                <em className="muted">Clear match</em>
              </button>
            )}
            {list.length === 0 && <NoteRow>No Google account matches &quot;{query}&quot;.</NoteRow>}
            {list.map((c) => (
              <button
                type="button"
                key={c.email}
                className={`v2-fdd-item${current === c.email ? ' active' : ''}`}
                onClick={() => onPick(c.email)}
              >
                <span className="v2-fdd-check">{current === c.email && <IcoCheck s={11} />}</span>
                {c.name ? `${c.name} — ${c.email}` : c.email}
              </button>
            ))}
          </div>
        </>
      }
      footer={<Btn onClick={onClose}>Cancel</Btn>}
    />
  );
}
