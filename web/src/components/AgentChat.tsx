import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { connectViaPopup, googleStartUrl, microsoftStartUrl } from '../api.ts';
import { useWizard, type WizardStepId } from '../context/WizardContext.tsx';
import { renderMarkdownLite } from '../markdownLite.tsx';

interface ChatMsg {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  /** Silent page-orientation turns (no user bubble triggered them) render as a
   *  light status line instead of a full chat bubble, so navigating around
   *  the app doesn't read as a new heavy AI reply every time. */
  light?: boolean;
}

const STEP_CHIPS: Record<string, string[]> = {
  '/home': ['Connect Microsoft', 'Connect Google', 'Continue to pair'],
  '/connect': ['How do I connect?', 'Continue to pair'],
  '/pair': ['Continue to Map Users', 'Explain this pair'],
  '/map-users': ['Auto-map users', 'Go to environments', 'Clear mappings'],
  '/map': ['List environments', 'Go to Select Agents', 'Show connectors'],
  '/select-data': ['Select all agents', 'Go to migrate', 'Why is an agent private?'],
  '/connectors': ['Show connectors', 'Continue to migrate'],
  '/migrate': ['Start dry run', 'Start live migration', 'Explain fidelity'],
};

function pathToStep(pathname: string): WizardStepId {
  if (pathname.startsWith('/map-users')) return 'map-users';
  if (pathname.startsWith('/select-data')) return 'select-data';
  if (pathname.startsWith('/connectors')) return 'connectors';
  if (pathname.startsWith('/migrate')) return 'migrate';
  if (pathname.startsWith('/map') || pathname.startsWith('/explore')) return 'map';
  if (pathname.startsWith('/pair')) return 'pair';
  if (pathname.startsWith('/connect')) return 'connect';
  return 'connect';
}

let msgSeq = 0;
const nid = () => `m${Date.now()}-${++msgSeq}`;

/**
 * Right-panel Studio Migrate AI chat. Streams SSE from /api/agent/chat and
 * applies tool events to the left workflow via WizardContext.
 */
