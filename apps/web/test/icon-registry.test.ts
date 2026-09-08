import { HOUSE_RULES, NEUTRAL_HOUSE_RULE_ICON } from '@machiya/shared';
import { describe, expect, it } from 'vitest';
import { NeutralIcon, iconFor } from '../src/lib/icon-registry';

/**
 * The registry is a hand-maintained map, so the failure it can have is a name
 * that exists in the catalogue and not in the map — which renders the neutral
 * mark on a rule that has a perfectly good icon. Cheap to assert, invisible
 * otherwise.
 *
 * Amenity icon names live in the database rather than in a constant, so they
 * cannot be checked here; `iconFor` answering with the fallback for an unknown
 * name is what covers those.
 */
describe('iconFor', () => {
  it('has an icon for every catalogued house rule', () => {
    const missing = HOUSE_RULES.filter((rule) => iconFor(rule.icon) === NeutralIcon).map(
      (rule) => `${rule.slug} -> ${rule.icon}`,
    );

    expect(missing).toEqual([]);
  });

  it('resolves the neutral name itself', () => {
    expect(iconFor(NEUTRAL_HOUSE_RULE_ICON)).toBe(NeutralIcon);
  });

  it('falls back rather than throwing on a name it does not hold', () => {
    expect(iconFor('NotARealIconName')).toBe(NeutralIcon);
    expect(iconFor(null)).toBe(NeutralIcon);
    expect(iconFor(undefined)).toBe(NeutralIcon);
    expect(iconFor('')).toBe(NeutralIcon);
  });
});
