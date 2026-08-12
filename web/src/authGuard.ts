/**
 * Send the user back to sign-in when the server says they are not signed in.
 *
 * Installed as a `window.fetch` wrapper rather than added to each of the ~40 typed
 * wrappers in `api.ts`. Those wrappers throw a plain `Error(code)` on non-OK responses and
 * each page catches it and renders a message, so without this a expired session shows up
 * as "Failed to load environments" on eight different screens — a wrong diagnosis in every
 * one of them.
 *
 * Only `/api/*` responses are considered, and only 401. A 403 (`session_not_yours`) is
 * deliberately NOT a redirect: you are signed in, you simply asked for someone else's
 * session, and bouncing you to a login form would suggest signing in again would help.
 */
const LOGIN_PATH = '/';

export function installAuthGuard(): void {
  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (res.status === 401 && url.includes('/api/')) {
      // The sign-in endpoints answer 401 as their normal "no" — redirecting on those would
      // reload the login page out from under someone who just mistyped a password.
      const isAuthProbe = url.includes('/api/login') || url.includes('/api/me');
      if (!isAuthProbe && window.location.pathname !== LOGIN_PATH) {
        window.location.assign(LOGIN_PATH);
      }
    }
    return res;
  };
}
