import type { ListingDraftView } from '@machiya/shared';
import { describe, expect, it } from 'vitest';
import {
  WIZARD_STEP_IDS,
  isWizardStep,
  outstandingSteps,
  stepComplete,
  stepIndex,
} from '../src/components/wizard/steps';

/**
 * The wizard's completeness rules.
 *
 * These decide which steps show a tick, what the review step lists as
 * outstanding, and therefore what a lister believes about their own draft. They
 * are advisory — the refusal that matters is the server's, backed by a CHECK
 * constraint (D67) — but an advisory rule that disagrees with the server tells
 * someone their listing is ready and then refuses to publish it.
 */

function draft(overrides: Partial<ListingDraftView> = {}): ListingDraftView {
  return {
    id: 'listing-1',
    slug: 'draft-patna-abc123',
    status: 'DRAFT',
    citySlug: 'patna',
    cityName: 'Patna',
    lat: 25.6127,
    lng: 85.1588,
    address: null,
    locality: null,
    title: null,
    description: null,
    listingType: 'RENT',
    propertyType: null,
    furnishing: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    totalFloors: null,
    areaSqft: null,
    rentAmount: null,
    salePrice: null,
    securityDeposit: null,
    maintenanceMonthly: null,
    availableFrom: null,
    rules: [],
    amenitySlugs: [],
    images: [],
    publishedAt: null,
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

const complete = draft({
  address: '12 Ashok Rajpath',
  locality: 'Golghar',
  title: 'A bright two-bedroom near Golghar',
  description: 'Corner flat with morning light on both sides.',
  propertyType: 'APARTMENT',
  furnishing: 'SEMI_FURNISHED',
  bedrooms: 2,
  bathrooms: 2,
  areaSqft: 980,
  rentAmount: 16_500,
  images: [
    {
      id: 'image-1',
      status: 'READY',
      width: 1200,
      height: 800,
      sortOrder: 0,
      isCover: true,
      failureReason: null,
      dominantColor: '#b48c5a',
      lqip: null,
      urls: { thumb: 't', card: 'c', full: 'f' },
    },
  ],
});

describe('stepComplete', () => {
  it('treats a brand-new draft as having nothing but its pin', () => {
    expect(outstandingSteps(draft())).toEqual(['location', 'basics', 'pricing', 'photos']);
  });

  it('needs both halves of the address, because only one is ever prefilled', () => {
    // D59: the locality may arrive from a reverse geocode, the street line
    // never does — so a draft with a locality alone is not finished here.
    expect(stepComplete('location', draft({ locality: 'Golghar' }))).toBe(false);
    expect(stepComplete('location', draft({ locality: 'Golghar', address: '12 Ashok' }))).toBe(
      true,
    );
  });

  it('counts a zero as present, because zero bathrooms is an answer', () => {
    const withZero = draft({
      title: 'A studio above the shop',
      description: 'Small, and honest about it, right on the main road.',
      propertyType: 'STUDIO',
      furnishing: 'UNFURNISHED',
      bedrooms: 0,
      bathrooms: 0,
      areaSqft: 200,
    });

    // A truthiness check here would call 0 missing and send the lister back to
    // a step they have already filled in.
    expect(stepComplete('basics', withZero)).toBe(true);
  });

  it('asks a rental for rent and a sale for a price', () => {
    expect(stepComplete('pricing', draft({ rentAmount: 16_500 }))).toBe(true);
    expect(stepComplete('pricing', draft({ salePrice: 7_500_000 }))).toBe(false);

    const sale = draft({ listingType: 'SALE', salePrice: 7_500_000 });
    expect(stepComplete('pricing', sale)).toBe(true);
    expect(stepComplete('pricing', draft({ listingType: 'SALE', rentAmount: 16_500 }))).toBe(false);
  });

  it('wants a READY photo, not merely an uploaded one', () => {
    const pending = draft({
      images: [
        {
          id: 'image-1',
          status: 'PENDING',
          width: 0,
          height: 0,
          sortOrder: 0,
          isCover: true,
          failureReason: null,
          dominantColor: null,
          lqip: null,
          urls: null,
        },
      ],
    });

    // The same distinction the publish 422 makes: a PENDING row has no
    // servable bytes (D38).
    expect(stepComplete('photos', pending)).toBe(false);
    expect(stepComplete('photos', complete)).toBe(true);
  });

  it('never marks the optional steps outstanding', () => {
    // Amenities and house rules are genuinely optional. Flagging them would
    // train people to ignore the ticks.
    expect(stepComplete('amenities', draft())).toBe(true);
    expect(stepComplete('availability', draft())).toBe(true);
  });

  it('reports nothing outstanding for a publishable draft', () => {
    expect(outstandingSteps(complete)).toEqual([]);
  });

  it('reports every step outstanding when there is no draft at all', () => {
    expect(outstandingSteps(undefined)).toEqual([
      'location',
      'basics',
      'pricing',
      'amenities',
      'photos',
      'availability',
    ]);
  });
});

describe('step identity', () => {
  it('rejects anything that is not a step, so a bad URL cannot select one', () => {
    expect(isWizardStep('photos')).toBe(true);
    expect(isWizardStep('Photos')).toBe(false);
    expect(isWizardStep(undefined)).toBe(false);
    expect(isWizardStep('__proto__')).toBe(false);
  });

  it('orders the steps the way the rail walks them', () => {
    expect(stepIndex('location')).toBe(0);
    expect(stepIndex('review')).toBe(WIZARD_STEP_IDS.length - 1);
  });
});
