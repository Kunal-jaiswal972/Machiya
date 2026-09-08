import { resolveHouseRule, type HouseRuleTone } from '@machiya/shared';
import { iconFor } from '../../lib/icon-registry';

/**
 * House rules as marked chips rather than a stack of sentences.
 *
 * A rule is free text — the wizard lets a lister type their own — so a rule the
 * catalogue does not know still has to render. `resolveHouseRule` answers with a
 * neutral mark for those, which is the reason this reads as a list of rules
 * instead of a list of prohibitions: nothing here asserts a tone the lister did
 * not write. See DECISIONS.md D90.
 */
const TONE_CLASS: Record<HouseRuleTone, string> = {
  allowed: 'text-verdant',
  restricted: 'text-ink-soft',
  neutral: 'text-ink-soft',
};

export function HouseRuleList({ rules }: { rules: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {rules.map((rule) => {
        const resolved = resolveHouseRule(rule);
        const Icon = iconFor(resolved.icon);

        return (
          <li
            key={rule}
            className="flex items-center gap-1.5 rounded-round border border-edge px-2 py-1 text-label"
          >
            <Icon className={`size-3 shrink-0 ${TONE_CLASS[resolved.tone]}`} aria-hidden />
            {resolved.label}
          </li>
        );
      })}
    </ul>
  );
}
