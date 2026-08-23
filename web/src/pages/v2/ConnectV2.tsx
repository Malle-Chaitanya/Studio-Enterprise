import { useCallback, useEffect, useReducer, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { connectViaPopup, googleStartUrl, microsoftStartUrl } from '../../api.ts';
import { initialAgentState, reduceAgent } from '../../agent/driver.ts';
import { EnvPairing } from '../../components/v2/EnvPairing.tsx';
import { V2Layout } from '../../components/v2/V2Layout.tsx';
import {
  Btn, Chip, CloudMark, Inspector, InspectorHead, InspectorSection, KeyValue, Note, Panel,
  PanelHead, WizardFooter,
} from '../../components/v2/primitives.tsx';
import { useSource, type CloudLink, type ConnectState } from '../../v2/data/index.ts';

const EMPTY: ConnectState = {
  source: { platform: 'microsoft', connected: false },
  destination: { platform: 'google', connected: false },
};

/** One cloud. Everything shown is read back from the server, never assumed from
 *  the fact that a popup closed. */
function CloudCard({ role, title, link, busy, onConnect, onDisconnect }: {
  role: string;
  title: string;
  link: CloudLink;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className={`v2-card${link.connected ? ' live' : ''}`} data-agent-target={`cloud:${link.platform}`}>
      <div className="role">{role}</div>
      <div className="hd">
        <CloudMark platform={link.platform} />
        <h3>{title}</h3>
      </div>
      {link.connected ? (
        <>
          <div className="acct">{link.account ?? 'connected'}</div>
          {link.detail && <div className="det">{link.detail}</div>}
          {/* A destination we cannot actually write to is worth knowing NOW, not at
              insert time when half the agents are already staged. */}
          {link.problem && <div className="det" style={{ color: 'var(--v2-fail)' }}>{link.problem}</div>}
          <div className="foot">
            <Chip tone={link.problem ? 'bad' : 'ok'}>{link.problem ? 'needs attention' : 'connected'}</Chip>
            <Btn onClick={onDisconnect} disabled={busy}>Disconnect</Btn>
          </div>
        </>
      ) : (
        <>
          <div className="det">
            {link.platform === 'microsoft'
              ? 'Sign in as a Power Platform admin. We read agents from Dataverse with an app-only token — no delegated Dynamics consent.'
              : 'Sign in as a Google Workspace admin. Our service account then needs Discovery Engine access to your project.'}
          </div>
          <div className="foot">
            <Btn tone="blue" onClick={onConnect} disabled={busy}>
              {busy ? 'Waiting for sign-in…' : 'Connect'}
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Connect clouds — the first phase, and now also the last word on direction.
 *
 * The old wizard had a separate "Choose pair" screen to confirm a pair that has
 * exactly one possible value. That screen is gone: the direction appears here, in
 * the strip under the two cards, the moment both sides are live.
 */
export default function ConnectV2() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const navigate = useNavigate();
  const source = useSource();

  const [state, setState] = useState<ConnectState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'microsoft' | 'google' | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  /** Why a connect attempt was refused, in words the person can act on. */
  const [connectError, setConnectError] = useState('');
  const [agent, dispatch] = useReducer(reduceAgent, initialAgentState);

  const load = useCallback(async (): Promise<void> => {
    if (!session) { setLoading(false); return; }
    try {
      setState(await source.connect.read(session));
      setError('');
    } catch (e) {
      setError((e as Error).message || 'session_read_failed');
    } finally {
      setLoading(false);
    }
  }, [session, source]);

  useEffect(() => { void load(); }, [load]);

  const connect = async (platform: 'microsoft' | 'google'): Promise<void> => {
    setBusy(platform);
    try {
      const start = platform === 'microsoft' ? microsoftStartUrl(session) : googleStartUrl(session);
      const res = await connectViaPopup(
        start,
        platform === 'microsoft' ? 'ms-auth-success' : 'google-auth-success',
        platform === 'microsoft' ? 'ms-auth-error' : 'google-auth-error',
      );
      // A refused connection has to say so. Silence after a popup closes is the
      // failure shape that cost a whole afternoon last time.
      if (!res.ok && res.error && res.error !== 'closed') {
        setConnectError(/sign-in changed|state|mismatch/i.test(res.error)
          // The server refuses the connection if the signed-in user changed while
          // the popup was open. The fix is to try again, not to report a fault.
          ? 'Your sign-in changed while connecting, so the connection was refused. Try again.'
          : res.error);
      } else {
        setConnectError('');
      }
      // Microsoft mints (or resumes) the session and posts its id back — a fresh
      // connect never had one in the URL, so adopt it here or `load()` re-reads
      // the empty session it started with and the connection looks like it never happened.
      if (res.ok && res.session && res.session !== session) {
        const next = new URLSearchParams(params);
        next.set('session', res.session);
        navigate(`/v2/connect?${next.toString()}`, { replace: true });
        return;
      }
      // Re-read rather than trusting the popup: the only proof a cloud is connected
      // is the server saying so.
      await load();
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (platform: 'microsoft' | 'google'): Promise<void> => {
    setBusy(platform);
    try {
      const r = await source.connect.disconnect(session, platform);
      if (r.sessionEnded) {
        // Disconnecting the source ends the session server-side — re-reading the
        // now-dead id just produced "session_not_found" while stale state (e.g.
        // Google still shown "connected") lingered on screen. Drop the dead
        // session and start clean instead.
        setState(EMPTY);
        setError('');
        navigate('/v2/connect', { replace: true });
        setToast('Disconnected Microsoft — session ended, reconnect to start over.');
      } else {
        await load();
        setToast(`Disconnected ${platform === 'microsoft' ? 'Microsoft' : 'Google'}.`);
      }
      window.setTimeout(() => setToast(''), 3000);
    } finally {
      setBusy(null);
    }
  };

  const both = state.source.connected && state.destination.connected;
  // Pairing now happens on this screen, so Connect has to know whether it is done
  // before it can honestly offer Continue.
  const [paired, setPaired] = useState({ done: 0, total: 0 });
  const onPairChange = useCallback(
    (done: number, total: number) => setPaired({ done, total }), [],
  );

  const canvas = (
    <>
      <Panel>
        <PanelHead
          title="Connect both clouds"
          sub="One admin sign-in per side. Nothing is read until both are connected."
          actions={<Btn onClick={() => void load()} disabled={loading}>{loading ? 'Checking…' : 'Re-check'}</Btn>}
        />
        <div style={{ padding: 16 }}>
          <div className="v2-cards">
            <CloudCard
              role="Source"
              title="Microsoft Copilot Studio"
              link={state.source}
              busy={busy === 'microsoft'}
              onConnect={() => void connect('microsoft')}
              onDisconnect={() => void disconnect('microsoft')}
            />
            <CloudCard
              role="Destination"
              title="Google Gemini Enterprise"
              link={state.destination}
              busy={busy === 'google'}
              onConnect={() => void connect('google')}
              onDisconnect={() => void disconnect('google')}
            />
          </div>

          {/* The direction, stated where you just connected — not on a screen of
              its own asking you to confirm the only possible answer. */}
          {both && (
            <div className="v2-dir" data-agent-target="direction">
              <span className="side">
                <CloudMark platform="microsoft" />
                Copilot Studio
                <span className="sub">{state.source.account ?? '—'}</span>
              </span>
              <span className="to" aria-hidden="true">→</span>
              <span className="side">
                <CloudMark platform="google" />
                Gemini Enterprise
                <span className="sub">{state.destination.account ?? '—'}</span>
              </span>
              {state.found && (
                <span className="found">
                  <span>
                    <span className="n">{state.found.environments}</span>
                    <label>Environments</label>
                  </span>
                  <span>
                    <span className="n">{state.found.agents}</span>
                    <label>Agents</label>
                  </span>
                  <span>
                    <span className="n">{state.found.topics}</span>
                    <label>Topics</label>
                  </span>
                </span>
              )}
            </div>
          )}

          {connectError && (
            <div className="v2-test bad" style={{ marginTop: 14 }}>
              <span aria-hidden="true">!</span>
              <span>{connectError}</span>
            </div>
          )}

          {/* A dead session id is NOT an error the customer caused, and nothing about
              their clouds is broken when it happens — the connections live in their
              own durable record. The shell drops the id and resumes, so this says
              what is happening rather than shouting about a failed read. */}
          {error === 'session_not_found' && (
            <div className="v2-test" style={{ marginTop: 14 }}>
              <span aria-hidden="true">i</span>
              <span>
                That session link is no longer valid, so we are starting a fresh one. Your
                connected clouds are unaffected — anything already connected stays connected.
              </span>
            </div>
          )}

          {error && error !== 'session_not_found' && (
            <div className="v2-test bad" style={{ marginTop: 14 }}>
              <span aria-hidden="true">!</span>
              <span>Could not read the session: {error}</span>
            </div>
          )}
        </div>
      </Panel>

      {/* Pairing, inline. It used to be a phase of its own asking a question with
          one shape of answer; it is the same panel, one screen earlier. */}
      {both && <EnvPairing session={session} onChange={onPairChange} />}

      <WizardFooter
        onNext={() => navigate(`/v2/map-users?${params.toString()}`)}
        nextLabel="Continue to users"
        blocked={!both || paired.done === 0}
        note={!both
          ? (!state.source.connected && !state.destination.connected
            ? 'Connect both clouds to continue'
            : `Connect ${state.source.connected ? 'Google' : 'Microsoft'} to continue`)
          : paired.done === 0
            ? 'Point at least one environment at a Gemini app to continue'
            : `${paired.done} of ${paired.total} environments will migrate`}
      />
    </>
  );

  const inspector = (
    <Inspector>
      <InspectorHead
        kind="Phase"
        title="Connect clouds"
        status={<Chip tone={both ? 'ok' : 'you'}>{both ? 'ready' : 'needs you'}</Chip>}
      />
      <InspectorSection title="What we hold">
        <dl>
          <KeyValue k="Microsoft" v={state.source.account ?? 'not connected'} />
          <KeyValue k="Google" v={state.destination.account ?? 'not connected'} />
        </dl>
      </InspectorSection>
      <InspectorSection title="How access works">
        <Note>
          Dataverse is read with an app-only token, so no user is impersonated on the
          Microsoft side.
        </Note>
        <Note>
          Gemini is written by our service account — either granted directly on your
          project, or delegated by your admin.
        </Note>
        <Note tone="ok">
          No credential value is ever stored in this app. Secrets live in Secret Manager.
        </Note>
      </InspectorSection>
    </Inspector>
  );

  return (
    <V2Layout
      phase="connect"
      phaseStatus={{
        connect: {
          state: both ? 'current' : 'needs-you',
          count: paired.total ? `${paired.done}/${paired.total}` : undefined,
        },
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
