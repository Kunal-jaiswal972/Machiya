import { missingPublishFields } from '@machiya/shared';
import type { ListingDraftView } from '@machiya/shared';
import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { formatArea, formatBedrooms, formatRupees, humanizeEnum } from '../../lib/format';
import { Button } from '../ui/button';
import { WIZARD_STEPS, type WizardStepId } from './steps';

/**
 * Exactly what goes live, and nothing that does not.
 *
 * The photo count is stated as READY rather than uploaded, because those are
 * different numbers whenever the worker is still decoding and the difference is
 * the whole reason publishing can be refused with a 422 that says "still
 * processing" rather than "add a photo" (D38).
 */
export function ReviewStep({
  draft,
  onJump,
  onPublish,
  isPublishing,
  publishError,
}: {
  draft: ListingDraftView;
  onJump: (step: WizardStepId) => void;
  onPublish: () => void;
  isPublishing: boolean;
  publishError: string | null;
}) {
  const missing = missingPublishFields(draft);
  const ready = draft.images.filter((image) => image.status === 'READY');
  const pending = draft.images.filter((image) => image.status === 'PENDING');
  const cover = ready.find((image) => image.isCover) ?? ready[0];

  const price =
    draft.listingType === 'RENT'
      ? draft.rentAmount === null
        ? null
        : draft.rentAmount + (draft.maintenanceMonthly ?? 0)
      : draft.salePrice;

  return (
    <div className="mx-auto grid max-w-3xl gap-4 pb-4">
      {missing.length > 0 ? (
        <section className="chrome border-clay/40 p-3">
          <h2 className="text-label flex items-center gap-1.5 text-clay">
            <TriangleAlert className="size-3.5" aria-hidden />
            Still to do
          </h2>
          {/*
            The FIELD that is missing, not the step's blurb. This listed "Drop a
            pin where the property is" while the pin was plainly on the map,
            because the step's hint stood in for whichever of its fields was
            empty (docs/ux-audit.md W-05). `missingPublishFields` has carried
            the per-field copy since D33.
          */}
          <ul className="mt-1.5 grid gap-1">
            {missing.map((requirement) => {
              const step = requirement.step as WizardStepId;
              const meta = WIZARD_STEPS.find((candidate) => candidate.id === step);

              return (
                <li
                  key={requirement.field}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="text-ink-soft">{requirement.message}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onJump(step);
                    }}
                  >
                    {meta?.label}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="text-label flex items-center gap-1.5 text-verdant">
          <Check className="size-4" aria-hidden />
          Everything publishing needs is here.
        </p>
      )}

      <section className="chrome overflow-hidden">
        <div className="flex gap-3 p-3">
          <div className="aspect-[4/3] w-32 shrink-0 overflow-hidden rounded-[var(--radius-inset)] bg-paper-sunken">
            {cover?.urls ? (
              <img src={cover.urls.card} alt="" className="size-full object-cover" />
            ) : null}
          </div>
          <div className="min-w-0">
            <p className="text-price-lg text-signal-ink dark:text-signal">
              {formatRupees(price)}
              {draft.listingType === 'RENT' ? (
                <span className="text-label text-ink-faint"> /mo</span>
              ) : null}
            </p>
            <h2 className="text-title mt-0.5 truncate">{draft.title ?? 'Untitled'}</h2>
            <p className="text-data mt-0.5 text-ink-soft">
              {[draft.address, draft.locality, draft.cityName].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t p-3 sm:grid-cols-3">
          <Row label="Layout" value={formatBedrooms(draft.bedrooms, draft.propertyType)} />
          <Row label="Area" value={formatArea(draft.areaSqft)} />
          <Row label="Furnishing" value={humanizeEnum(draft.furnishing)} />
          <Row label="Type" value={humanizeEnum(draft.propertyType)} />
          <Row label="Amenities" value={String(draft.amenitySlugs.length)} />
          <Row label="House rules" value={String(draft.rules.length)} />
        </dl>

        <p className="text-data border-t p-3 text-ink-soft">
          {/* READY, not uploaded: a PENDING row has no servable bytes. */}
          {ready.length} photo{ready.length === 1 ? '' : 's'} ready to show
          {pending.length > 0 ? `, ${String(pending.length)} still processing` : ''}.
        </p>
      </section>

      {publishError ? (
        <p role="alert" className="text-sm text-clay">
          {publishError}
        </p>
      ) : null}

      <Button size="lg" onClick={onPublish} disabled={isPublishing} className="justify-self-start">
        {isPublishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Publish this listing
      </Button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-data text-ink-faint">{label}</dt>
      <dd className="text-label">{value}</dd>
    </div>
  );
}
