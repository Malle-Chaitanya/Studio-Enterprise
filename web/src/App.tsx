import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSession } from './api.ts';
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
      .catch(() => {
        if (!cancelled) navigate('/', { replace: true });
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

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
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
