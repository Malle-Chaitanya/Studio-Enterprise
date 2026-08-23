import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ConnectorValidation } from '../../api.ts';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, BandRule, Btn, Chip, Inspector, InspectorActions, InspectorHead,
  Fold, InspectorSection, KeyValue, Note, NoteRow, Panel, PanelHead, SkeletonRows, WizardFooter,
  type ChipTone,
} from '../../components/v2/primitives.tsx';
import { FidelityCard, FidelityDetail, useFidelity } from '../../components/v2/fidelity.tsx';
import { AgentDecisions } from '../../components/v2/AgentDecisions.tsx';
import {
  clearStale, isStale, markProgress, readAgo, readProgress, useResource,
} from '../../v2/data/cache.ts';
import { useSource, type ConnectorRow } from '../../v2/data/index.ts';
import { CredentialForm } from './CredentialModal.tsx';

const STATE_LABEL: Record<ConnectorRow['state'], { text: string; chip: ChipTone }> = {
  'needs-you': { text: 'needs you', chip: 'you' },
  'wrong-project': { text: 'wrong project', chip: 'bad' },
  'cannot-migrate': { text: 'cannot migrate', chip: 'bad' },
  ready: { text: 'connected', chip: 'ok' },
};

/** Why a connector is in this list at all — always drawn from what we detected. */
function whyLine(row: ConnectorRow): string {
  if (row.state === 'cannot-migrate') return 'Not in our registry — we cannot call this connector';
  if (row.state === 'wrong-project') return 'Credentials exist, but not in the project this run targets';
  if (row.agentNames.length) {
    const head = row.agentNames.slice(0, 2).join(', ');
    return `Used by ${head}${row.agentNames.length > 2 ? ` +${row.agentNames.length - 2}` : ''}`;
  }
  if (row.flowNames.length) return `Referenced by ${row.flowNames.length} flow(s)`;
  return 'Detected in this migration scope';
}

/**
 * Connectors — the phase where the agent finds what the migration depends on,
 * reuses every credential already in Secret Manager, and stops at the ones only a
 * human may supply.
 *
 * Every step the agent shows is a request it actually made: it re-reads each
 * connector's requirements one at a time, so a cursor move always corresponds to a
 * real result. Nothing here runs on a timer.
 *
 * This screen also carries the fidelity assessment that used to be its own "Review
 * what changes" phase. That phase is gone; the information is not, because it is
 * the last place a customer can still change their mind. Every selected agent is
 * assessed here and anything lost or needing review is shown before Migrate. The
 * assessment runs without moving the cursor — it is a background read nobody
 * asked for, so it does not get to claim the agent's attention.
 */
