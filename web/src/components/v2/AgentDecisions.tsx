import { useCallback, useEffect, useMemo, useState } from 'react';
import { Btn, Chip, Modal, Note, NoteRow, Panel, PanelHead, Select, SkeletonRows } from './primitives.tsx';
import {
  fetchDriveIdentities, fetchSelection, fetchSurfaceEquivalences,
  saveDriveIdentity, saveSurfaceDecision,
  type DriveIdentityStatus, type SurfaceEquivalence,
} from '../../api.ts';
import { IcoCheck } from '../../icons.tsx';

/**
 * The per-AGENT decisions.
 *
 * These are the two things the orchestrator refuses to guess, and the reason a
 * migrated agent can arrive with fewer tools than it mapped cleanly:
 *
 *  - a Microsoft surface with a Google equivalent (Teams -> Google Chat, Outlook ->
 *    Gmail). No recorded decision wires NO messaging tools at all, because silence
 *    must not read as consent to point an agent at a different company's mailbox.
 *  - which Google account an agent's Drive connector acts as. No account means the
 *    Drive tool is not wired, even when every Drive operation mapped exactly.
 *
 * Both were invisible in v2 until now: a live run deployed an agent whose eleven
 * Drive operations all resolved, and then shipped it without Drive, and the only
 * way anyone found out was by reading the server log.
 *
 * Kept to one line per agent — not one line per DECISION. A tenant with 30 agents
 * each needing two or three of these (Outlook mail, calendar, contacts, Drive...)
 * used to mean 30+ near-identical inline rows stacked on this one panel, which
 * stopped being scannable well before 30. Each agent gets exactly one row now,
 * with a status ("all set" / "N undecided"); the row opens a popup holding every
 * decision for that agent together, still one control per decision, same save/
 * skip/error behaviour as before — just no longer spread across the whole panel.
 */

interface Unit { env: string; envName?: string; botIds: string[] }

