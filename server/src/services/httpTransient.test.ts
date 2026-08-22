import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchTextTransient, isTransientNetworkError } from './httpTransient.js';

/**
 * The failure this module exists to stop: a response whose HEADERS arrive fine and whose BODY
 * is then cut off.
 *
 * `fetch` resolves on headers. Every ADK call site had a try/catch around the fetch and a bare
 * `await res.text()` on the next line, so a mid-body reset walked past the guard as an
 * uncaught `TypeError: terminated` and failed a whole migration run — on 2026-08-22, one whose
 * agent had ALREADY deployed and shared successfully. Four minutes of deploy work recorded as
 * a failure because of a blip on the operator's link.
 *
 * These tests drive a real socket that behaves that way, rather than mocking fetch: the whole
 * point is that the throw comes from undici's body stream, which a mock would not reproduce.
 */
describe('fetchTextTransient', () => {
  let server: Server;
  let base: string;
  /** How many requests each scripted path has seen — lets a test assert a retry happened. */
  const hits: Record<string, number> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      hits[path] = (hits[path] ?? 0) + 1;

      if (path === '/abort-body') {
        // Headers + a partial body, then destroy the socket. This is the exact shape that
        // produces `TypeError: terminated ... caused by: read ECONNRESET`.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '2000' });
        res.write('{"partial":');
        res.socket?.destroy();
        return;
      }
      if (path === '/abort-once') {
        // Fails the same way on the first attempt only, so a retry can succeed.
        if (hits[path] === 1) {
          res.writeHead(200, { 'Content-Length': '2000' });
          res.write('{"partial":');
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (path === '/server-error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }
      if (path === '/rate-limited') {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('slow down');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"hello":"world"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('contains a mid-body abort instead of throwing', async () => {
    // Without the fix this is an uncaught TypeError that escapes into the orchestrator.
    const r = await fetchTextTransient(`${base}/abort-body`, {}, { retries: 1, baseMs: 1, label: 'test' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/terminated|ECONNRESET|socket|fetch failed/i);
  });

  it('retries a mid-body abort and succeeds on the second attempt', async () => {
    const r = await fetchTextTransient(`${base}/abort-once`, {}, { retries: 3, baseMs: 1, label: 'test' });
    expect(r.ok, 'the retry should have produced a good response').toBe(true);
    if (r.ok) expect(r.text).toBe('{"ok":true}');
    expect(hits['/abort-once'], 'the request should have been made twice').toBe(2);
  });

  it('returns the body and status on success', async () => {
    const r = await fetchTextTransient(`${base}/ok`, {}, { baseMs: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.text).toBe('{"hello":"world"}');
    }
  });

  it('does NOT retry an HTTP error status — a status is a definitive answer', async () => {
    // Retrying here would hide a real 500 behind extra latency, and for 429 it would bypass
    // rateLimiter.ts, which owns the quota backoff decision.
    const before = hits['/server-error'] ?? 0;
    const r = await fetchTextTransient(`${base}/server-error`, {}, { retries: 3, baseMs: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe(500);
    expect((hits['/server-error'] ?? 0) - before).toBe(1);
  });

  it('does not retry a 429 either — quota backoff belongs to the rate limiter', async () => {
    const before = hits['/rate-limited'] ?? 0;
    const r = await fetchTextTransient(`${base}/rate-limited`, {}, { retries: 3, baseMs: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe(429);
    expect((hits['/rate-limited'] ?? 0) - before).toBe(1);
  });

  it('gives up after the retry budget rather than looping', async () => {
    const before = hits['/abort-body'] ?? 0;
    const r = await fetchTextTransient(`${base}/abort-body`, {}, { retries: 2, baseMs: 1 });
    expect(r.ok).toBe(false);
    expect((hits['/abort-body'] ?? 0) - before).toBe(3); // initial + 2 retries
  });
});

describe('isTransientNetworkError', () => {
  it('recognises undici\'s bare "terminated", whose detail is on the cause', () => {
    // The outer error message is literally the single word "terminated" — a predicate that
    // only matched ECONNRESET on the top-level message missed this entirely.
    const err = new TypeError('terminated');
    (err as { cause?: Error }).cause = new Error('read ECONNRESET');
    expect(isTransientNetworkError(err)).toBe(true);
    expect(isTransientNetworkError(new TypeError('terminated'))).toBe(true);
  });

  it('does not treat an application error as transient', () => {
    expect(isTransientNetworkError(new Error('400 INVALID_ARGUMENT: bad spec'))).toBe(false);
    expect(isTransientNetworkError(new Error('permission denied'))).toBe(false);
  });
});

describe('ADK call sites read their bodies through the guarded helper', () => {
  // Structural, and deliberately so: the regression is not "the helper is wrong", it is
  // "someone added another bare fetch + res.text() pair". That is invisible to any behavioural
  // test, because the call sites hardcode googleapis.com and cannot be pointed at a fixture.
  const SRC = readFileSync(join(process.cwd(), 'src', 'services', 'adkAgentChat.ts'), 'utf8');

  it('has no bare fetch( left in adkAgentChat.ts', () => {
    const bare = SRC.split('\n').filter((l) => /(?<!fetchText)\bfetch\(/.test(l) && !l.trim().startsWith('*'));
    expect(bare, `these lines call fetch directly: ${bare.join(' | ')}`).toEqual([]);
  });

  it('never reads a response body outside the helper', () => {
    expect(SRC).not.toMatch(/await res\.(text|json)\(\)/);
  });
});
