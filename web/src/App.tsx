import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSession, resumeSession } from './api.ts';
import { AgentChat } from './components/AgentChat.tsx';
import { WizardProvider } from './context/WizardContext.tsx';
import { IcoLogout } from './icons.tsx';
import { ChoosePair } from './pages/ChoosePair.tsx';
import { Connect } from './pages/Connect.tsx';
import { ConnectorConfig } from './pages/ConnectorConfig.tsx';
import { Connectors } from './pages/Connectors.tsx';
import { Explore } from './pages/Explore.tsx';
import { Home } from './pages/Home.tsx';
import { Login } from './pages/Login.tsx';
import { MapUsers } from './pages/MapUsers.tsx';
import { Migrate } from './pages/Migrate.tsx';
import { SelectData } from './pages/SelectData.tsx';
import { SelectMap } from './pages/SelectMap.tsx';
import ConnectV2 from './pages/v2/ConnectV2.tsx';
import MapUsersV2 from './pages/v2/MapUsersV2.tsx';
import SelectAgentsV2 from './pages/v2/SelectAgentsV2.tsx';
import ConnectorsV2 from './pages/v2/ConnectorsV2.tsx';
import MigrateV2 from './pages/v2/MigrateV2.tsx';
import PhaseSoon from './pages/v2/PhaseSoon.tsx';
import { SourceProvider, resolveSource } from './v2/data/index.ts';

function AppHeader() {
  const navigate = useNavigate();
  /**
   * Sign out for real.
   *
   * This used to POST `/api/logout` — an endpoint that does not exist — swallow the
   * 404, and then PUSH `/` onto history. So the session stayed alive, the wizard pages
   * stayed in history, and Back landed on a fully working screen while Forward returned
   * to the login page: the browser arrows bounced between signed-in and signed-out.
   *
   * Three things are needed and all three were missing: end the session server-side,
   * drop the client-side session ids so nothing can be resumed from them, and REPLACE
   * the history entry so Back does not lead back in.
   */
  const signOut = async () => {
    const session = new URLSearchParams(window.location.search).get('session') ?? '';
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session }),
      });
      // Ending the CLOUD session is not the same as ending the SIGN-IN. Without this the
      // auth cookie survives, so returning to the app skips the login screen entirely —
      // which on a shared machine hands the next person the previous user's account.
      await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* signing out must never strand someone on the page they are leaving */
    }
    // Wizard state is cached per session under csge_* keys — leaving it behind lets a
    // later session pick up the previous user's selections.
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith('csge_')) sessionStorage.removeItem(key);
      }
    } catch {
      /* private mode / storage disabled */
    }
    navigate('/', { replace: true });
  };
  return (
    <header className="appheader">
      <img src="/assets/logo.png" alt="CloudFuze" className="hlogo-img" onClick={() => navigate('/home')} />
      <span className="hdivider" />
      <span className="applogo" style={{ cursor: 'pointer' }} onClick={() => navigate('/home')}>
        CloudFuze <span>AI Migrations</span>
      </span>
      <span className="hstatus">
        <span className="statusdot" />
        Online
        <span className="hdivider" style={{ margin: '0 2px' }} />
        <span className="havatar">CF</span>
        <button className="hsignout" onClick={signOut}>
          <IcoLogout s={13} />
          Sign out
        </button>
      </span>
    </header>
  );
}

const CHAT_WIDTH_KEY = 'csge_chat_width';
const CHAT_COLLAPSED_KEY = 'csge_chat_collapsed';
const CHAT_FAB_POS_KEY = 'csge_chat_fab_pos';
const MIN_CHAT_WIDTH = 300;
const MAX_CHAT_WIDTH = 640;
const DEFAULT_CHAT_WIDTH = 400;
const FAB_SIZE = 48;
const FAB_MARGIN = 20;
const POPUP_WIDTH = 220;
const POPUP_HEIGHT = 130;

function loadChatWidth(): number {
  const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
  return saved >= MIN_CHAT_WIDTH && saved <= MAX_CHAT_WIDTH ? saved : DEFAULT_CHAT_WIDTH;
}

type FabPos = { x: number; y: number };

