import { logger } from '../logger.js';
import { isAllowed, robotsFor } from './robots.js';

/**
 * The one way an adapter reaches the internet: robots first, then retry with
 * backoff, then hand back text.
 *
 * Centralised so no adapter can accidentally skip the robots check or invent
 * its own retry policy — and so the politeness rules are in one place to be
 * argued with rather than three.
 */

/**
 * Descriptive, with a contact address, like Nominatim's policy asks of us and
 * like these sites deserve.
 *
 * A browser-impersonating UA would fetch more pages: two of the sources this
 * project uses sit behind edges that treat unknown agents differently. It is
 * still not done. A scraper that lies about who it is cannot honour a
 * `Disallow` addressed to it, and the whole robots contract stops meaning
 * anything.
 */
export const FUEL_USER_AGENT =
  'MachiyaBot/0.1 (+https://github.com/Kunal-jaiswal972/Machiya; fuel-price aggregation)';

export class RobotsDisallowedError extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'RobotsDisallowedError';
  }
}

export interface FetchPageOptions {
  /** Attempts in total, not retries after the first. */
  attempts?: number;
  /** Base delay; doubles per attempt with jitter. */
  backoffMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Terminal status codes: retrying these is just noise on someone's server. */
function isRetryable(status: number): boolean {
  // 429 IS retryable, but only because the backoff below waits — it is the one
  // status where waiting is precisely what was asked for.
  return status === 429 || status >= 500;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Fetches one page as text, or throws.
 *
 * Throwing rather than returning null is deliberate: an adapter turns the throw
 * into a `FuelAdapterOutcome` with the reason attached, and that reason is what
 * the admin health page shows. A null would arrive with no explanation.
 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<string> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 800;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const rules = await robotsFor(url, FUEL_USER_AGENT);
  const path = new URL(url).pathname;

  if (!isAllowed(rules, path)) {
    throw new RobotsDisallowedError(
      url,
      rules.readable ? `robots.txt disallows ${path}` : (rules.reason ?? 'robots.txt unreadable'),
    );
  }

  let lastError: Error = new Error('no attempt was made');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': FUEL_USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-IN,en;q=0.9',
        },
        // Both signals, for the same reason as every other outbound call here:
        // the caller's abort alone would leave a hung host holding the job.
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(timeoutMs),
        ]),
      });

      if (response.ok) return await response.text();

      lastError = new Error(`http ${String(response.status)}`);
      if (!isRetryable(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('fetch failed');
      // An abort from the CALLER is a shutdown, not a flaky host. Retrying it
      // would keep a worker alive past its own SIGTERM.
      if (options.signal?.aborted) break;
    }

    if (attempt < attempts) {
      // Exponential with jitter. The jitter matters because three cities x
      // three sources retrying in lockstep is a small thundering herd, and
      // these are somebody else's servers.
      const delay = backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      logger.debug(
        { url, attempt, delayMs: Math.round(delay), err: lastError.message },
        'fuel fetch retrying',
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
