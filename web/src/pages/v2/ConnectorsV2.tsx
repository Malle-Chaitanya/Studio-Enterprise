import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ConnectorValidation } from '../../api.ts';
import { useWizardOptional } from '../../context/WizardContext.tsx';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Band, BandCell, BandRule, Btn, Chip, Inspector, InspectorActions, InspectorHead,
  InspectorSection, KeyValue, Note, NoteRow, Panel, PanelHead, Row, Toggle, WizardFooter,
  type ChipTone,
} from '../../components/v2/primitives.tsx';
import { useSource, type ConnectorRow, type ScopeEnv } from '../../v2/data/index.ts';
import { CredentialModal } from './CredentialModal.tsx';

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

const SECRETISH = /secret|token|password|api_key/i;

/**
 * Connectors — the phase where the agent finds what the migration depends on,
 * reuses every credential already in Secret Manager, and stops at the ones only a
 * human may supply.
 *
 * Every step the agent shows is a request it actually made: it re-reads each
 * connector's requirements one at a time, so a cursor move always corresponds to a
 * real result. Nothing here runs on a timer.
 */
export default function ConnectorsV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const wizard = useWizardOptional();
  const source = useSource();

  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [envs, setEnvs] = useState<ScopeEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);
  const [picked, setPicked] = useState<string | null>(null);
  const [modalFor, setModalFor] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [mode, setMode] = useState<'agent' | 'manual'>('agent');
  const runRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    if (!session) {
      // No session means no tenant to read. Say so instead of spinning forever —
      // an endless "Scanning..." reads as a hung app.
      setLoading(false);
      setError('no_session');
      return;
    }
    const run = ++runRef.current;
    setLoading(true);
    setError('');
    try {
      const scan = await source.connectors.scan(session);
      if (run !== runRef.current) return; // a newer scan already won
      setRows(scan.rows);
      setEnvs(scan.envs);
    } catch (e) {
      if (run !== runRef.current) return;
      setError((e as Error).message || 'connector_scan_failed');
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, [session, source]);

  useEffect(() => { void reload(); }, [reload]);

  const selected = useMemo(
    () => rows.find((r) => r.connectorId === picked) ?? rows[0] ?? null,
    [rows, picked],
  );
  const modalRow = useMemo(() => rows.find((r) => r.connectorId === modalFor) ?? null, [rows, modalFor]);

  const blocked = rows.filter((r) => r.state === 'needs-you');
  const ready = rows.filter((r) => r.state === 'ready');
  const impossible = rows.filter((r) => r.state === 'cannot-migrate');
  const agentsBlocked = new Set(blocked.flatMap((r) => r.agentNames)).size;

  const flash = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3600);
  }, []);

  // ── the agent run ─────────────────────────────────────────────────────────
  // One await per visible step. If a call is slow the cursor waits; if it fails
  // the ledger says so.
  const runAudit = useCallback(async (): Promise<void> => {
    dispatch({ kind: 'thinking', note: 'Reading what each connector still needs…' });
    const order = [...rows].sort((a, b) => (a.state === 'ready' ? 1 : 0) - (b.state === 'ready' ? 1 : 0));
    if (order.length === 0) {
      dispatch({ kind: 'done', note: 'This migration needs no connectors.' });
      return;
    }

    const blockers: Array<{ row: ConnectorRow; missing: Array<{ key: string; label: string; type: string }> }> = [];

    for (const row of order) {
      const target = `conn:${row.connectorId}`;
      if (row.state === 'cannot-migrate') {
        dispatch({ kind: 'tool_end', tool: 'inspect_connector', target, ok: false,
          note: `${row.name} is not in our registry — I cannot make this one work.` });
        continue;
      }

      dispatch({ kind: 'tool_start', tool: 'inspect_connector', target, note: `Checking ${row.name}…` });

      let missing: Array<{ key: string; label: string; type: string }> = [];
      try {
        const fresh = await source.connectors.requirements(session, row.connectorId, envs[0]?.env);
        missing = (fresh?.fields ?? []).filter((f) => !f.supplied);
      } catch {
        dispatch({ kind: 'tool_end', tool: 'inspect_connector', target, ok: false,
          note: `Could not read ${row.name}'s requirements. Leaving it untouched.` });
        continue;
      }

      if (missing.length === 0) {
        dispatch({ kind: 'tool_end', tool: 'inspect_connector', target, ok: true,
          note: `${row.name}: credential already in Secret Manager — reusing it.` });
        continue;
      }

      dispatch({ kind: 'tool_end', tool: 'inspect_connector', target, ok: true,
        note: `${row.name}: ${missing.length} value${missing.length > 1 ? 's' : ''} still missing.` });
      // Remember it, but keep checking. Handing over at the first blocker would
      // hide the others from someone about to go hunting for tokens — they should
      // learn everything they need in one pass.
      blockers.push({ row, missing });
    }

    if (blockers.length === 0) {
      dispatch({ kind: 'done', note: 'Every connector this migration needs is ready.' });
      return;
    }

    // The honest stop: open the right form on the right connector and hand over.
    // The agent does not type a secret, ever.
    const { row, missing } = blockers[0];
    setPicked(row.connectorId);
    setModalFor(row.connectorId);
    const first = missing.find((f) => SECRETISH.test(f.key) || f.type === 'password') ?? missing[0];
    const others = blockers.length - 1;
    const tail = others > 0 ? ` Then ${others} more need${others > 1 ? '' : 's'} you.` : '';
    dispatch({
      kind: 'awaiting_human',
      target: `field:${row.connectorId}:${first.key}`,
      note: (SECRETISH.test(first.key) || first.type === 'password'
        ? `${first.label} is a secret. I will not type it — over to you.`
        : `I need ${first.label} for ${row.name}. Over to you.`) + tail,
    });
  }, [rows, session, envs, source]);

  // The chat agent drives this screen through the same events the run emits, so a
  // tool call and a button press are indistinguishable downstream.
  useEffect(() => {
    const ev = wizard?.lastToolEvent;
    if (!ev) return;
    if (ev.type === 'open_connector_credentials' && typeof ev.connectorId === 'string') {
      const row = rows.find((r) => r.connectorId === ev.connectorId);
      if (!row) return;
      setPicked(row.connectorId);
      setModalFor(row.connectorId);
      dispatch({ kind: 'awaiting_human', target: `conn:${row.connectorId}`,
        note: `Opened ${row.name}. Your credentials, please.` });
    }
    if (ev.type === 'audit_connectors') void runAudit();
  }, [wizard?.lastToolEvent, rows, runAudit]);

  const onPrompt = (text: string): void => {
    // Until the tool layer lands, the dock understands the one command this screen
    // can honestly perform. Anything else says so rather than pretending.
    if (/connector|credential|ready|check|audit|blocking/i.test(text)) {
      void runAudit();
      return;
    }
    flash('I can only audit connectors on this screen so far. Try "check the connectors".');
  };

  const onSaved = (validation: ConnectorValidation | undefined): void => {
    void reload();
    if (validation?.code === 'ok') {
      dispatch({ kind: 'tool_end', tool: 'save_credentials', ok: true,
        note: 'Credential stored and tested — it works.' });
      flash('Stored in Secret Manager and verified against the provider.');
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
        <Band
          aside={
            <>
              <Chip>Mode</Chip>
              <Toggle
                value={mode}
                options={[{ id: 'agent', label: 'Agent' }, { id: 'manual', label: 'Manual' }]}
                onChange={setMode}
              />
            </>
          }
        >
          <BandCell label="Need you" value={blocked.length} note="connectors"
            tone={blocked.length ? 'amber' : 'ok'} />
          <BandCell label="Connected" value={ready.length} note={`of ${rows.length} found`} tone="ok" />
          <BandCell label="Cannot migrate" value={impossible.length} note="not in registry"
            tone={impossible.length ? 'bad' : 'plain'} />
          <BandCell label="Agents blocked" value={agentsBlocked} note="until these are set"
            tone={agentsBlocked ? 'warn' : 'ok'} />
        </Band>
        <BandRule pct={rows.length ? (ready.length / rows.length) * 100 : 0} />
      </Panel>

      <Panel>
        <PanelHead
          title="Connectors"
          sub={loading
            ? 'Scanning the agents you selected for the connectors they depend on…'
            : `Found by scanning the agents you selected${envs.length > 1 ? ` across ${envs.length} environments` : ''}. Connect each one to unblock its agents.`}
          actions={<Btn onClick={() => void reload()} disabled={loading}>{loading ? 'Scanning…' : 'Re-scan'}</Btn>}
        />

        {error && (
          <NoteRow tone="bad">
            {error === 'no_session'
              ? 'No connected session. Connect both clouds and choose your agents first.'
              : `Could not scan for connectors: ${error}`}
          </NoteRow>
        )}

        {!loading && !error && rows.length === 0 && (
          <NoteRow>None of the agents you selected use a connector. Nothing to configure here.</NoteRow>
        )}

        {rows.map((row) => {
          const label = STATE_LABEL[row.state];
          return (
            <Row
              key={row.connectorId}
              agentTarget={`conn:${row.connectorId}`}
              glyph={row.req?.icon ?? row.name.slice(0, 2).toUpperCase()}
              name={row.name}
              sub={row.connectorId}
              why={whyLine(row)}
              selected={selected?.connectorId === row.connectorId}
              onSelect={() => setPicked(row.connectorId)}
              status={
                <Chip tone={label.chip}>
                  {label.text}
                  {row.state === 'needs-you' && row.missingFields.length > 0 ? ` · ${row.missingFields.length}` : ''}
                </Chip>
              }
              action={row.state === 'cannot-migrate' ? null : (
                <Btn
                  tone={row.state === 'needs-you' ? 'amber' : 'plain'}
                  onClick={() => { setPicked(row.connectorId); setModalFor(row.connectorId); }}
                >
                  {row.state === 'ready' ? 'Review' : 'Connect'}
                </Btn>
              )}
            />
          );
        })}
      </Panel>

      <WizardFooter
        onBack={() => navigate(`/v2/review?${params.toString()}`)}
        onNext={() => navigate(`/v2/migrate?${params.toString()}`)}
        nextLabel="Continue to migration"
        blocked={blocked.length > 0}
        note={blocked.length
          ? `${blocked.length} connector${blocked.length > 1 ? 's' : ''} still need you`
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

          {agent.ledger.length > 0 && (
            <InspectorSection title="What the agent did">
              {agent.ledger.map((l, i) => (
                <div className={`v2-ldg ${l.state === 'ok' ? '' : l.state}`} key={`${i}-${l.text}`}>
                  <span className="m" aria-hidden="true">
                    {l.state === 'ok' ? '✓' : l.state === 'live' ? '◍' : l.state === 'stop' ? '◉' : '!'}
                  </span>
                  <span>{l.text}</span>
                </div>
              ))}
            </InspectorSection>
          )}

          <InspectorActions>
            {selected.state !== 'cannot-migrate' && (
              <Btn wide tone={selected.state === 'needs-you' ? 'amber' : 'plain'}
                onClick={() => setModalFor(selected.connectorId)}>
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
        manual={mode === 'manual'}
        suggestions={['Check which connectors are ready', 'What is blocking the migration?']}
        onPrompt={onPrompt}
        onStop={() => dispatch({ kind: 'idle' })}
        canvas={canvas}
        inspector={inspector}
        toast={toast}
      />

      {modalRow && (
        <CredentialModal
          session={session}
          row={modalRow}
          onClose={() => {
            setModalFor(null);
            if (agent.mode === 'waiting') dispatch({ kind: 'idle' });
          }}
          onSaved={onSaved}
          onFocusSecret={(key) =>
            dispatch({
              kind: 'awaiting_human',
              target: `field:${modalRow.connectorId}:${key}`,
              note: 'Yours to type. I do not read or store this value — it goes straight to Secret Manager.',
            })
          }
        />
      )}
    </>
  );
}
