import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';

/**
 * The product tour: five steps that say what the map is arguing.
 *
 * Anchored to `data-tour` attributes rather than class names or DOM structure,
 * so a restyle cannot silently point the tour at nothing. A step whose target
 * is not on screen is dropped before the tour starts — the filter bar does not
 * exist until an office is set, and a tour that highlights the empty corner of
 * a page is worse than a shorter tour.
 *
 * Whether it has been seen is not this module's business — that is a fact
 * about the person and lives on their account (see `useUiPreferences`), so it
 * does not run again on their phone. See DECISIONS.md D81.
 */
export type TourTarget =
  'office-field' | 'ring-counts' | 'sort' | 'total-cost' | 'save-office' | 'view-toggle';

const STEPS: Array<{ target: TourTarget; title: string; description: string }> = [
  {
    target: 'office-field',
    title: 'Start where you work',
    description:
      'Search a landmark or locality, use your current location, or drop a pin on the map. Every distance and every cost below is measured from this point.',
  },
  {
    target: 'ring-counts',
    title: 'One, two and three kilometres',
    description:
      'The rings on the map, and how many places are inside each. Press one to see only that ring.',
  },
  {
    target: 'total-cost',
    title: 'Rent is not the price',
    description:
      'The second line is rent plus what the commute costs you every month — worked out from the real road distance and today’s fuel price, not a guess.',
  },
  {
    target: 'sort',
    title: 'Sort by what it actually costs',
    description:
      'Total monthly cost puts the cheap flat an hour away where it belongs. This is the thing the product is for.',
  },
  {
    target: 'view-toggle',
    title: 'The list is the whole search',
    description:
      'Everything on the map is in the list, in order, reachable by keyboard. Switch whenever the map is in the way.',
  },
];

export interface TourOptions {
  /** Called when the tour ends, however it ends — finished, closed or escaped. */
  onFinished?: () => void;
}

export function startTour(options: TourOptions = {}): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Present AND laid out: the view toggle is in the DOM at every width and
  // display:none above `lg`, so "does the selector match" is not the question.
  const steps: DriveStep[] = STEPS.filter((step) => {
    const element = document.querySelector(`[data-tour="${step.target}"]`);
    return element instanceof HTMLElement && element.getBoundingClientRect().width > 0;
  }).map((step) => ({
    element: `[data-tour="${step.target}"]`,
    popover: { title: step.title, description: step.description },
  }));

  if (steps.length === 0) return;

  driver({
    steps,
    animate: !reduced,
    overlayColor: 'var(--scrim)',
    stagePadding: 6,
    stageRadius: 10,
    popoverClass: 'machiya-tour',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Got it',
    progressText: '{{current}} of {{total}}',
    showProgress: true,
    onDestroyed: () => options.onFinished?.(),
  }).drive();
}
