import { describe, expect, it, vi } from 'vitest';

/**
 * The rate-limit exemption is the only thing this token buys, and the property
 * that matters is that it cannot be talked into exempting anybody else. Tested
 * against the real predicate rather than through the limiter, because
 * `NODE_ENV=test` makes the limiter skip unconditionally — a test driven through
 * it would pass whatever this function did.
 */
const TOKEN = 'x'.repeat(32);

async function loadWithToken(token: string | undefined) {
  if (token === undefined) delete process.env.INTERNAL_REQUEST_TOKEN;
  else process.env.INTERNAL_REQUEST_TOKEN = token;

  vi.resetModules();
  return await import('../src/app.js');
}

describe('isInternalToken', () => {
  it('exempts a caller presenting the configured token', async () => {
    const { isInternalToken } = await loadWithToken(TOKEN);

    expect(isInternalToken(TOKEN)).toBe(true);
  });

  it('exempts nobody when no token is configured', async () => {
    const { isInternalToken } = await loadWithToken(undefined);

    expect(isInternalToken(TOKEN)).toBe(false);
    expect(isInternalToken('')).toBe(false);
    expect(isInternalToken(undefined)).toBe(false);
  });

  it('exempts nobody presenting no token', async () => {
    const { isInternalToken } = await loadWithToken(TOKEN);

    expect(isInternalToken(undefined)).toBe(false);
    expect(isInternalToken('')).toBe(false);
  });

  /**
   * The exemption is deliberately not keyed on User-Agent — that header is the
   * first thing a caller wanting to skip the limiter would set. The predicate
   * cannot even see it now, and the warm's own agent string is not a token.
   */
  it('does not treat the warm job user agent as a token', async () => {
    const { isInternalToken } = await loadWithToken(TOKEN);

    expect(
      isInternalToken(
        'MachiyaBot/0.1 (+https://github.com/Kunal-jaiswal972/Machiya; internal POI cache warm)',
      ),
    ).toBe(false);
  });

  it('rejects a wrong token, including a prefix and an extension of the real one', async () => {
    const { isInternalToken } = await loadWithToken(TOKEN);

    expect(isInternalToken('y'.repeat(32))).toBe(false);
    expect(isInternalToken(TOKEN.slice(0, 31))).toBe(false);
    expect(isInternalToken(`${TOKEN}z`)).toBe(false);
  });
});
