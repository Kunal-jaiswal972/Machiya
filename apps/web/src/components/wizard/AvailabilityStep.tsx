import {
  HOUSE_RULE_LABELS,
  resolveHouseRule,
  type ListingDraftView,
  type ListingPatchInput,
} from '@machiya/shared';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { iconFor } from '../../lib/icon-registry';
import { Field, TextField } from './fields';

// The same catalogue the detail page renders from, so a rule picked here arrives
// there with its icon rather than as unrecognised text (D90).
const SUGGESTED_RULES = HOUSE_RULE_LABELS;

const MAX_RULES = 12;

export function AvailabilityStep({
  draft,
  onPatch,
}: {
  draft: ListingDraftView;
  onPatch: (patch: ListingPatchInput) => void;
}) {
  const [pending, setPending] = useState('');
  const rules = draft.rules;

  const setRules = (next: string[]) => {
    onPatch({ rules: next.slice(0, MAX_RULES) });
  };

  const add = (rule: string) => {
    const trimmed = rule.trim();
    if (trimmed.length < 2 || rules.includes(trimmed) || rules.length >= MAX_RULES) return;
    setRules([...rules, trimmed]);
    setPending('');
  };

  return (
    <div className="mx-auto grid max-w-2xl gap-5 pb-4">
      <TextField
        id="wizard-available-from"
        label="Available from"
        type="date"
        hint="Leave it empty and the listing reads “available now”."
        value={draft.availableFrom ? draft.availableFrom.slice(0, 10) : ''}
        onCommit={(value) => {
          onPatch({ availableFrom: value === '' ? null : value });
        }}
      />

      <Field
        label="House rules"
        htmlFor="wizard-rule"
        hint={`Up to ${String(MAX_RULES)}. Say them here rather than in the first message to every enquiry.`}
      >
        <div className="flex gap-2">
          <Input
            id="wizard-rule"
            value={pending}
            placeholder="Add a rule"
            onChange={(event) => {
              setPending(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Otherwise this submits the step and advances the wizard.
              event.preventDefault();
              add(pending);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              add(pending);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Add
          </Button>
        </div>
      </Field>

      {rules.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {rules.map((rule) => {
            const Icon = iconFor(resolveHouseRule(rule).icon);
            return (
              <li
                key={rule}
                className="text-label flex items-center gap-1.5 rounded-[var(--radius-chrome)] border border-edge-strong px-2 py-1"
              >
                <Icon className="size-3 shrink-0 text-ink-faint" aria-hidden />
                {rule}
                <button
                  type="button"
                  aria-label={`Remove rule: ${rule}`}
                  className="text-ink-faint hover:text-clay"
                  onClick={() => {
                    setRules(rules.filter((existing) => existing !== rule));
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div>
        <p className="text-label mb-1.5 text-ink-soft">Common ones</p>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED_RULES.filter((rule) => !rules.includes(rule)).map((rule) => {
            const Icon = iconFor(resolveHouseRule(rule).icon);
            return (
              <Button
                key={rule}
                type="button"
                size="sm"
                variant="ghost"
                className="gap-1.5 text-ink-soft"
                onClick={() => {
                  add(rule);
                }}
              >
                <Icon className="size-3 shrink-0" aria-hidden />
                {rule}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
