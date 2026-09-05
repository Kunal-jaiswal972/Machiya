import { useEffect, useRef, useState } from 'react';

/**
 * Counts a number up to its new value when it changes.
 *
 * The one animation in this product that carries information rather than
 * polish: when someone changes their mileage or trips per day, watching the
 * monthly figure move makes the relationship between the input and the cost
 * legible in a way an instantly-replaced number does not.
 *
 * Three rules from docs/design.md, all of them load-bearing:
 *
 *  - **`prefers-reduced-motion` gets the value instantly**, not a shorter
 *    animation.
 *  - **The first render does not animate.** Counting up from zero on mount
 *    would make every page load look like a slot machine, and the number is
 *    what the user came for.
 *  - **No animation gates content.** The displayed value is always a real
 *    number on its way to the real number; there is no placeholder state.
 *
 * `requestAnimationFrame` writing to one piece of state, not a spring library:
 * this is a single scalar per panel, and the frame loop stops the moment it
 * arrives.
 */
export function useCountUp(target: number, durationMs = 420): number {
  const [value, setValue] = useState(target);
  const frame = useRef<number | null>(null);
  const from = useRef(target);
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      from.current = target;
      setValue(target);
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target;
      setValue(target);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    const delta = target - origin;

    if (delta === 0) return;

    const step = (now: number): void => {
      const progress = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic: fast at first, settling into the final value, which
      // reads as "arriving at an answer" rather than "spinning".
      const eased = 1 - (1 - progress) ** 3;
      const next = origin + delta * eased;

      setValue(next);

      if (progress < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        from.current = target;
      }
    };

    frame.current = requestAnimationFrame(step);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Whatever was on screen becomes the origin of the next run, so an
      // interrupted count continues from where it stopped rather than jumping
      // back to the last settled value.
      from.current = value;
    };
    // `value` is deliberately absent: including it would restart the animation
    // on every frame it sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return value;
}