function loadFabPos(): FabPos | null {
  try {
    const raw = localStorage.getItem(CHAT_FAB_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<FabPos>;
    return typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}

/** Dual-panel shell: workflow left, AI chat right (GEM_CO parity). No
 *  progress/step chrome here — each page's own header carries its context,
 *  matching GEM_CO's minimal per-screen header. The divider between them is
 *  drag-to-resize, same mechanism as GEM_CO's `.drag-divider` (mousedown →
 *  document-level mousemove/mouseup so dragging keeps working even if the
 *  pointer leaves the thin divider strip). */

/**
 * Send someone back to the login page when the session in the URL is gone.
 *
 * After signing out, the browser's Back button still restores a wizard URL carrying
 * `?session=<id>`. The page renders, fires its API calls, and shows a wall of errors
 * instead of saying the obvious thing: you are signed out.
 *
 * Only acts when a session id is PRESENT and rejected. A missing id is left alone —
 * pages reach their own conclusions about that, and redirecting on absence would
 * hijack normal navigation.
 */
function SessionGuard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchSession(session)
      .catch((e: Error) => {
        // ONLY a rejected id sends someone back to sign in. A 500 or a server
        // restart mid-request used to do it too, which threw away a working
        // session and the whole flow behind it over one bad response.
        if (!cancelled && e.message === 'session_not_found') navigate('/', { replace: true });
      });
    return () => { cancelled = true; };
  }, [session, navigate]);

  return null;
}

function AppShell() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(loadChatWidth());
  const [chatWidth, setChatWidth] = useState(widthRef.current);
  const [chatCollapsed, setChatCollapsed] = useState(() => localStorage.getItem(CHAT_COLLAPSED_KEY) === '1');
  const [fabHover, setFabHover] = useState(false);
  // The intro callout dismisses per-shell-mount (not persisted) — a fresh
  // page load is a reasonable moment to remind the user what the FAB does.
  const [popupDismissed, setPopupDismissed] = useState(false);
  // null = default bottom-right corner (CSS-anchored); set once the user
  // drags the bubble, then persisted so it stays put across reloads.
  const [fabPos, setFabPos] = useState<FabPos | null>(loadFabPos);
  const fabDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; dragged: boolean } | null>(null);

  const handleFabMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const origin = fabPos ?? { x: rect.width - FAB_SIZE - FAB_MARGIN, y: rect.height - FAB_SIZE - FAB_MARGIN };
      fabDragRef.current = { startX: e.clientX, startY: e.clientY, origX: origin.x, origY: origin.y, dragged: false };
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        const drag = fabDragRef.current;
        const r = containerRef.current?.getBoundingClientRect();
        if (!drag || !r) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.dragged = true;
        setFabPos({
          x: Math.max(0, Math.min(r.width - FAB_SIZE, drag.origX + dx)),
          y: Math.max(0, Math.min(r.height - FAB_SIZE, drag.origY + dy)),
        });
      };
      const onUp = () => {
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (fabDragRef.current?.dragged) {
          setFabPos((p) => {
            if (p) localStorage.setItem(CHAT_FAB_POS_KEY, JSON.stringify(p));
            return p;
          });
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [fabPos],
  );

  const closeChat = useCallback(() => {
    setChatCollapsed(true);
    localStorage.setItem(CHAT_COLLAPSED_KEY, '1');
  }, []);
  const openChat = useCallback(() => {
    setChatCollapsed(false);
    localStorage.setItem(CHAT_COLLAPSED_KEY, '0');
  }, []);

  const handleFabClick = useCallback(() => {
    // A drag ends with a click on the same element — swallow it so dropping
    // the bubble somewhere doesn't also pop the chat open.
    if (fabDragRef.current?.dragged) {
      fabDragRef.current = null;
      return;
    }
    fabDragRef.current = null;
    openChat();
  }, [openChat]);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dividerRef.current?.classList.add('active');
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Chat pane hugs the right edge — its width is the distance from the
      // cursor to that edge. Keep at least 360px for the workflow pane.
      const max = Math.min(MAX_CHAT_WIDTH, rect.width - 360);
      const next = Math.max(MIN_CHAT_WIDTH, Math.min(max, rect.right - ev.clientX));
      widthRef.current = next;
      setChatWidth(next);
    };
    const onUp = () => {
      dividerRef.current?.classList.remove('active');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem(CHAT_WIDTH_KEY, String(widthRef.current));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // The popup (220x~130) is anchored to the button but rendered outside the
  // wrap's own tiny box, so it can overflow the console on whichever side
  // the button has been dragged closest to. Flip to the opposite side once
  // there isn't room, rather than letting it run off-screen.
  const consoleRect = containerRef.current?.getBoundingClientRect();
  const fabAnchorX = fabPos?.x ?? (consoleRect ? consoleRect.width - FAB_SIZE - FAB_MARGIN : 0);
  const fabAnchorY = fabPos?.y ?? (consoleRect ? consoleRect.height - FAB_SIZE - FAB_MARGIN : 0);
  const popupFlipX = fabAnchorX + FAB_SIZE - POPUP_WIDTH < 8;
  const popupFlipY = fabAnchorY - POPUP_HEIGHT - 10 < 8;

  return (
    <WizardProvider>
      <SessionGuard />
      <AppHeader />
      <div className="console" ref={containerRef}>
        <div className="pane-workflow">
          <div className="shell">
            <Outlet />
          </div>
        </div>
        {chatCollapsed ? (
          <div className="chat-fab-wrap" style={fabPos ? { left: fabPos.x, top: fabPos.y, right: 'auto', bottom: 'auto' } : undefined}>
            {!popupDismissed && (
              <div className={`chat-fab-popup ${fabHover ? 'hover' : ''} ${popupFlipX ? 'flip-x' : ''} ${popupFlipY ? 'flip-y' : ''}`}>
                <button
                  type="button"
                  className="chat-fab-popup-close"
                  onClick={() => setPopupDismissed(true)}
                  aria-label="Dismiss"
                >
                  ×
                </button>
                <div className="chat-fab-popup-head">
                  <span className="chat-fab-popup-icon">✦</span>
                  <span className="chat-fab-popup-title">CloudFuze AI Migrations Assistant</span>
                </div>
                <div className="chat-fab-popup-desc">Ask about mapping, agents, or migration — I'm here to help.</div>
                <div className={`chat-fab-popup-arrow ${popupFlipX ? 'flip-x' : ''} ${popupFlipY ? 'flip-y' : ''}`} aria-hidden />
              </div>
            )}
            <button
              type="button"
              className="chat-fab"
              onMouseDown={handleFabMouseDown}
              onClick={handleFabClick}
              onMouseEnter={() => setFabHover(true)}
              onMouseLeave={() => setFabHover(false)}
              aria-label="Open assistant"
            >
              ✦
            </button>
          </div>
        ) : (
          <>
            <div className="divider" ref={dividerRef} onMouseDown={handleDividerMouseDown} aria-hidden />
            <div className="pane-chat" style={{ width: chatWidth }}>
              <AgentChat onClose={closeChat} />
            </div>
          </>
        )}
      </div>
    </WizardProvider>
  );
}

