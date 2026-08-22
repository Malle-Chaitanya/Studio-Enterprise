import { useEffect, useState } from 'react';
import { fetchSurfaceEquivalences, saveSurfaceDecision, type SurfaceEquivalence } from '../api';

/**
 * "This agent uses a Microsoft service. Where should that capability come from now?"
 *
 * One screen for EVERY cross-vendor surface, not one per surface. Outlook -> mail, Teams ->
 * messaging, and whatever comes next: the options, the wording and the caveats all come from
 * the server (SURFACE_EQUIVALENTS), so adding a surface needs no change here. The first
 * version hardcoded "mail" and a Teams agent was asked for a "Mailbox" and offered "No mail
 * tools" — wrong, and the kind of wrongness that makes a customer distrust the whole screen.
 *
 * Three real positions per agent, and none is a default:
 *   Keep Microsoft   the agent moves, the service stays where it is (phased migration)
 *   Use Google       the agent moves and the capability moves with it
 *   Skip             the agent migrates with no tools for that surface
 *
 * Staying on Microsoft is listed FIRST because it changes least about how the agent behaves.
 * An earlier version offered Google-or-nothing, which quietly forced a migration on anyone
 * who only wanted the agent moved.
 *
 * Undecided is a real, visible state and is NOT defaulted to anything: an agent with no
 * decision deploys without those tools and says so in its report. Silence is not consent for
 * someone's mailbox or their team's chat history.
 *
 * The trade-offs are shown BEFORE the choice, per option, including the admin step each one
 * needs first — because both of those have turned out to be the thing that actually decides
 * whether a path works (a scope string, a Chat app, an application permission that does not
 * exist).
 */
