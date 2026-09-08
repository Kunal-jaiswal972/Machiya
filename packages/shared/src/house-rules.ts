/**
 * The house rules a lister can pick from, and how to render one they typed.
 *
 * `Listing.rules` is `String[]` of free text — the wizard lets somebody write
 * their own, and `listingInputSchema` only bounds length and count. So a UI
 * cannot hold an icon per rule; what it can do is recognise the common ones and
 * fall back to a neutral mark for the rest, which is why `resolveHouseRule`
 * always returns something renderable.
 *
 * Stored as text rather than as a lookup table because that is what the column
 * is and what the wizard produces. Normalising to slugs would mean either
 * rejecting a rule somebody typed or silently dropping it, and neither is worth
 * an icon. See DECISIONS.md D90.
 */

/** Rules whose tone changes how they should read: a permission, or a limit. */
export type HouseRuleTone = 'allowed' | 'restricted' | 'neutral';

export interface HouseRule {
  slug: string;
  label: string;
  /** A lucide icon name, in the PascalCase the package exports. */
  icon: string;
  tone: HouseRuleTone;
}

/**
 * Shown as suggestions in the wizard and used to seed. Order is the order they
 * are offered in, grouped loosely from most to least commonly asked about.
 */
export const HOUSE_RULES: HouseRule[] = [
  { slug: 'no-smoking', label: 'No smoking indoors', icon: 'CigaretteOff', tone: 'restricted' },
  { slug: 'no-alcohol', label: 'No alcohol on the premises', icon: 'Ban', tone: 'restricted' },
  { slug: 'vegetarian-only', label: 'Vegetarian tenants only', icon: 'Salad', tone: 'restricted' },
  { slug: 'no-non-veg-cooking', label: 'No non-veg cooking', icon: 'Utensils', tone: 'restricted' },
  { slug: 'quiet-hours', label: 'No loud music after 10pm', icon: 'VolumeOff', tone: 'restricted' },
  { slug: 'no-parties', label: 'No parties or events', icon: 'PartyPopper', tone: 'restricted' },
  { slug: 'no-subletting', label: 'No subletting', icon: 'KeyRound', tone: 'restricted' },
  { slug: 'shoes-off', label: 'Shoes off indoors', icon: 'Footprints', tone: 'restricted' },
  { slug: 'families-preferred', label: 'Families preferred', icon: 'Users', tone: 'neutral' },
  { slug: 'bachelors-welcome', label: 'Bachelors welcome', icon: 'UserCheck', tone: 'allowed' },
  { slug: 'students-welcome', label: 'Students welcome', icon: 'Sparkles', tone: 'allowed' },
  { slug: 'couples-welcome', label: 'Couples welcome', icon: 'Users', tone: 'allowed' },
  { slug: 'pets-allowed', label: 'Pets allowed with a deposit', icon: 'Dog', tone: 'allowed' },
  { slug: 'no-pets', label: 'No pets', icon: 'PawPrint', tone: 'restricted' },
  { slug: 'children-welcome', label: 'Children welcome', icon: 'Baby', tone: 'allowed' },
  { slug: 'visitors-till-9', label: 'Visitors until 9pm', icon: 'Clock', tone: 'neutral' },
  {
    slug: 'id-required',
    label: 'Police verification required',
    icon: 'ShieldCheck',
    tone: 'neutral',
  },
  { slug: 'min-6-months', label: 'Minimum six-month stay', icon: 'CalendarClock', tone: 'neutral' },
  { slug: 'segregate-waste', label: 'Segregate waste', icon: 'Recycle', tone: 'neutral' },
  { slug: 'no-drilling', label: 'No drilling into walls', icon: 'Blocks', tone: 'restricted' },
];

/**
 * The mark for a rule nobody has an icon for.
 *
 * Deliberately neutral: a rule somebody typed is not necessarily a prohibition,
 * so a crossed-out or warning glyph would editorialise text the lister wrote.
 */
export const NEUTRAL_HOUSE_RULE_ICON = 'ScrollText';

/** Just the labels, for seeding and for the wizard's suggestion chips. */
export const HOUSE_RULE_LABELS: string[] = HOUSE_RULES.map((rule) => rule.label);

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.]$/, '');
}

const BY_LABEL = new Map(HOUSE_RULES.map((rule) => [normalise(rule.label), rule]));

/**
 * A rule's icon and tone, for text that may or may not be one of the catalogued
 * ones. Never returns null — an unrecognised rule renders with the neutral mark
 * and its own text, which is the whole point of having a fallback.
 */
export function resolveHouseRule(text: string): HouseRule {
  const known = BY_LABEL.get(normalise(text));
  if (known) return known;

  return {
    slug: `custom:${normalise(text)}`,
    label: text.trim(),
    icon: NEUTRAL_HOUSE_RULE_ICON,
    tone: 'neutral',
  };
}
