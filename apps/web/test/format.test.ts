import { describe, expect, it } from 'vitest';
import { UNKNOWN_VALUE, formatArea, formatBedrooms, humanizeEnum } from '../src/lib/format';

/**
 * The three formatters that render a DRAFT listing's missing fields.
 *
 * They take nullable input because a listing genuinely has none of these until
 * the wizard's later steps (D67). The failure they exist to prevent is the word
 * "null" reaching a user, which is what `??` at eight call sites eventually
 * produces when one of them is forgotten.
 */
describe('formatters over an incomplete draft', () => {
  it('renders an em dash rather than the word null', () => {
    expect(formatArea(null)).toBe(UNKNOWN_VALUE);
    expect(formatArea(undefined)).toBe(UNKNOWN_VALUE);
    expect(formatBedrooms(null, null)).toBe(UNKNOWN_VALUE);
    expect(humanizeEnum(null)).toBe(UNKNOWN_VALUE);
    expect(humanizeEnum('')).toBe(UNKNOWN_VALUE);
  });

  it('still formats a real value', () => {
    expect(formatArea(980)).toBe('980 sq ft');
    expect(formatBedrooms(2, 'APARTMENT')).toBe('2 BHK');
    expect(humanizeEnum('BUILDER_FLOOR')).toBe('Builder floor');
    expect(humanizeEnum('PG')).toBe('PG');
  });

  it('says Studio without needing a bedroom count', () => {
    // A studio is one room; the count is not the fact being reported, so a
    // null bedrooms must not turn this into a dash.
    expect(formatBedrooms(null, 'STUDIO')).toBe('Studio');
    expect(formatBedrooms(1, 'STUDIO')).toBe('Studio');
  });

  it('treats zero bedrooms as a number, not as missing', () => {
    expect(formatBedrooms(0, 'APARTMENT')).toBe('0 BHK');
    expect(formatArea(0)).toBe('0 sq ft');
  });
});
