import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, CircleAlert, CloudUpload, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import type { SaveState } from '../../hooks/use-listing-draft';
import { WIZARD_STEPS, stepIndex, type WizardStepId } from './steps';

/**
 * The chrome around every step: the rail, the autosave chip and the slide.
 *
 * The slide is directional — forward enters from the right, back from the left
 * — because a wizard that always animates the same way gives no sense of where
 * you are in it. Under `prefers-reduced-motion` the step simply appears, which
 * is the instant fallback docs/design.md asks for rather than a faster slide.
 */
export interface WizardShellProps {
  step: WizardStepId;
  /** +1 forward, -1 back. Decides which side the panel enters from. */
  direction: number;
  saveState: SaveState;
  completed: (step: WizardStepId) => boolean;
  onJump: (step: WizardStepId) => void;
  children: ReactNode;
  footer: ReactNode;
}

export function WizardShell({
  step,
  direction,
  saveState,
  completed,
  onJump,
  children,
  footer,
}: WizardShellProps) {
  const reduced = useReducedMotion();
  const current = stepIndex(step);
  const meta = WIZARD_STEPS[current];

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-title">List a property</h1>
          <p className="text-sm text-ink-soft">{meta?.hint}</p>
        </div>
        <SaveChip state={saveState} />
      </div>

      <StepRail current={current} completed={completed} onJump={onJump} />

      <div className="min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div
            key={step}
            custom={direction}
            initial={reduced ? false : { opacity: 0, x: direction > 0 ? 28 : -28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, x: direction > 0 ? -28 : 28 }}
            transition={reduced ? { duration: 0 } : { duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="h-full overflow-y-auto"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t pt-3">{footer}</div>
    </div>
  );
}

function StepRail({
  current,
  completed,
  onJump,
}: {
  current: number;
  completed: (step: WizardStepId) => boolean;
  onJump: (step: WizardStepId) => void;
}) {
  return (
    <nav aria-label="Wizard steps">
      <ol className="flex flex-wrap gap-1">
        {WIZARD_STEPS.map((step, index) => {
          const isCurrent = index === current;
          const isDone = completed(step.id);

          return (
            <li key={step.id} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => {
                  onJump(step.id);
                }}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-[var(--radius-inset)] px-1 pt-1 pb-1.5 text-left',
                  'hover:bg-paper-sunken',
                )}
              >
                {/* The bar is the progress indicator; the label is the target.
                    A number in a circle would add a second thing to read. */}
                <span
                  className={cn(
                    'h-1 w-full rounded-full transition-colors',
                    isCurrent
                      ? 'bg-water'
                      : isDone
                        ? 'bg-verdant'
                        : index < current
                          ? 'bg-edge-strong'
                          : 'bg-edge',
                  )}
                />
                <span
                  className={cn(
                    'text-label flex items-center gap-1 truncate',
                    isCurrent ? 'text-ink' : 'text-ink-soft',
                  )}
                >
                  {isDone ? <Check className="size-3 shrink-0 text-verdant" aria-hidden /> : null}
                  {step.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * What autosave is doing, in four words or fewer.
 *
 * "Saved" is stated rather than implied because the whole promise of the wizard
 * is that closing the tab costs nothing, and a promise nobody can see is not
 * one anybody relies on.
 */
function SaveChip({ state }: { state: SaveState }) {
  if (state === 'idle') return null;

  const content = {
    saving: { icon: <Loader2 className="size-3 animate-spin" aria-hidden />, text: 'Saving…' },
    saved: { icon: <CloudUpload className="size-3" aria-hidden />, text: 'Saved' },
    failed: {
      icon: <CircleAlert className="size-3" aria-hidden />,
      text: 'Not saved — check your connection',
    },
  }[state];

  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        'text-data flex shrink-0 items-center gap-1.5',
        state === 'failed' ? 'text-clay' : 'text-ink-faint',
      )}
    >
      {content.icon}
      {content.text}
    </p>
  );
}
