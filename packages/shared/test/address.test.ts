import { describe, expect, it } from 'vitest';
import {
  capPrecision,
  looksLikeStreetAddress,
  precisionNote,
  stripHouseNumber,
} from '../src/geo/address.js';

/**
 * The strip rule, pinned against the exact query forms it was designed from.
 *
 * Every "before" here was run through the local Nominatim and returned **zero**
 * results; every "after" returned something. The forms are in `docs/geo.md`
 * with what each one actually came back with.
 */
describe('stripHouseNumber', () => {
  it('drops a leading house-number segment from a comma-separated address', () => {
    expect(stripHouseNumber('House 12, Anisabad, Patna')).toBe('Anisabad, Patna');
    expect(stripHouseNumber('Flat 3, Bailey Road, Patna')).toBe('Bailey Road, Patna');
    expect(stripHouseNumber('H.No 8, Wakad, Pune')).toBe('Wakad, Pune');
    expect(stripHouseNumber('Plot 22, Baner Road, Pune')).toBe('Baner Road, Pune');
    expect(stripHouseNumber('#118, 5th Block, Koramangala, Bengaluru')).toBe(
      '5th Block, Koramangala, Bengaluru',
    );
    expect(stripHouseNumber('No 42, 1st Main Road, Indiranagar')).toBe(
      '1st Main Road, Indiranagar',
    );
  });

  it('drops a house number from the START of the first segment', () => {
    expect(stripHouseNumber('221 Sarjapur Road, Bellandur, Bengaluru')).toBe(
      'Sarjapur Road, Bellandur, Bengaluru',
    );
  });

  it('drops a leading house number from a space-separated address', () => {
    expect(stripHouseNumber('47 Road 3 Rajendra Nagar Patna')).toBe('Road 3 Rajendra Nagar Patna');
    expect(stripHouseNumber('12B Boring Road Patna')).toBe('Boring Road Patna');
  });

  it('keeps a road name that merely contains a number', () => {
    // "Road 3" and "5th Block" are road and block names, not house numbers. A
    // pattern loose enough to eat them would sometimes strip the only useful
    // token in the query — and truncating until Nominatim bites is what turns
    // "47 Road 3 Rajendra Nagar" into "90 Feet Road", a real road in Patna and
    // not the one asked for.
    expect(stripHouseNumber('House 47, Road 3, Rajendra Nagar, Patna')).toBe(
      'Road 3, Rajendra Nagar, Patna',
    );
    expect(stripHouseNumber('4th Block, Koramangala, Bengaluru')).toBeNull();
  });

  it('returns null when there is nothing to strip', () => {
    for (const query of ['Koramangala', 'Rajendra Nagar, Patna', 'Golghar', 'Boring Road', '']) {
      expect(stripHouseNumber(query)).toBeNull();
    }
  });

  it('never strips a query down to nothing', () => {
    // A bare number is all there is; stripping it leaves an empty query, which
    // would be a request for every place in the extract.
    expect(stripHouseNumber('47')).toBeNull();
    expect(stripHouseNumber('House 47')).toBeNull();
  });

  it('is idempotent — one pass, never a loop', () => {
    const once = stripHouseNumber('House 12, Anisabad, Patna');
    expect(once).toBe('Anisabad, Patna');
    expect(stripHouseNumber(once!)).toBeNull();
  });
});

describe('looksLikeStreetAddress', () => {
  it('is true exactly when there is a house number to strip', () => {
    expect(looksLikeStreetAddress('House 12, Anisabad, Patna')).toBe(true);
    expect(looksLikeStreetAddress('80 Feet Road, Koramangala')).toBe(true);
    expect(looksLikeStreetAddress('Koramangala')).toBe(false);
    expect(looksLikeStreetAddress('Gandhi Maidan')).toBe(false);
  });
});

describe('capPrecision', () => {
  it('never lets a result claim more precision than the ceiling', () => {
    // The rule that makes the retry safe: the house number is gone, so even a
    // building hit is not the building that was asked about.
    expect(capPrecision('exact', 'locality')).toBe('locality');
    expect(capPrecision('locality', 'locality')).toBe('locality');
    expect(capPrecision('area', 'locality')).toBe('area');
  });

  it('does not sharpen a coarse result', () => {
    expect(capPrecision('area', 'exact')).toBe('area');
  });
});

describe('precisionNote', () => {
  it('says nothing for an exact match', () => {
    // The good case needs no note. Annotating successes trains people to
    // distrust them.
    expect(precisionNote({ precision: 'exact', label: 'Golghar' })).toBeNull();
  });

  it('says what it did for a locality match', () => {
    expect(precisionNote({ precision: 'locality', label: 'Rajendra Nagar' })).toBe(
      'Showing Rajendra Nagar — drag the pin to your exact spot.',
    );
  });

  it('is blunter for a whole-city match', () => {
    expect(precisionNote({ precision: 'area', label: 'Patna' })).toContain('covers a wide area');
  });
});
