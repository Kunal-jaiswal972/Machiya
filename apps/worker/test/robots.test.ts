import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots, type RobotsRules } from '../src/fuel/robots.js';

/**
 * The robots parser, against the real files from the three fuel sources.
 *
 * Each case below is a shape that actually appears in one of them, and two of
 * them are shapes a naive parser gets wrong in the permissive direction — which
 * is the direction that matters when the consequence is scraping a site that
 * asked you not to.
 */
function rules(body: string): RobotsRules {
  return { readable: true, ...parseRobots(body) };
}

describe('parseRobots', () => {
  it('reads the `*` group and ignores groups addressed to other crawlers', () => {
    // petrolpriceindia's shape: a permissive `*` group followed by a long list
    // of named AI and SEO crawlers blocked outright. Those say nothing about
    // MachiyaBot, and treating them as ours would refuse a site that allowed us.
    const parsed = rules(`
User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /
`);

    expect(parsed.allow).toEqual(['/']);
    expect(parsed.disallow).toEqual([]);
    expect(isAllowed(parsed, '/petrol-price-in-patna')).toBe(true);
  });

  it('accumulates rules across MORE THAN ONE `*` group', () => {
    // Also petrolpriceindia: `Allow: /` at the top, `Disallow: /api/` in a
    // second `*` group at the bottom. A parser that resets on each group keeps
    // whichever it saw last and silently drops the other.
    const parsed = rules(`
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Bytespider
Disallow: /

User-agent: *
Allow: /
Disallow: /api/
`);

    expect(parsed.disallow).toContain('/api/');
    expect(isAllowed(parsed, '/petrol-price-in-patna')).toBe(true);
    expect(isAllowed(parsed, '/api/prices')).toBe(false);
  });

  it('treats an empty Disallow as permission, not as a match-everything rule', () => {
    // `Disallow:` with no value is the explicit "nothing is disallowed" form.
    // Pushing "" into the list would prefix-match every path on the site.
    const parsed = rules('User-agent: *\nDisallow:\n');

    expect(parsed.disallow).toEqual([]);
    expect(isAllowed(parsed, '/anything')).toBe(true);
  });

  it('honours goodreturns own long disallow list', () => {
    const parsed = rules(`
User-agent: *
Allow: /
Disallow: /xml/
Disallow: /quotes/
Disallow: /*?utm*
`);

    expect(isAllowed(parsed, '/petrol-price-in-patna.html')).toBe(true);
    expect(isAllowed(parsed, '/quotes/something')).toBe(false);
    // A wildcard rule, which is why patterns are compiled rather than compared.
    expect(isAllowed(parsed, '/page?utm_source=x')).toBe(false);
  });

  it('lets the LONGEST match win, so a specific Allow beats a broad Disallow', () => {
    // Several of these sites are configured exactly this way. Taking the first
    // matching Disallow would refuse pages their owners deliberately opened.
    const parsed = rules('User-agent: *\nDisallow: /\nAllow: /fuel/\n');

    expect(isAllowed(parsed, '/fuel/petrol-price-patna.html')).toBe(true);
    expect(isAllowed(parsed, '/private/thing')).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const parsed = rules(`
# As a condition of accessing this website, you agree to abide by the following
# content signals:
User-agent: *   # everyone
Disallow: /api/  # not this
`);

    expect(parsed.disallow).toEqual(['/api/']);
  });
});

describe('isAllowed', () => {
  it('refuses everything when robots.txt could not be read', () => {
    // ndtv.com answers 403 to a request for its own robots.txt. Treating that
    // as "no rules, go ahead" is exactly backwards for a site whose edge is
    // already refusing us — an unreadable robots.txt is not permission.
    const unreadable: RobotsRules = {
      readable: false,
      allow: [],
      disallow: [],
      reason: 'robots.txt returned 403',
    };

    expect(isAllowed(unreadable, '/fuel-prices/petrol-price-in-patna-city')).toBe(false);
    expect(isAllowed(unreadable, '/')).toBe(false);
  });
});
