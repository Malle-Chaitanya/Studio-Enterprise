import { useCallback, useEffect, useState } from 'react';
import { Btn, Chip, Note, NoteRow, Panel, PanelHead, Select, SkeletonRows } from './primitives.tsx';
import {
  fetchDriveIdentities, fetchSelection, fetchSurfaceEquivalences,
  saveDriveIdentity, saveSurfaceDecision,
  type DriveIdentityStatus, type SurfaceEquivalence,
} from '../../api.ts';

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
 * Kept to one line per agent with one control. These are decisions, not reading
 * material — the previous screen explained them at paragraph length and the
 * explanation is what people skipped.
 */

interface Unit { env: string; envName?: string; botIds: string[] }

export function AgentDecisions({ session, driveAgentNames, nameById, live = true, onSaved }: {
  session: string;
  /**
   * Agent names the connector scan saw on the Google Drive connector.
   *
   * The Drive endpoint answers for whatever ids it is asked about and does not
   * itself say who uses Drive, so the scan is what narrows it. Names, because that
   * is what the scan carries — a wrong match here would offer a harmless extra row,
   * never attach a decision to the wrong agent, because the id sent to the server
   * always comes from the selection and never from this list.
   */
  driveAgentNames: string[];
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
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});

  const read = useCallback(async (): Promise<void> => {
    setError('');
    try {
      // The server-side plan, not sessionStorage: the old screen read the selection
      // from the tab and so showed no decisions at all after a reload or in a new
      // tab — the worst way for a decision screen to fail, because nothing errors.
      const sel = await fetchSelection(session);
      setUnits(sel);
      const surf = await Promise.all(sel.map(async (u) => {
        const rows = await fetchSurfaceEquivalences(session, u.env, u.botIds).catch(() => []);
        return rows.map((r) => ({ ...r, env: u.env }));
      }));
      setSurfaces(surf.flat());

      const drv = await Promise.all(sel.map(async (u) => {
        const rows = await fetchDriveIdentities(session, u.env, u.botIds).catch(() => []);
        return rows.map((r) => ({ ...r, env: u.env, name: nameById[r.sourceId] ?? r.sourceId }));
      }));
      setDrives(drv.flat());
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
        <span className="nmw">
          <span className="nm">{s.agentName}</span>
          <span className="kind">uses {s.sourceName} · {noun}</span>
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
        {target?.prerequisite && <span className="pre">{target.prerequisite}</span>}
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
          <span className="nm">{d.name}</span>
          <span className="kind">
            Drive acts as
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
        {rowError[key] && <span className="err">{rowError[key]}</span>}
      </div>
    );
  };

  // Only Drive-using agents are asked. The endpoint answers for ANY id it is given,
  // so without this every selected agent would be offered a Drive account it has no
  // use for. An unmatched name simply drops the row: offering one Drive box too few
  // is recoverable from the run's own fidelity note, whereas a screen full of
  // irrelevant account pickers is the wall of noise this rewrite exists to remove.
  const wantsDrive = new Set(driveAgentNames.filter(Boolean));
  const driveRows = drives.filter((d) => wantsDrive.has(d.name));

  const undecided = surfaces.filter((s) => s.decision === null).length;
  const unwired = driveRows.filter((d) => d.current?.status !== 'confirmed').length;

  if (!loading && !error && surfaces.length === 0 && driveRows.length === 0) return null;

  return (
    <Panel>
      <PanelHead
        title="Decisions only you can make, per agent"
        sub="Left undecided, these do not fail — the agent migrates with those tools missing, which is worse, because it looks like it worked."
      />
      {loading && <SkeletonRows rows={2} controls />}
      {error && <NoteRow tone="bad">Could not read the per-agent decisions: {error}</NoteRow>}

      {!loading && undecided > 0 && (
        <NoteRow tone="you">
          {undecided} surface decision{undecided > 1 ? 's' : ''} not recorded. An agent with no
          decision gets no tools for that service at all — not a default, nothing.
        </NoteRow>
      )}
      {surfaces.map(surfaceRow)}

      {driveRows.length > 0 && (
        <>
          {unwired > 0 && (
            <NoteRow tone="you">
              {unwired} agent{unwired > 1 ? 's' : ''} would deploy without the Drive tool. There is
              no &ldquo;skip&rdquo; to record here: leaving it empty IS the skip, and the run
              reports it as a loss rather than a choice.
            </NoteRow>
          )}
          {driveRows.map(driveRow)}
        </>
      )}

      {!loading && units && units.length === 0 && (
        <Note>No agents in the server-side plan yet, so there is nothing to decide.</Note>
      )}
    </Panel>
  );
}
