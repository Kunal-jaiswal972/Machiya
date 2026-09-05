import type { ListingDraftView } from '@machiya/shared';

/**
 * The wizard's seven steps, in order.
 *
 * One list, read by the rail, the router, the review step's "go fix this" links
 * and the publish error mapping. A second copy anywhere is a second copy that
 * disagrees the first time a step is renamed.
 */
export const WIZARD_STEPS = [
  { id: 'location', label: 'Location', hint: 'Drop a pin where the property is' },
  { id: 'basics', label: 'The place', hint: 'What it is, and how big' },
  { id: 'pricing', label: 'Pricing', hint: 'Rent or price, deposit, maintenance' },
  { id: 'amenities', label: 'Amenities', hint: 'What comes with it' },
  { id: 'photos', label: 'Photos', hint: 'At least one, and the cover first' },
  { id: 'availability', label: 'Availability', hint: 'From when, and the house rules' },
  { id: 'review', label: 'Review', hint: 'Exactly what goes live' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

export const WIZARD_STEP_IDS: readonly WizardStepId[] = WIZARD_STEPS.map((step) => step.id);

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEP_IDS.indexOf(id);
}

export function isWizardStep(value: string | undefined): value is WizardStepId {
  return WIZARD_STEP_IDS.includes(value as WizardStepId);
}

/**
 * Whether a step has everything publishing needs from it.
 *
 * Advisory only — it drives the tick on the rail and the review step's "still
 * to do" list. The refusal that actually matters is the server's, which is
 * itself backed by a CHECK constraint (D67); this exists so a lister is not
 * told what is missing only at the very end.
 */
export function stepComplete(step: WizardStepId, draft: ListingDraftView | undefined): boolean {
  if (!draft) return false;

  switch (step) {
    case 'location':
      // The pin is the fact, and a draft cannot exist without one — so what is
      // outstanding here is the address line the geocoder was not allowed to
      // guess at (D59).
      return Boolean(draft.locality) && Boolean(draft.address);
    case 'basics':
      return (
        Boolean(draft.title) &&
        Boolean(draft.description) &&
        Boolean(draft.propertyType) &&
        Boolean(draft.furnishing) &&
        draft.bedrooms !== null &&
        draft.bathrooms !== null &&
        draft.areaSqft !== null
      );
    case 'pricing':
      return draft.listingType === 'RENT' ? draft.rentAmount !== null : draft.salePrice !== null;
    case 'photos':
      return draft.images.some((image) => image.status === 'READY');
    // Amenities and house rules are genuinely optional, so these steps are
    // complete the moment they have been reached. Marking them outstanding
    // would train people to ignore the ticks.
    case 'amenities':
    case 'availability':
    case 'review':
      return true;
  }
}

/** Every step that still needs something, for the review step's checklist. */
export function outstandingSteps(draft: ListingDraftView | undefined): WizardStepId[] {
  return WIZARD_STEP_IDS.filter((step) => step !== 'review' && !stepComplete(step, draft));
}