export function SurfaceEquivalenceChoice({
  session,
  envUrl,
  sourceIds,
  onChanged,
}: {
  session: string;
  envUrl: string;
  sourceIds: string[];
  onChanged?: (decidedCount: number, totalCount: number) => void;
}) {
  const [surfaces, setSurfaces] = useState<SurfaceEquivalence[]>([]);
  const [loading, setLoading] = useState(true);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A load failure must never be silent. Rendering nothing on error is indistinguishable
  // from "no agent uses this surface", so the customer neither makes the choice nor learns
  // that one existed — and every affected agent then migrates with no tools for it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const key = (s: SurfaceEquivalence) => `${s.sourceId}:${s.sourceConnectorId}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchSurfaceEquivalences(session, envUrl, sourceIds)
      .then((rows) => {
        if (cancelled) return;
        setSurfaces(rows);
        setEmails(
          Object.fromEntries(rows.map((r) => [`${r.sourceId}:${r.sourceConnectorId}`, r.impersonateEmail ?? ''])),
        );
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setSurfaces([]);
        setLoadError(err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session, envUrl, sourceIds.join(','), reloadKey]);

  useEffect(() => {
    onChanged?.(surfaces.filter((s) => s.decision !== null).length, surfaces.length);
  }, [surfaces]);

  async function decide(s: SurfaceEquivalence, decision: string) {
    const k = key(s);
    const email = emails[k]?.trim();
    // Checked here as well as on the server so the customer sees it inline rather than as a
    // failed request. Both targets need a mailbox: a deployed agent holds one identity, so
    // "whose mail" is never implied by who is asking.
    if (decision !== 'skip' && !email) {
      setErrors((e) => ({ ...e, [k]: 'Enter the mailbox address this agent should use.' }));
      return;
    }
    setBusy(k);
    setErrors((e) => ({ ...e, [k]: '' }));
    try {
      await saveSurfaceDecision(session, s.sourceId, s.sourceConnectorId, decision, email);
      setSurfaces((rows) =>
        rows.map((r) =>
          key(r) === k ? { ...r, decision, impersonateEmail: decision === 'skip' ? null : email! } : r,
        ),
      );
    } catch (err) {
      setErrors((e) => ({ ...e, [k]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="muted">Checking which agents use a Microsoft service…</p>;

  if (loadError) {
    return (
      <section className="surface-equivalence">
        <h3>Connected services for migrated agents</h3>
        <p className="error">
          Could not check which agents use Outlook or Teams: <strong>{loadError}</strong>
        </p>
        <p className="muted">
          This is not the same as "no agent uses them". Until this loads, any agent that does
          will migrate <strong>without</strong> those tools, and its report will say so. Retry,
          or continue knowingly.
        </p>
        <button type="button" onClick={() => setReloadKey((n) => n + 1)}>
          Try again
        </button>
      </section>
    );
  }

  if (surfaces.length === 0) return null;

  const undecided = surfaces.filter((s) => s.decision === null).length;

  // One screen serves every surface. It was written for mail and hardcoded that word, so a
  // Teams agent was asked for a "Mailbox" and offered "No mail tools" — wrong, and the kind
  // of wrongness that makes a customer distrust the rest of the screen. The nouns come from
  // the server (SURFACE_EQUIVALENTS.noun) so adding a surface needs no change here.
  // `noun` arrives from the server, so it is ABSENT whenever the API is older than this
  // screen — a stale dev server, a cached response, a half-deployed rollout. The first
  // version indexed straight into it (`distinctNouns[0][0].toUpperCase()`), which throws on
  // undefined and takes the whole section down: the customer then sees NO choice at all and
  // no error, the exact failure this component is meant to prevent. Never let a missing
  // server field crash a decision screen.
  const nounOf = (x: SurfaceEquivalence) => x.noun || 'connected service';
  const distinctNouns = [...new Set(surfaces.map(nounOf))];
  const nouns = distinctNouns.join(' or ');
  const sourceNames = [...new Set(surfaces.map((s) => s.sourceName))].join(' and ');
  const heading =
    distinctNouns.length === 1
      ? `${distinctNouns[0].charAt(0).toUpperCase()}${distinctNouns[0].slice(1)} for migrated agents`
      : 'Connected services for migrated agents';

  return (
    <section className="surface-equivalence">
      <h3>{heading}</h3>
      <p className="muted">
        {surfaces.length === 1 ? 'One agent uses' : `${surfaces.length} agents use`}{' '}
        {sourceNames}. Each one can keep using it after the agent moves, switch to the Google
        equivalent, or migrate with no {nouns} tools at all.
        {undecided > 0 && (
          <>
            {' '}
            <strong>
              {undecided} still undecided — {undecided === 1 ? 'it' : 'they'} will migrate
              without {nouns} tools.
            </strong>
          </>
        )}
      </p>

      {surfaces.map((s) => {
        const k = key(s);
        const chosen = s.targets.find((t) => t.connectorId === s.decision);
        return (
          <div
            key={k}
            className={`surface-row surface-${s.decision === null ? 'undecided' : s.decision === 'skip' ? 'skip' : 'migrate'}`}
          >
            <div className="surface-head">
              <strong>{s.agentName}</strong>
              <span className="surface-arrow">uses {s.sourceName}</span>
              {chosen && <span className="pill pill-ok">{chosen.name}</span>}
              {s.decision === 'skip' && <span className="pill">No {nounOf(s)} tools</span>}
              {s.decision === null && <span className="pill pill-warn">Not decided</span>}
            </div>

            {/* Every option's trade-off is shown BEFORE the choice, not after it. */}
            <div className="surface-options">
              {s.targets.map((t) => (
                <div key={t.connectorId} className="surface-option">
                  <div className="surface-option-head">
                    <strong>{t.name}</strong>
                    <button
                      type="button"
                      className={s.decision === t.connectorId ? 'btn-primary' : ''}
                      onClick={() => decide(s, t.connectorId)}
                      disabled={busy === k}
                    >
                      {busy === k ? 'Saving…' : s.decision === t.connectorId ? 'Selected' : 'Choose'}
                    </button>
                  </div>
                  <p className="surface-summary">{t.summary}</p>
                  {t.prerequisite && (
                    <p className="surface-prereq">
                      <strong>Needs first:</strong> {t.prerequisite}
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="surface-actions">
              <label>
                {nounOf(s) === 'mail'
                  ? 'Mailbox this agent uses'
                  : `Account this agent acts as (${nounOf(s)})`}
                <input
                  type="email"
                  placeholder="person@yourcompany.com"
                  value={emails[k] ?? ''}
                  onChange={(e) => setEmails((m) => ({ ...m, [k]: e.target.value }))}
                  disabled={busy === k}
                />
              </label>
              <button type="button" onClick={() => decide(s, 'skip')} disabled={busy === k}>
                No {nounOf(s)} tools
              </button>
            </div>

            {errors[k] && <p className="error">{errors[k]}</p>}

            {chosen && s.impersonateEmail && (
              <p className="muted small">
                This agent will use <strong>{s.impersonateEmail}</strong> — the same mailbox for
                everyone who talks to it, not each person's own account.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
