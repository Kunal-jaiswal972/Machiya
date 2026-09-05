import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

/**
 * The wizard's field kit.
 *
 * Every step autosaves on blur rather than on change: a PATCH per keystroke is
 * a write amplification nobody asked for, and blur is the moment a value is
 * actually settled. The "next" button saves too, so a field left focused when
 * someone advances is not lost.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-data text-ink-soft">{hint}</p> : null}
    </div>
  );
}

export function TextField({
  label,
  id,
  value,
  hint,
  placeholder,
  onCommit,
  type = 'text',
  className,
}: {
  label: string;
  id: string;
  value: string;
  hint?: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  type?: 'text' | 'number' | 'date';
  className?: string;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(hint ? { hint } : {})}
      {...(className ? { className } : {})}
    >
      <Input
        id={id}
        type={type}
        defaultValue={value}
        placeholder={placeholder ?? ''}
        // Uncontrolled with a keyed remount, so a save that arrives while
        // someone is typing cannot yank the caret back to where the server
        // thinks the value ends.
        key={value}
        onBlur={(event) => {
          onCommit(event.target.value);
        }}
      />
    </Field>
  );
}

/** A row of mutually exclusive chips. Radio semantics, chip appearance. */
export function ChipGroup<T extends string>({
  label,
  value,
  options,
  onSelect,
  name,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onSelect: (value: T) => void;
  name: string;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-label mb-1.5">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                'text-label cursor-pointer rounded-[var(--radius-chrome)] border px-2.5 py-1.5',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-water',
                selected
                  ? 'border-water bg-water-soft text-ink'
                  : 'border-edge-strong text-ink-soft hover:bg-paper-sunken',
              )}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={selected}
                onChange={() => {
                  onSelect(option.value);
                }}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