export function AgentChat({ onClose }: { onClose?: () => void }) {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const wizard = useWizard();
  const [connecting, setConnecting] = useState<null | 'microsoft' | 'google'>(null);
  const [busyLight, setBusyLight] = useState(false);
  // No hardcoded greeting — the first message is the same live, page-aware
  // orientation turn used on every navigation (see the effect below), so it
  // reflects whatever's actually on screen instead of a generic canned line.
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<string[]>(STEP_CHIPS['/home'] ?? []);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChips(STEP_CHIPS[pathname] ?? STEP_CHIPS['/migrate'] ?? []);
  }, [pathname]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, busy, wizard.pendingConfirm]);

  const handleUiEvent = useCallback(
    (ev: Record<string, unknown>) => {
      const type = String(ev.type ?? '');
      if (type === 'navigate_to_step') {
        wizard.navigateToStep(String(ev.step ?? ''));
      } else if (type === 'set_user_mapping') {
        const users = (ev.users as Record<string, string>) ?? {};
        if (ev.sourceEmail && ev.destEmail) {
          wizard.applyUserMapping({ [String(ev.sourceEmail)]: String(ev.destEmail) }, true);
        } else {
          wizard.applyUserMapping(users, ev.merge !== false);
        }
      } else if (type === 'auto_map_users' || type === 'mappings_updated') {
        const users = (ev.users as Record<string, string>) ?? {};
        wizard.applyUserMapping(users, false);
      } else if (type === 'clear_mappings') {
        wizard.clearUserMappings();
      } else if (type === 'set_environment_map') {
        wizard.setEnvironmentMap((ev.envs as { env: string; name: string }[]) ?? []);
      } else if (type === 'set_agent_selection') {
        wizard.setAgentSelection((ev.units as { env: string; name: string; botIds: string[] }[]) ?? []);
      } else if (type === 'start_migration') {
        wizard.requestMigration({ dryRun: !!ev.dryRun });
        wizard.navigateToStep('migrate');
      } else if (type === 'show_connectors') {
        wizard.navigateToStep('connectors');
      } else if (type === 'confirm_required') {
        wizard.setPendingConfirm({
          tool: String(ev.tool ?? 'start_migration'),
          args: (ev.args as Record<string, unknown>) ?? {},
          message: String(ev.message ?? 'Confirm this action?'),
        });
      }
      wizard.emitToolEvent(ev as { type: string });
    },
    [wizard],
  );

  // OAuth popups can only be opened from the client — there's no server tool
  // for "Connect Microsoft"/"Connect Google" (the LLM can't drive a browser
  // popup), so these two chip labels are intercepted before ever reaching
  // /api/agent/chat, mirroring Home.tsx's own connect handlers.
  const connectMicrosoft = useCallback(async () => {
    setConnecting('microsoft');
    const r = await connectViaPopup(microsoftStartUrl(), 'ms-auth-success', 'ms-auth-error');
    setConnecting(null);
    if (r.ok && r.session) {
      navigate(`/home?session=${r.session}`);
    } else {
      setMsgs((m) => [...m, { id: nid(), role: 'agent', text: 'Microsoft connection was cancelled or failed — try again.' }]);
    }
  }, [navigate]);

  const connectGoogle = useCallback(async () => {
    if (!session) {
      setMsgs((m) => [
        ...m,
        { id: nid(), role: 'agent', text: 'Connect Microsoft (the source) first — Google unlocks right after.' },
      ]);
      return;
    }
    setConnecting('google');
    const r = await connectViaPopup(googleStartUrl(session), 'google-auth-success', 'google-auth-error');
    setConnecting(null);
    if (!r.ok) {
      setMsgs((m) => [...m, { id: nid(), role: 'agent', text: 'Google connection was cancelled or failed — try again.' }]);
    }
  }, [session]);

  const send = useCallback(
    async (
      text: string,
      opts?: {
        confirmed?: boolean;
        confirmTool?: string;
        confirmArgs?: Record<string, unknown>;
        systemTrigger?: boolean;
        actionNote?: string;
      },
    ) => {
      const trimmed = text.trim();
      if (!trimmed && !opts?.confirmed && !opts?.systemTrigger) return;
      if (busy) return;

      const light = !!opts?.systemTrigger;

      if (trimmed) {
        setMsgs((m) => [...m, { id: nid(), role: 'user', text: trimmed }]);
        setInput('');
      }
      setBusy(true);
      setBusyLight(light);
      wizard.setPendingConfirm(null);

      try {
        const res = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session,
            message: trimmed || (opts?.confirmed ? 'confirmed' : ''),
            step: pathToStep(pathname),
            pathname,
            confirmed: opts?.confirmed,
            confirmTool: opts?.confirmTool,
            confirmArgs: opts?.confirmArgs,
            systemTrigger: !!opts?.systemTrigger,
            actionNote: opts?.actionNote,
            clientState: {
              envs: safeJson(`csge_envs_${session}`),
              agents: safeJson(`csge_data_${session}`),
              userMap: safeJson(`csge_usermap_${session}`),
            },
          }),
        });

        if (!res.ok || !res.body) {
          const err = await res.text().catch(() => 'chat_failed');
          setMsgs((m) => [...m, { id: nid(), role: 'agent', text: `Sorry — chat failed (${err.slice(0, 120)}).`, light }]);
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let agentText = '';
        let agentId = nid();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(line.slice(6)) as Record<string, unknown>;
            } catch {
              continue;
            }
            const t = String(data.type ?? '');
            if (t === 'token' || t === 'delta') {
              agentText += String(data.text ?? data.delta ?? '');
              const snap = agentText;
              setMsgs((m) => {
                const without = m.filter((x) => x.id !== agentId);
                return [...without, { id: agentId, role: 'agent', text: snap, light }];
              });
            } else if (t === 'message' || t === 'reply') {
              agentText = String(data.text ?? data.message ?? agentText);
              const snap = agentText;
              setMsgs((m) => {
                const without = m.filter((x) => x.id !== agentId);
                return [...without, { id: agentId, role: 'agent', text: snap, light }];
              });
            } else if (t === 'ui_event' || t === 'tool_event') {
              handleUiEvent((data.event as Record<string, unknown>) ?? data);
            } else if (t === 'chips') {
              const next = data.chips as string[] | undefined;
              if (Array.isArray(next) && next.length) setChips(next);
            } else if (t === 'error') {
              setMsgs((m) => [
                ...m,
                { id: nid(), role: 'agent', text: String(data.message ?? data.error ?? 'Something went wrong.'), light },
              ]);
            } else if (t === 'done') {
              if (data.text && !agentText) {
                setMsgs((m) => [...m, { id: agentId, role: 'agent', text: String(data.text), light }]);
              }
            }
          }
        }
      } catch (e) {
        setMsgs((m) => [
          ...m,
          { id: nid(), role: 'agent', text: `Chat error: ${(e as Error).message}`, light },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, handleUiEvent, pathname, session, wizard],
  );

  const orientedRef = useRef<Set<string>>(new Set());

  // A session change (disconnect → reconnect gets a new id, same route) isn't
  // a remount — clear the transcript and re-arm orientation so the chat
  // doesn't keep showing a conversation tied to a session that's gone, or
  // skip re-greeting because the old session already "used up" that step.
  const prevSessionRef = useRef(session);
  useEffect(() => {
    if (prevSessionRef.current === session) return;
    prevSessionRef.current = session;
    setMsgs([]);
    orientedRef.current.clear();
  }, [session]);

  // Auto-orient on step change AND react to in-page actions (pages call
  // wizard.notifyAction() after things like toggling an environment or
  // starting a migration) — but as ONE combined effect, not two independent
  // ones. Kept separate, an action that also navigates to a new step (e.g.
  // starting a migration lands on "migrate") fired BOTH a short action-ack
  // AND a full step-welcome message for the same click — two agent bubbles,
  // the second one a redundant, longer "Welcome to..." stacked under the
  // useful one. The action ack already orients the user, so it takes
  // priority and counts as having welcomed that step too.
  const lastActionSentRef = useRef(0);
  useEffect(() => {
    if (!session) return;
    const step = pathToStep(pathname);
    const freshAction = wizard.lastAction && wizard.lastAction.ts !== lastActionSentRef.current;

    if (freshAction) {
      lastActionSentRef.current = wizard.lastAction!.ts;
      orientedRef.current.add(step);
      void send('', { systemTrigger: true, actionNote: wizard.lastAction!.text });
      return;
    }
    if (orientedRef.current.has(step)) return;
    orientedRef.current.add(step);
    void send('', { systemTrigger: true });
  }, [pathname, wizard.lastAction, session, send]);

  const onConfirm = (yes: boolean) => {
    const pending = wizard.pendingConfirm;
    if (!pending) return;
    if (yes) {
      void send('yes, proceed', {
        confirmed: true,
        confirmTool: pending.tool,
        confirmArgs: pending.args,
      });
    } else {
      wizard.setPendingConfirm(null);
      setMsgs((m) => [...m, { id: nid(), role: 'agent', text: 'Cancelled — nothing was started.' }]);
    }
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="chat-avatar">✦</div>
        <div>
          <div className="chat-title">CloudFuze AI Migrations Assistant</div>
          <div className="chat-sub">{session ? 'Connected session' : 'Connect a platform to get started'}</div>
        </div>
        {onClose && (
          <button type="button" className="chat-close" onClick={onClose} title="Close assistant" aria-label="Close assistant">
            ×
          </button>
        )}
      </div>

      <div className="chat-msgs">
        {msgs.length === 0 && !busy && !session && (
          <div className="cmsg agent">
            <div className="cmsg-av">✦</div>
            <div className="cmsg-body">
              <div className="cmsg-bubble">Tap "Connect Microsoft" below to get started — I'll walk you through the rest.</div>
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`cmsg ${m.role === 'user' ? 'user' : 'agent'} ${m.light ? 'light' : ''}`}>
            {m.role !== 'user' && <div className="cmsg-av">✦</div>}
            <div className="cmsg-body">
              <div className="cmsg-bubble">{m.role === 'user' ? m.text : renderMarkdownLite(m.text)}</div>
            </div>
          </div>
        ))}
        {busy && (
          <div className={`cmsg agent ${busyLight ? 'light' : ''}`}>
            <div className="cmsg-av">✦</div>
            <div className="cmsg-body">
              <div className="cmsg-bubble">
                <div className="typing">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {wizard.pendingConfirm && (
        <div className="chat-confirm">
          <div>{wizard.pendingConfirm.message}</div>
          <div className="chat-confirm-actions">
            <button
              type="button"
              className={wizard.pendingConfirm.args.dryRun === false ? 'danger' : 'ok'}
              onClick={() => onConfirm(true)}
            >
              Confirm
            </button>
            <button type="button" onClick={() => onConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="chat-chips">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            className="chat-chip"
            disabled={busy || connecting !== null}
            onClick={() => {
              if (c === 'Connect Microsoft') return void connectMicrosoft();
              if (c === 'Connect Google') return void connectGoogle();
              void send(c);
            }}
          >
            {connecting === 'microsoft' && c === 'Connect Microsoft'
              ? 'Connecting…'
              : connecting === 'google' && c === 'Connect Google'
                ? 'Connecting…'
                : c}
          </button>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          rows={1}
          placeholder={session ? 'Ask about mapping, agents, or migration…' : 'Open a session to chat…'}
          value={input}
          disabled={!session || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button
          type="button"
          className="chat-send"
          disabled={!session || busy || !input.trim()}
          onClick={() => void send(input)}
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function safeJson(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
