import { describe, expect, it } from 'vitest';
import {
  coverageMessage,
  looksLikePlaceName,
  roundCoverageRequestCoordinate,
} from '../src/geo/coverage.js';
import type { OutOfCoverage } from '../src/geo/coverage.js';

/**
 * The copy and the heuristic, which are the two halves of correction 9 that
 * need no database.
 *
 * `coverageMessage` is shared between the API's error message and the UI's
 * designed state so the two cannot drift, which makes it worth pinning: it is
 * the sentence a house-hunter in an uncovered city actually reads.
 */
function coverage(overrides: Partial<OutOfCoverage> = {}): OutOfCoverage {
  return {
    supportedCities: [
      { slug: 'patna', name: 'Patna', centroid: { lat: 25.5941, lng: 85.1376 } },
      { slug: 'bengaluru', name: 'Bengaluru', centroid: { lat: 12.9716, lng: 77.5946 } },
      { slug: 'pune', name: 'Pune', centroid: { lat: 18.5204, lng: 73.8567 } },
    ],
    nearest: { slug: 'bengaluru', name: 'Bengaluru', distanceMeters: 840_000 },
    requested: { lat: 19.076, lng: 72.8777 },
    requestedLabel: 'Bandra West',
    ...overrides,
  };
}

describe('coverageMessage', () => {
  it('names the served cities and the nearest one with its distance', () => {
    expect(coverageMessage(coverage())).toBe(
      'Machiya covers Patna, Bengaluru and Pune. Bengaluru is nearest, 840 km away.',
    );
  });

  it('drops the distance clause when there is no point to measure from', () => {
    // An autocomplete miss: "nearest to what?" has no answer for a text query.
    expect(coverageMessage(coverage({ nearest: null }))).toBe(
      'Machiya covers Patna, Bengaluru and Pune.',
    );
  });

  it('keeps one decimal under 10 km and none above it', () => {
    // "839.6 km" implies a precision that means nothing at that range; "4 km"
    // when the answer is 4.2 km is the wrong rounding at close range, because
    // close range is where someone might actually reconsider.
    const near = coverage({
      nearest: { slug: 'pune', name: 'Pune', distanceMeters: 4_200 },
    });
    expect(coverageMessage(near)).toContain('4.2 km away');

    const far = coverage({
      nearest: { slug: 'pune', name: 'Pune', distanceMeters: 121_400 },
    });
    expect(coverageMessage(far)).toContain('121 km away');
  });

  it('reads correctly with one city and with two', () => {
    const one = coverage({
      supportedCities: [coverage().supportedCities[0]!],
      nearest: null,
    });
    expect(coverageMessage(one)).toBe('Machiya covers Patna.');

    const two = coverage({
      supportedCities: coverage().supportedCities.slice(0, 2),
      nearest: null,
    });
    expect(coverageMessage(two)).toBe('Machiya covers Patna and Bengaluru.');
  });
});

describe('looksLikePlaceName', () => {
  it('accepts an ordinary place name', () => {
    for (const query of ['mumbai', 'New Delhi', 'Sector 62 Noida', 'कोलकाता']) {
      expect(looksLikePlaceName(query)).toBe(true);
    }
  });

  it('rejects a query with no word in it', () => {
    for (const query of ['#12/4b', '123456', '%%%', '  ', 'ko']) {
      expect(looksLikePlaceName(query)).toBe(false);
    }
  });

  it('rejects a query that is mostly digits', () => {
    // A house number with a fragment of a road name attached is a geocoder
    // problem (correction 10), not a coverage one — answering it with "we cover
    // three cities" would be the wrong message entirely.
    expect(looksLikePlaceName('47/3 12b 9')).toBe(false);
  });
});

describe('roundCoverageRequestCoordinate', () => {
  it('rounds to about 110 m, so one person is one row', () => {
    expect(roundCoverageRequestCoordinate(19.0759837)).toBe(19.076);
    expect(roundCoverageRequestCoordinate(72.8777123)).toBe(72.878);
  });
});
