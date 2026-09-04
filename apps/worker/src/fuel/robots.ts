import { logger } from '../logger.js';

/**
 * robots.txt, honoured rather than gestured at.
 *
 * Fetched once per host per process and cached, because asking three times an
 * hour for a file that changes monthly is its own small rudeness. A host that
 * disallows us is skipped without its content page ever being requested — which
 * is the point: checking after fetching would be theatre.
 *
 * Two things this parser gets right that a naive one does not, both found in
 * the real files:
 *
 *  - **A file can contain more than one `User-agent: *` group.**
 *    petrolpriceindia has one at the top (`Allow: /`) and another at the bottom
 *    (`Disallow: /api/`). Resetting the rule set on each group would drop
 *    whichever came first. Rules from every `*` group accumulate.
 *  - **An unreadable robots.txt is not permission.** ndtv.com answers **403**
 *    to a request for its own robots.txt, and treating that as "no rules, go
 *    ahead" is exactly backwards for a site whose edge is refusing us.
 *
 * Named-agent groups (`GPTBot`, `ClaudeBot`, `AhrefsBot`…) are deliberately
 * ignored: this is `MachiyaBot`, and a group addressed to a different crawler
 * says nothing about us. The `*` group is the one that applies.
 */
export interface RobotsRules {
  /** Whether robots.txt could be read at all. False means: do not fetch. */
  readable: boolean;
  /** Disallow patterns from every `User-agent: *` group, in file order. */
  disallow: string[];
  /** Allow patterns, which win over a Disallow of equal or shorter length. */
  allow: string[];
  /** Why it is unreadable, for the adapter health report. */
  reason?: string;
}

const cache = new Map<string, Promise<RobotsRules>>();

export function parseRobots(body: string): Pick<RobotsRules, 'allow' | 'disallow'> {
  const allow: string[] = [];
  const disallow: string[] = [];
  let appliesToUs = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line.length === 0) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Note this ASSIGNS rather than OR-ing: a named group after a `*` group
      // must switch us off again. Accumulation happens across `*` groups
      // through `allow`/`disallow` never being cleared.
      appliesToUs = value === '*';
      continue;
    }

    if (!appliesToUs) continue;

    // An empty value is the explicit "nothing is disallowed" form, and adding
    // "" to the list would match every path by prefix.
    if (field === 'disallow' && value.length > 0) disallow.push(value);
    if (field === 'allow' && value.length > 0) allow.push(value);
  }

  return { allow, disallow };
}

/**
 * Whether a path is allowed, by the longest-match rule the standard uses.
 *
 * Longest match wins, and Allow wins a tie — so `Allow: /fuel/` beats
 * `Disallow: /` for a fuel page, which is how several of these sites are
 * actually configured. Taking the first matching Disallow instead would refuse
 * pages their owners explicitly opened up.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  if (!rules.readable) return false;

  const match = (patterns: string[]): number => {
    let longest = -1;
    for (const pattern of patterns) {
      // `*` is a wildcard and `$` anchors the end; everything else is literal.
      const source = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$');
      if (new RegExp(`^${source}`).test(path)) {
        longest = Math.max(longest, pattern.length);
      }
    }
    return longest;
  };

  const disallowed = match(rules.disallow);
  if (disallowed === -1) return true;

  return match(rules.allow) >= disallowed;
}

async function load(origin: string, userAgent: string): Promise<RobotsRules> {
  try {
    const response = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // 404 genuinely means "no rules", which is permission. Anything else —
      // 403 from an edge that is refusing us, a 500, a redirect loop — is not.
      if (response.status === 404) {
        return { readable: true, allow: [], disallow: [] };
      }

      return {
        readable: false,
        allow: [],
        disallow: [],
        reason: `robots.txt returned ${String(response.status)}`,
      };
    }

    const parsed = parseRobots(await response.text());
    return { readable: true, ...parsed };
  } catch (error) {
    return {
      readable: false,
      allow: [],
      disallow: [],
      reason: `robots.txt unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/** Cached per host for the life of the process. */
export async function robotsFor(url: string, userAgent: string): Promise<RobotsRules> {
  const origin = new URL(url).origin;

  let pending = cache.get(origin);
  if (!pending) {
    pending = load(origin, userAgent);
    cache.set(origin, pending);

    void pending.then((rules) => {
      if (!rules.readable) {
        logger.warn(
          { origin, reason: rules.reason },
          'robots.txt unreadable; host will be skipped',
        );
      }
    });
  }

  return pending;
}

/** Testing seam: the cache is process-lifetime, which a test must not inherit. */
export function resetRobotsCache(): void {
  cache.clear();
}