/**
 * Shell for the v2 (agent-dock) screens.
 *
 * Same header, guard and wizard context as AppShell — but no chat pane and no
 * divider, because in v2 the agent IS the dock at the bottom of the page. The
 * two shells run side by side while the v2 slice is proven; the old one stays
 * untouched so nothing that works today can regress.
 */
/** The session id fixture mode uses when none is given. It names nothing on the
 *  server — in fixture mode it is only a key for browser-local state. */
const FIXTURE_SESSION = 'ui';

function V2Shell() {
  const [params, setParams] = useSearchParams();
  // The data source is chosen once, here, and handed down: screens never decide
  // where their data comes from. `?fixture=1` is honoured in dev builds only.
  const source = useMemo(() => resolveSource(params), [params]);

  // Fixture mode needs *a* session id because every screen reads one, but asking a
  // reviewer to invent one is friction for no reason. Fill it in and move on.
  useEffect(() => {
    if (source.isFixture && !params.get('session')) {
      const next = new URLSearchParams(params);
      next.set('session', FIXTURE_SESSION);
      setParams(next, { replace: true });
    }
  }, [source.isFixture, params, setParams]);

  /**
   * Adopt the signed-in user's existing session when the URL has none.
   *
   * Without this, opening /v2 bare left every screen with session '', which meant
   * each read early-returned and the Connect cards sat at "not connected" forever
   * — including after a sign-in that actually succeeded. Nothing failed visibly,
   * which is the worst shape a failure can take.
   */
  const [resume, setResume] = useState<'idle' | 'looking' | 'none'>('idle');
  const sessionParam = params.get('session') ?? '';
  /**
   * A session id the SERVER has rejected.
   *
   * `migrationSessions` has no TTL on purpose — a cloud connection persists until
   * someone disconnects it — so a 404 here does not mean "expired", it means the doc
   * is gone and this id will never work again. Holding on to it made every screen
   * read fail forever: the browser kept presenting a dead id, and because resume
   * only ran when there was NO id, recovery could never start. Nothing about the
   * customer's clouds is wrong in this state, which is why it must not read as a
   * failure.
   */
  const [deadSession, setDeadSession] = useState('');
  useEffect(() => {
    if (source.isFixture || !sessionParam || deadSession === sessionParam) return;
    let live = true;
    void fetchSession(sessionParam).catch((e: Error) => {
      // Only a rejected ID is fatal to the id. A network blip must not throw away a
      // perfectly good session and silently start a new one.
      if (live && e.message === 'session_not_found') setDeadSession(sessionParam);
    });
    return () => { live = false; };
  }, [source.isFixture, sessionParam, deadSession]);

  // Drop the dead id from the URL, which re-arms the resume below.
  useEffect(() => {
    if (!deadSession || sessionParam !== deadSession) return;
    const next = new URLSearchParams(params);
    next.delete('session');
    setParams(next, { replace: true });
  }, [deadSession, sessionParam, params, setParams]);

  const hasSession = Boolean(sessionParam) && sessionParam !== deadSession;
  useEffect(() => {
    if (source.isFixture || hasSession || sessionParam) return;
    let live = true;
    setResume('looking');
    void resumeSession().then((id) => {
      if (!live) return;
      if (id) {
        const next = new URLSearchParams(params);
        next.set('session', id);
        setParams(next, { replace: true });
        setResume('idle');
      } else {
        setResume('none');
      }
    }).catch(() => { if (live) setResume('none'); });
    return () => { live = false; };
  }, [source.isFixture, hasSession, params, setParams]);

  return (
    <WizardProvider>
      <SourceProvider value={source}>
        {/* No SessionGuard here on purpose. It answers a dead id by returning to
            sign in, which for v2 is the wrong answer twice over: the customer is
            already signed in, and their clouds are still connected in their own
            durable record — only the migration session doc is gone. This shell
            recovers instead: the dead id is dropped and a live session resumed, and
            if there genuinely is none, the "no session" state below says so. */}
        <AppHeader />
        {!source.isFixture && !hasSession ? (
          // No session, said out loud. A blank "not connected" card is a lie when
          // the truth is that this page does not know which migration it is on.
          <div className="v2">
            <div className="v2-frame">
              <main className="v2-canvas">
                <div className="v2-panel">
                  <div className="v2-panel-h">
                    <div>
                      <h2>{resume === 'looking' ? 'Looking for your migration…' : 'No migration session'}</h2>
                      <div className="sub">
                        {resume === 'looking'
                          ? 'Checking whether you already have a connected session.'
                          : 'This page needs a session id, and you have no connected session yet. Start one from Home — connecting a cloud creates it.'}
                      </div>
                    </div>
                  </div>
                  {resume === 'none' && (
                    <div className="v2-row note">
                      <span className="why">
                        <a className="v2-btn blue" href="/home">Go to Home</a>
                      </span>
                    </div>
                  )}
                </div>
              </main>
            </div>
          </div>
        ) : <Outlet />}
      </SourceProvider>
    </WizardProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route element={<V2Shell />}>
        <Route path="/v2/connect" element={<ConnectV2 />} />
        {/* Merged into Connect. Kept as a redirect so an old link still lands
            somewhere true instead of on a "phase not built" page. */}
        <Route path="/v2/pair-envs" element={<Navigate to="/v2/connect" replace />} />
        <Route path="/v2/map-users" element={<MapUsersV2 />} />
        <Route path="/v2/select-agents" element={<SelectAgentsV2 />} />
        <Route path="/v2/connectors" element={<ConnectorsV2 />} />
        <Route path="/v2/migrate" element={<MigrateV2 />} />
        {/* The fidelity report screen was removed on request. Redirected, not
            404'd, so an existing link lands on the run it belonged to. What a
            migration cost is still recorded server-side per run and still shows on
            Migrate while the run is on screen. */}
        <Route path="/v2/report" element={<Navigate to="/v2/migrate" replace />} />
        {/* Kept as the catch-all: a mistyped phase says so instead of blanking. */}
        <Route path="/v2/:phase" element={<PhaseSoon />} />
        <Route path="/v2" element={<Navigate to="/v2/connect" replace />} />
      </Route>
      <Route element={<AppShell />}>
        <Route path="/home" element={<Home />} />
        <Route path="/pair" element={<ChoosePair />} />
        <Route path="/map-users" element={<MapUsers />} />
        <Route path="/connector-config" element={<ConnectorConfig />} />
        <Route path="/map" element={<SelectMap />} />
        <Route path="/select-data" element={<SelectData />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/explore" element={<Explore />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/migrate" element={<Migrate />} />
      </Route>
    </Routes>
  );
}