export default function ConnectorsV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);
  const [picked, setPicked] = useState<string | null>(null);
  /** Which step is open. One at a time: this is a sequence of decisions, not a
   *  form with eleven sections. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  // Fidelity lives in a shared hook: this screen and Migrate must never be able
  // to disagree about what a run will cost.
  const fid = useFidelity(session);

  // Cached: this screen is now opened on demand, and re-scanning the tenant every
  // time someone glances at it is quota spent for nothing.
  const scanRes = useResource(
    `conn:${session}`, () => source.connectors.scan(session), Boolean(session),
  );
  const rows = scanRes.data?.rows ?? [];
  // botId -> name, from the assessment's own fetch. Both come from one read, which
  // is the invariant that keeps a per-agent decision attached to the right agent.
  const nameById = useMemo(
    () => Object.fromEntries(fid.agents.map((a) => [a.botId, a.name])),
    [fid.agents],
  );
  const envs = scanRes.data?.envs ?? [];
  const loading = scanRes.loading;
  const syncing = scanRes.syncing;
  const error = !session ? 'no_session' : scanRes.error;
  const reload = useCallback((): void => scanRes.sync(), [scanRes]);

  const selected = useMemo(
    () => rows.find((r) => r.connectorId === picked) ?? rows[0] ?? null,
    [rows, picked],
  );

  /**
   * Credentials are shared by GROUP, not per connector: one Entra app serves seven
   * Microsoft connectors, one Atlassian token serves Jira and Confluence. A card
   * per connector asks for the same client secret seven times, which is most of
   * the length and all of the tedium.
   */
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; rows: ConnectorRow[] }>();
    for (const r of rows) {
      const g = r.req?.group;
      const id = g?.id ?? r.connectorId;
      const entry = m.get(id) ?? { id, name: g?.name ?? r.name, rows: [] };
      entry.rows.push(r);
      m.set(id, entry);
    }
    // Needs-you first: the list is a queue of work, so what is blocking comes top.
    const rank = (g: { rows: ConnectorRow[] }): number => {
      if (g.rows.some((r) => r.state === 'needs-you')) return 0;
      if (g.rows.every((r) => r.state === 'cannot-migrate')) return 2;
      return 1;
    };
    return [...m.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [rows]);

  const deadGroups = groups.filter((g) => g.rows.every((r) => r.state === 'cannot-migrate'));
  const usableGroups = groups.filter((g) => !g.rows.every((r) => r.state === 'cannot-migrate'));

  const blocked = rows.filter((r) => r.state === 'needs-you');
  // Record what was actually SEEN, so the rail can still say it after the scan
  // behind it goes stale. Both numbers, because "nothing needs you" and "three
  // things need you" are different claims and the rail renders them differently.
  useEffect(() => {
    if (!session || rows.length === 0) return;
    const need = rows.filter((r) => r.state === 'needs-you').length;
    markProgress(session, {
      connectorsBlocked: need,
      connectorsCleared: need === 0 ? rows.length : 0,
    });
  }, [session, rows]);

  // Something upstream changed the selection or the pairing, so what is cached no
  // longer describes this run. Re-read once, on the screen that owns it.
  useEffect(() => {
    if (!session || !isStale(session, `conn:${session}`)) return;
    clearStale(session, `conn:${session}`);
    scanRes.sync();
    // Deliberately keyed on session alone: scanRes changes identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  const ready = rows.filter((r) => r.state === 'ready');
  const impossible = rows.filter((r) => r.state === 'cannot-migrate');
  const agentsBlocked = new Set(blocked.flatMap((r) => r.agentNames)).size;

  const flash = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3600);
  }, []);

  const onSaved = (validation: ConnectorValidation | undefined): void => {
    markProgress(session, { credentialsSaved: (readProgress(session).credentialsSaved ?? 0) + 1 });
    void reload();
    if (validation?.code === 'ok') {
      dispatch({ kind: 'tool_end', tool: 'save_credentials', ok: true,
        note: 'Credential stored and tested — it works.' });
      flash('Saved to Secret Manager and verified against the provider.');
    } else if (validation && validation.code !== 'unverified') {
      dispatch({ kind: 'tool_end', tool: 'save_credentials', ok: false,
        note: validation.detail || `Provider said: ${validation.code}` });
    } else {
      dispatch({ kind: 'tool_end', tool: 'save_credentials', ok: true,
        note: 'Credential stored. Not tested, so not proven.' });
      flash('Stored in Secret Manager. We do not test this connector, so this is not proof it works.');
    }
  };

  const forget = async (row: ConnectorRow): Promise<void> => {
    try {
      await source.connectors.forget(session, row.connectorId);
      flash(`Forgot our record of ${row.name}. The Secret Manager secrets are untouched.`);
      void reload();
    } catch {
      flash('Could not forget that connector.');
    }
  };

  const canvas = (
    <>
      <Panel>
        <Band>
          <BandCell label="Need you" value={blocked.length} note="connectors"
            tone={blocked.length ? 'amber' : 'ok'} />
          <BandCell label="Connected" value={ready.length} note={`of ${rows.length} connectors`} tone="ok" />
          <BandCell label="Credentials" value={groups.length} note="entries, not connectors" />
          <BandCell label="Cannot migrate" value={impossible.length} note="not in registry"
            tone={impossible.length ? 'bad' : 'plain'} />
          <BandCell label="Agents blocked" value={agentsBlocked} note="until these are set"
            tone={agentsBlocked ? 'warn' : 'ok'} />
          <BandCell
            label="Will be lost"
            value={fid.state === 'reading' ? '…' : fid.state === 'failed' ? '?' : fid.totals.lost || '—'}
            note={fid.state === 'done' ? 'behaviours, before the run' : 'reading the source'}
            tone={fid.totals.lost ? 'bad' : fid.state === 'failed' ? 'amber' : 'plain'}
          />
        </Band>
        <BandRule pct={rows.length ? (ready.length / rows.length) * 100 : 0} />
      </Panel>

      <Panel>
        <PanelHead
          title="Connectors"
          sub={loading
            ? 'Scanning the agents you selected for the connectors they depend on…'
            : `Grouped by credential — one entry can unlock several connectors${envs.length > 1 ? ` across ${envs.length} environments` : ''}. Connect each one to unblock its agents · ${readAgo(scanRes.readAt)}`}
          actions={
            <>
              {syncing && <Chip tone="run">syncing</Chip>}
              <Btn onClick={reload} disabled={syncing || loading}>
                {syncing ? 'Syncing…' : 'Sync'}
              </Btn>
            </>
          }
        />

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session'
              ? 'No connected session. Connect both clouds and choose your agents first.'
              : `Could not scan for connectors: ${error}`}
          </NoteRow>
        )}

        {loading && <SkeletonRows rows={4} />}

        {!loading && !error && rows.length === 0 && (
          <NoteRow>None of the agents you selected use a connector. Nothing to configure here.</NoteRow>
        )}

        {usableGroups.map((g, i) => {
          // The row that still needs input, if any: that is the one whose fields
          // are outstanding. Otherwise any member represents the group.
          const row = g.rows.find((r) => r.state === 'needs-you') ?? g.rows[0];
          const label = STATE_LABEL[row.state];
          const open = expanded === g.id;
          const dead = g.rows.every((r) => r.state === 'cannot-migrate');
          const done = !dead && g.rows.every((r) => r.state === 'ready');
          const agentsHere = new Set(g.rows.flatMap((r) => r.agentNames));
          return (
            <div
              className={`v2-step${open ? ' open' : ''}${done ? ' done' : ''}${dead ? ' dead' : ''}`}
              key={g.id}
              data-agent-target={`conn:${row.connectorId}`}
            >
              <button
                type="button"
                className="hd"
                aria-expanded={open}
                onClick={() => {
                  setPicked(row.connectorId);
                  // Nothing to open for a connector we cannot call: an empty form
                  // presented as a step reads as work you have to do.
                  if (!dead) setExpanded(open ? null : g.id);
                }}
              >
                <span className="n" aria-hidden="true">{done ? '✓' : dead ? '×' : i + 1}</span>
                <span className="tx">
                  <span className="nm">{g.name}</span>
                  <span className="sb">
                    {dead
                      ? 'Not in our registry — we cannot call these'
                      : g.rows.length > 1
                        ? `One credential for ${g.rows.length} connectors: ${g.rows.map((r) => r.name).join(', ')}`
                        : whyLine(row)}
                    {agentsHere.size > 0 && !dead
                      ? ` · ${agentsHere.size} agent${agentsHere.size > 1 ? 's' : ''} need${agentsHere.size > 1 ? '' : 's'} it`
                      : ''}
                  </span>
                </span>
                <span className="st">
                  <Chip tone={label.chip}>
                    {label.text}
                    {row.state === 'needs-you' && row.missingFields.length > 0
                      ? ` · ${row.missingFields.length}`
                      : ''}
                  </Chip>
                </span>
                {/* Said out loud rather than implied by a chevron: a stored
                    credential still needs an obvious way to be replaced when it
                    is rotated or was entered wrong. */}
                {!dead && (
                  <span className="ed">{open ? 'Close' : done ? 'Edit' : 'Enter'}</span>
                )}
                {!dead && <span className="cv" aria-hidden="true">{open ? '▾' : '▸'}</span>}
              </button>

              {open && !dead && (
                <div className="bd">
                  {/* What breaks without it, stated once. The agents still migrate;
                      it is their actions that do not work. */}
                  {row.state === 'needs-you' && (
                    <div className="v2-secnote" style={{ marginBottom: 14 }}>
                      <span className="m" aria-hidden="true">!</span>
                      <span>
                        Without this, those agents still migrate — their actions do not work until
                        the credential is in place.
                      </span>
                    </div>
                  )}
                  {row.detected?.confidence === 'heuristic' && (
                    <div className="v2-secnote" style={{ marginBottom: 14 }}>
                      <span className="m" aria-hidden="true">?</span>
                      <span>
                        Copilot Studio does not say exactly which service this is, so we guessed
                        from the description. Skip it if this agent does not actually use it.
                      </span>
                    </div>
                  )}
                  {/* No agent hook on focus. Clicking into a credential field used to
                      put the whole screen into the agent's "your turn" state — dimmed
                      page, a YOUR TURN pill and a caption following the cursor — while
                      someone was trying to paste a client secret. Nothing was driving
                      anything; it was narration on top of a form. The one true thing it
                      said (the value goes straight to Secret Manager and is never read
                      back) is in the form itself, next to the field it applies to. */}
                  <CredentialForm
                    session={session}
                    row={row}
                    onSaved={(v) => { onSaved(v); setExpanded(null); }}
                  />
                  {row.saved && (
                    <div className="v2-fld-f">
                      <span className="v2-test">
                        <span aria-hidden="true">i</span>
                        <span>Stored earlier. Forgetting only drops our record — the Secret Manager secret stays.</span>
                      </span>
                      <span className="sp">
                        <Btn onClick={() => void forget(row)}>Forget stored credentials</Btn>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {/* Not in our registry: nothing to enter, nothing to fix here. Folded so
            the list is the work, not the work plus two dead ends. Kept reachable
            because "why is this agent's action missing" is answered here. */}
        {deadGroups.length > 0 && (
          <Fold
            title={`${deadGroups.length} connector${deadGroups.length > 1 ? 's' : ''} we cannot call`}
            note="not in our registry — their actions will not be reproduced"
          >
            {deadGroups.map((g) => (
              <div className="v2-row" key={g.id}>
                <span className="glyph" aria-hidden="true">×</span>
                <span className="nmw">
                  <span className="nm">{g.name}</span>
                  <span className="kind">{g.rows.map((r) => r.connectorId).join(', ')}</span>
                </span>
                <span className="why">Not in our registry, so we cannot authenticate or call it</span>
                <span className="st"><Chip tone="bad">cannot migrate</Chip></span>
              </div>
            ))}
          </Fold>
        )}
      </Panel>

      {/* The per-agent decisions the orchestrator will not guess. Placed above the
          fidelity card on purpose: this is the panel that PREVENTS two of the losses
          the card would otherwise report after the fact. */}
      <AgentDecisions
        session={session}
        driveAgentNames={rows.find((r) => r.connectorId === 'shared_googledrive')?.agentNames ?? []}
        // The assessment already fetched the selected agents, so the map costs
        // nothing extra and comes from the same read as the rest of the screen.
        nameById={nameById}
        live={!source.isFixture}
        onSaved={reload}
      />

      <FidelityCard fid={fid} />

      <WizardFooter
        onBack={() => navigate(`/v2/select-agents?${params.toString()}`)}
        onNext={() => navigate(`/v2/migrate?${params.toString()}`)}
        nextLabel="Continue to migration"
        blocked={blocked.length > 0}
        note={blocked.length
          ? `${blocked.length} connector${blocked.length > 1 ? 's' : ''} still need you`
          : fid.totals.lost
            ? `Nothing blocks the run, but ${fid.totals.lost} behaviour${fid.totals.lost > 1 ? 's' : ''} will be lost. Continuing accepts that.`
            : 'Nothing is blocking the run'}
      />
    </>
  );

  const inspector = (
    <Inspector>
      {selected ? (
        <>
          <InspectorHead
            kind="Connector"
            title={selected.name}
            status={<Chip tone={STATE_LABEL[selected.state].chip}>{STATE_LABEL[selected.state].text}</Chip>}
          />
          <InspectorSection title="Facts">
            <dl>
              <KeyValue k="Id" v={selected.connectorId} />
              <KeyValue k="Auth" v={selected.req?.authKind ?? 'unknown'} />
              <KeyValue
                k="Fields stored"
                v={`${(selected.req?.fields ?? []).filter((f) => f.supplied).length}/${(selected.req?.fields ?? []).length}`}
              />
              {selected.saved?.updatedAt && (
                <KeyValue k="Last saved" v={new Date(selected.saved.updatedAt).toLocaleString()} />
              )}
              {selected.detected?.flowCount ? <KeyValue k="Flows" v={selected.detected.flowCount} /> : null}
            </dl>
          </InspectorSection>

          {selected.agentNames.length > 0 && (
            <InspectorSection title="Blocks these agents">
              {selected.agentNames.slice(0, 6).map((n) => <Note key={n}>{n}</Note>)}
            </InspectorSection>
          )}

          {selected.detected?.confidence === 'heuristic' && (
            <InspectorSection title="How we know">
              <Note tone="you">
                Inferred from editable text on a generic source — we think this connector is used,
                but Copilot Studio did not name it. Worth confirming.
              </Note>
            </InspectorSection>
          )}

          <InspectorActions>
            {selected.state !== 'cannot-migrate' && (
              <Btn wide tone={selected.state === 'needs-you' ? 'amber' : 'plain'}
                onClick={() => setExpanded(selected.connectorId)}>
                {selected.state === 'ready' ? 'Review credentials' : 'Enter credentials'}
              </Btn>
            )}
            {selected.saved && (
              <Btn wide onClick={() => void forget(selected)}>Forget stored credentials</Btn>
            )}
          </InspectorActions>
        </>
      ) : (
        <InspectorHead kind="Connector" title={loading ? 'Scanning…' : 'Nothing selected'} />
      )}

      {/* Fidelity. Not about the selected connector — about the whole run. */}
      <InspectorSection
        title={fid.state === 'done'
          ? `What migrating will change (${Object.keys(fid.reviews).length}/${fid.agents.length} agents)`
          : 'What migrating will change'}
      >
        <FidelityDetail fid={fid} />
      </InspectorSection>
    </Inspector>
  );

  return (
    <>
      <V2Layout
        phase="connectors"
        phaseStatus={{
          connectors: { state: 'current', count: rows.length || undefined },
          migrate: blocked.length ? { state: 'blocked' } : undefined,
        }}
        agent={agent}
        // The agent is deliberately off on this screen, all of it: no dock, and no
        // driving chrome either. Entering credentials is work only a person may do,
        // so a page that dims itself and announces YOUR TURN over a secret field is
        // pure interference. `quiet` drops the cursor, the caption and the takeover
        // state; `manual` drops the dock.
        manual
        quiet
        suggestions={[]}
        onPrompt={() => undefined}
        onStop={() => dispatch({ kind: 'idle' })}
        canvas={canvas}
        inspector={inspector}
        toast={toast}
      />

    </>
  );
}