export function AgentDecisions({ session, driveAgentIds, nameById, live = true, onSaved }: {
  session: string;
  /**
   * Botids the connector scan saw on the Google Drive connector.
   *
   * The Drive endpoint answers for whatever ids it is asked about and does not
   * itself say who uses Drive, so the scan is what narrows it. Ids, not names: the
   * scan used to expose only names, so an agent whose display name could not be
   * resolved had no row at all and nobody could tell, and two agents sharing a name
   * collided. The scan now returns ids wherever it saw one, which is strictly more
   * often than it could name them.
   */
  driveAgentIds: string[];
  /** botId -> agent name, from the same agent list the rest of the screen uses. */
  nameById: Record<string, string>;
  /**
   * False in fixture mode. These four endpoints are called directly rather than
   * through the data seam, so without this the canned screen would fire real
   * requests and render four 401s.
   */
  live?: boolean;
  onSaved?: () => void;
}) {
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [surfaces, setSurfaces] = useState<Array<SurfaceEquivalence & { env: string }>>([]);
  const [drives, setDrives] = useState<Array<DriveIdentityStatus & { env: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /** Per-row error, keyed by row id: a domain rejection belongs next to the field
   *  that caused it, not in a banner at the top of the screen. */
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [surfaceError, setSurfaceError] = useState('');
  const [driveError, setDriveError] = useState('');
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** Which agent's popup is open, if any — null means the compact list, not a modal. */
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  /** Which rows' permission-requirement text is expanded, keyed like `rowError`.
   *  Collapsed by default — real but dense Entra-permission paragraphs on every
   *  decision made the popup read as a wall of text. The information still
   *  exists in full, one click away; it is not shortened or dropped. */
  const [openPrereq, setOpenPrereq] = useState<Record<string, boolean>>({});

  const read = useCallback(async (): Promise<void> => {
    setError('');
    try {
      // The server-side plan, not sessionStorage: the old screen read the selection
      // from the tab and so showed no decisions at all after a reload or in a new
      // tab — the worst way for a decision screen to fail, because nothing errors.
      const sel = await fetchSelection(session);
      setUnits(sel);
      // Failures are kept, not swallowed. With `.catch(() => [])` on both reads and
      // a null render on an empty result, a broken endpoint produced EXACTLY the
      // screen that means "no decisions needed" — the panel was absent, so it read
      // as "there is no such option" rather than as something failing.
      let sErr = '';
      let dErr = '';
      const surf = await Promise.all(sel.map(async (u) => {
        const rows = await fetchSurfaceEquivalences(session, u.env, u.botIds)
          .catch((e: Error) => { sErr = e.message; return []; });
        return rows.map((r) => ({ ...r, env: u.env }));
      }));
      setSurfaces(surf.flat());

      const drv = await Promise.all(sel.map(async (u) => {
        const rows = await fetchDriveIdentities(session, u.env, u.botIds)
          .catch((e: Error) => { dErr = e.message; return []; });
        return rows.map((r) => ({ ...r, env: u.env, name: nameById[r.sourceId] ?? '' }));
      }));
      setDrives(drv.flat());
      setSurfaceError(sErr);
      setDriveError(dErr);
    } catch (e) {
      setError((e as Error).message || 'read_failed');
    } finally {
      setLoading(false);
    }
  }, [session, nameById]);

  useEffect(() => { if (session && live) void read(); else setLoading(false); }, [session, live, read]);

  const surfaceRow = (s: SurfaceEquivalence & { env: string }): JSX.Element => {
    const key = `${s.sourceId}:${s.sourceConnectorId}`;
    const choice = picked[key] ?? s.decision ?? '';
    const needsEmail = Boolean(choice) && choice !== 'skip';
    const target = s.targets.find((t) => t.connectorId === choice);
    const noun = s.noun ?? 'these tools';
    const decided = s.decision !== null;
    return (
      <div className="v2-dec" key={key}>
        {/* The service name, not the agent's — the modal this now lives in is
            already titled with the agent's name, so repeating it on every one
            of its rows was pure noise, not identification. */}
        <span className="nmw">
          <span className="nm">{s.sourceName}</span>
          <span className="kind">{noun}</span>
        </span>
        <span className="ctl">
          <Select
            value={choice}
            placeholder="Undecided"
            options={[
              ...s.targets.map((t) => ({ id: t.connectorId, label: t.name })),
              // An explicit, RECORDED skip. Not the same as leaving it undecided,
              // even though both wire nothing: one is a choice we can show the
              // customer they made, the other is us never having asked.
              { id: 'skip', label: `Skip — wire no ${noun}` },
            ]}
            onChange={(id) => {
              setPicked((p) => ({ ...p, [key]: id }));
              setRowError((r) => ({ ...r, [key]: '' }));
            }}
          />
          {needsEmail && (
            <input
              className="v2-field"
              type="email"
              placeholder="account to act as"
              value={emails[key] ?? s.impersonateEmail ?? ''}
              onChange={(e) => setEmails((m) => ({ ...m, [key]: e.target.value }))}
            />
          )}
          <Btn
            disabled={!choice || busy === key || (needsEmail && !(emails[key] ?? s.impersonateEmail ?? '').trim())}
            onClick={async () => {
              setBusy(key);
              setRowError((r) => ({ ...r, [key]: '' }));
              try {
                await saveSurfaceDecision(
                  session, s.sourceId, s.sourceConnectorId, choice,
                  // Choosing a target is not enough — an agent cannot read mail
                  // without an account to read it as, and the server rejects the
                  // decision without one.
                  needsEmail ? (emails[key] ?? s.impersonateEmail ?? '').trim() : undefined,
                );
                await read();
                onSaved?.();
              } catch (e) {
                setRowError((r) => ({ ...r, [key]: (e as Error).message }));
              } finally {
                setBusy('');
              }
            }}
          >
            {busy === key ? 'Saving…' : 'Save'}
          </Btn>
        </span>
        <span className="st">
          {decided
            ? <Chip tone={s.decision === 'skip' ? 'you' : 'ok'}>{s.decision === 'skip' ? 'skipped' : 'decided'}</Chip>
            : <Chip tone="you">undecided</Chip>}
        </span>
        {target?.prerequisite && (
          <>
            <button
              type="button"
              className="v2-dec-why"
              onClick={() => setOpenPrereq((p) => ({ ...p, [key]: !p[key] }))}
              aria-expanded={Boolean(openPrereq[key])}
            >
              <span aria-hidden="true">{openPrereq[key] ? '▾' : '▸'}</span>
              {openPrereq[key] ? 'Hide required permissions' : 'Required permissions'}
            </button>
            {openPrereq[key] && <span className="pre">{target.prerequisite}</span>}
          </>
        )}
        {rowError[key] && <span className="err">{rowError[key]}</span>}
      </div>
    );
  };

  const driveRow = (d: DriveIdentityStatus & { env: string; name: string }): JSX.Element => {
    const key = `drive:${d.sourceId}`;
    const value = emails[key] ?? d.current?.email ?? d.suggestion?.email ?? '';
    const confirmed = d.current?.status === 'confirmed';
    return (
      <div className="v2-dec" key={key}>
        <span className="nmw">
          <span className="nm">Google Drive</span>
          <span className="kind">
            acts as
            {d.suggestion && !confirmed ? ` · suggested: ${d.suggestion.email}` : ''}
          </span>
        </span>
        <span className="ctl">
          <input
            className="v2-field"
            type="email"
            placeholder="Google account"
            value={value}
            onChange={(e) => setEmails((m) => ({ ...m, [key]: e.target.value }))}
          />
          <Btn
            disabled={!value.trim() || busy === key}
            onClick={async () => {
              setBusy(key);
              setRowError((r) => ({ ...r, [key]: '' }));
              try {
                await saveDriveIdentity(session, d.sourceId, value.trim());
                await read();
                onSaved?.();
              } catch (e) {
                setRowError((r) => ({ ...r, [key]: (e as Error).message }));
              } finally {
                setBusy('');
              }
            }}
          >
            {busy === key ? 'Saving…' : confirmed ? 'Change' : 'Confirm'}
          </Btn>
        </span>
        <span className="st">
          {confirmed ? <Chip tone="ok">confirmed</Chip> : <Chip tone="you">not wired</Chip>}
        </span>
        {!confirmed && <span className="pre">No skip option here — leaving this blank already counts as one.</span>}
        {rowError[key] && <span className="err">{rowError[key]}</span>}
      </div>
    );
  };

  // Only Drive-using agents are asked. The endpoint answers for ANY id it is given,
  // so without this every selected agent would be offered a Drive account it has no
  // use for.
  //
  // Matched on botid, exactly. This was a display-name comparison for as long as
  // names were the only key the scan exposed, which meant an agent whose name could
  // not be resolved silently had no row — a Drive tool dropped from the run with
  // nothing on screen to say so — and two agents sharing a name collided. The scan
  // now returns ids wherever it saw one, so the failure mode is gone rather than
  // merely visible, and the normalisation and unmatched-name notice went with it.
  const wantsDrive = new Set(driveAgentIds.filter(Boolean));
  const driveRows = drives.filter((d) => wantsDrive.has(d.sourceId));

  /**
   * One group per agent (sourceId), each carrying its own surface decisions and
   * its Drive identity if it has one — the two used to be two separate flat
   * lists; an agent needing both now gets both in the same popup, since both are
   * about the same agent's own tools.
   *
   * Order: first-seen in `surfaces`, then any Drive-only agent not already
   * covered — stable across re-renders because it does not depend on undecided
   * counts, so fixing a decision does not reshuffle the list out from under you.
   */
  const agentGroups = useMemo(() => {
    const order: string[] = [];
    const seen = new Set<string>();
    const add = (id: string): void => { if (!seen.has(id)) { seen.add(id); order.push(id); } };
    surfaces.forEach((s) => add(s.sourceId));
    driveRows.forEach((d) => add(d.sourceId));
    return order.map((id) => {
      const agentSurfaces = surfaces.filter((s) => s.sourceId === id);
      const drive = driveRows.find((d) => d.sourceId === id);
      return { id, name: agentSurfaces[0]?.agentName ?? drive?.name ?? id, surfaces: agentSurfaces, drive };
    });
  }, [surfaces, driveRows]);

  const agentUndecidedCount = (g: typeof agentGroups[number]): number =>
    g.surfaces.filter((s) => s.decision === null).length
    + (g.drive && g.drive.current?.status !== 'confirmed' ? 1 : 0);

  const openAgentGroup = agentGroups.find((g) => g.id === openAgentId) ?? null;

  const agentRow = (g: typeof agentGroups[number]): JSX.Element => {
    const n = agentUndecidedCount(g);
    const uses = [...g.surfaces.map((s) => s.sourceName), ...(g.drive ? ['Google Drive'] : [])].join(', ');
    return (
      <button
        type="button"
        className="v2-row agent-decisions"
        key={g.id}
        onClick={() => setOpenAgentId(g.id)}
        data-agent-target={`agent-decisions:${g.id}`}
      >
        <span className="glyph" aria-hidden="true">{g.name.slice(0, 2).toUpperCase()}</span>
        <span className="nmw">
          <span className="nm">{g.name}</span>
          <span className="kind">uses {uses}</span>
        </span>
        <span className="st">
          {n === 0
            ? <Chip tone="ok" icon={<IcoCheck s={9} />}>all set</Chip>
            : <Chip tone="you">{n} undecided</Chip>}
        </span>
      </button>
    );
  };

  // Only truly silent when a successful read found nothing AND nothing failed. Any
  // other combination has something to say.
  if (!loading && !error && !surfaceError && !driveError
    && surfaces.length === 0 && driveRows.length === 0) return null;

  return (
    <>
    <Panel>
      <PanelHead title="Decisions only you can make, per agent" />
      {/* Gated on agentGroups too, not just `loading`: surfaces resolve before drives
          do, and `loading` only flips false once BOTH reads finish — so a frame where
          surfaces already rendered a real row still had loading=true and showed the
          skeleton on top of it. Once there is real content to show, the skeleton has
          nothing left to stand in for. */}
      {loading && agentGroups.length === 0 && <SkeletonRows rows={2} controls />}
      {error && <NoteRow tone="bad">Could not read the per-agent decisions: {error}</NoteRow>}
      {surfaceError && (
        <NoteRow tone="bad">
          Could not read which agents use a Microsoft surface ({surfaceError}). That is unknown,
          not none — an agent needing this decision would migrate without those tools.
        </NoteRow>
      )}
      {driveError && (
        <NoteRow tone="bad">
          Could not read the Drive identities ({driveError}). Unknown, not none.
        </NoteRow>
      )}

      {agentGroups.map(agentRow)}

      {!loading && units && units.length === 0 && (
        <Note>No agents in the server-side plan yet, so there is nothing to decide.</Note>
      )}
    </Panel>

    {openAgentGroup && (
      <Modal
        label={`Decisions for ${openAgentGroup.name}`}
        glyph={openAgentGroup.name.slice(0, 2).toUpperCase()}
        title={openAgentGroup.name}
        sub={`${openAgentGroup.surfaces.length + (openAgentGroup.drive ? 1 : 0)} decision${
          openAgentGroup.surfaces.length + (openAgentGroup.drive ? 1 : 0) > 1 ? 's' : ''} for this agent`}
        onClose={() => setOpenAgentId(null)}
        body={(
          <>
            {openAgentGroup.surfaces.map(surfaceRow)}
            {openAgentGroup.drive && driveRow(openAgentGroup.drive)}
          </>
        )}
      />
    )}
    </>
  );
}
