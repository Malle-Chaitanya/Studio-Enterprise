import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resumeSession } from '../api.ts';

const CHECK = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * Sign-in screen — matches GEM_CO's split-screen login exactly (deep-blue left
 * panel + white card on the right), copy adapted to Copilot Studio → Gemini.
 *
 * This used to be a doorway with no lock: it POSTed to `/api/login`, which did not exist,
 * and treated everything except a 401 as success — so any input signed you in. Now only a
 * 2xx proceeds, and the httpOnly cookie the server sets is what every later request is
 * authorized by.
 */
export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server answers with an httpOnly session cookie; without credentials the
        // browser would drop it and every later request would be anonymous.
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const sid = await resumeSession();
        // v2 is the product now. The old wizard stays REACHABLE at /home and its
        // other routes — nothing is deleted while Migrate and Report are still
        // being compared against it — but it is no longer where signing in lands.
        navigate(sid ? `/v2/connect?session=${sid}` : '/v2/connect');
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      // Distinguish "wrong password" from "the accounts database is down" — telling an
      // operator their credentials are wrong when the server cannot check them sends them
      // hunting for the wrong problem.
      setError(
        res.status === 503
          ? data.detail || 'Sign-in is temporarily unavailable. Try again shortly.'
          : 'Invalid email or password.',
      );
    } catch {
      setError('Could not reach the server. Check it is running and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-left">
        <div className="login-logo">
          <img src="/assets/logo.png" alt="CloudFuze" style={{ height: 34, objectFit: 'contain' }} />
          <div className="login-logo-divider" />
          <span className="login-logo-text">CloudFuze AI Migrations</span>
        </div>
        <div className="login-content">
          <div className="login-tag">Enterprise AI Agent Migration</div>
          <div className="login-title">
            <span>CloudFuze</span>
            <br />
            AI Migrations
          </div>
          <div className="login-desc">
            Migrate AI agents from Microsoft Copilot Studio to Google Gemini Enterprise — fully
            automated, faithfully mapped, with a fidelity report for every agent.
          </div>
          <div className="login-bullets">
            <div className="login-bullet">
              <div className="login-bullet-icon">{CHECK}</div>
              Extract agents, topics, and knowledge from Copilot Studio
            </div>
            <div className="login-bullet">
              <div className="login-bullet-icon">{CHECK}</div>
              Faithfully map instructions, tools, and behavior into Gemini
            </div>
            <div className="login-bullet">
              <div className="login-bullet-icon">{CHECK}</div>
              Per-agent assessment — what migrates automatically vs. needs review
            </div>
          </div>
        </div>
        <div className="login-footer">CloudFuze © 2026. All rights reserved.</div>
      </div>

      <div className="login-right">
        <div className="login-card">
          <div className="login-card-logo">
            <img src="/assets/CloudFuze blue.png" alt="CloudFuze" style={{ height: 72, objectFit: 'contain' }} />
          </div>
          <div className="login-card-title">Welcome back</div>
          <div className="login-card-sub">Sign in to access the migration tool</div>

          {error && (
            <div className="login-error">
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={submit}>
            <div className="login-field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                required
              />
            </div>
            <div className="login-field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>
            <button type="submit" className="login-submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
