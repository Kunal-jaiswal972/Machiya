import { describe, expect, it } from 'vitest';
import {
  HOUSE_RULES,
  HOUSE_RULE_LABELS,
  NEUTRAL_HOUSE_RULE_ICON,
  resolveHouseRule,
} from '../src/house-rules.js';

describe('resolveHouseRule', () => {
  it('resolves every catalogued label to its own entry', () => {
    for (const rule of HOUSE_RULES) {
      expect(resolveHouseRule(rule.label)).toEqual(rule);
    }
  });

  /**
   * The reason this function exists. `Listing.rules` is free text, so the UI has
   * to render a rule nobody catalogued — and it must render as the lister's own
   * words with a neutral mark, not as an empty chip or a dropped row.
   */
  it('falls back to the neutral mark for text it does not know', () => {
    const resolved = resolveHouseRule('No jamming after midnight');

    expect(resolved.label).toBe('No jamming after midnight');
    expect(resolved.icon).toBe(NEUTRAL_HOUSE_RULE_ICON);
    expect(resolved.tone).toBe('neutral');
  });

  it('matches regardless of case, padding, inner spacing and a trailing stop', () => {
    const expected = resolveHouseRule('No smoking indoors');

    for (const variant of [
      '  No smoking indoors  ',
      'no smoking indoors',
      'NO SMOKING INDOORS',
      'No  smoking   indoors',
      'No smoking indoors.',
    ]) {
      expect(resolveHouseRule(variant).slug, variant).toBe(expected.slug);
    }
  });

  it('keeps a rule that is only whitespace-different from custom text distinct', () => {
    expect(resolveHouseRule('Something else entirely').slug).toBe('custom:something else entirely');
  });

  it('exposes labels that all resolve back, so the wizard cannot offer an unknown rule', () => {
    expect(HOUSE_RULE_LABELS).toHaveLength(HOUSE_RULES.length);

    for (const label of HOUSE_RULE_LABELS) {
      expect(resolveHouseRule(label).icon).not.toBe(NEUTRAL_HOUSE_RULE_ICON);
    }
  });

  it('has unique slugs and labels', () => {
    expect(new Set(HOUSE_RULES.map((rule) => rule.slug)).size).toBe(HOUSE_RULES.length);
    expect(new Set(HOUSE_RULE_LABELS).size).toBe(HOUSE_RULES.length);
  });
});
