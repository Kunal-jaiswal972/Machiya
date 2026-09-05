import type { ListingDraftView, ListingPatchInput } from '@machiya/shared';
import { formatRupees } from '../../lib/format';
import { TextField } from './fields';

/**
 * Pricing, with the product's own argument stated where a lister will read it.
 *
 * The maintenance box carries a line about total monthly cost because a lister
 * who leaves it blank is under-reporting the number this whole product ranks
 * on — and they are the only person who knows it.
 */
export function PricingStep({
  draft,
  onPatch,
}: {
  draft: ListingDraftView;
  onPatch: (patch: ListingPatchInput) => void;
}) {
  const commitMoney =
    (key: 'rentAmount' | 'salePrice' | 'securityDeposit' | 'maintenanceMonthly') =>
    (raw: string) => {
      const digits = raw.replace(/[^0-9]/g, '');
      onPatch({ [key]: digits === '' ? null : Number(digits) } as ListingPatchInput);
    };

  const isRent = draft.listingType === 'RENT';

  const monthly =
    isRent && draft.rentAmount !== null ? draft.rentAmount + (draft.maintenanceMonthly ?? 0) : null;

  return (
    <div className="mx-auto grid max-w-2xl gap-5 pb-4">
      {isRent ? (
        <TextField
          id="wizard-rent"
          label="Monthly rent"
          type="number"
          hint="Whole rupees."
          value={draft.rentAmount === null ? '' : String(draft.rentAmount)}
          onCommit={commitMoney('rentAmount')}
        />
      ) : (
        <TextField
          id="wizard-sale-price"
          label="Asking price"
          type="number"
          hint="Whole rupees."
          value={draft.salePrice === null ? '' : String(draft.salePrice)}
          onCommit={commitMoney('salePrice')}
        />
      )}

      {isRent ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="wizard-deposit"
            label="Security deposit"
            type="number"
            hint="Leave empty if there is none."
            value={draft.securityDeposit === null ? '' : String(draft.securityDeposit)}
            onCommit={commitMoney('securityDeposit')}
          />
          <TextField
            id="wizard-maintenance"
            label="Monthly maintenance"
            type="number"
            hint="Counted into the total monthly cost people sort by. Leaving it out makes your listing look cheaper than it is, and the enquiry you get will be from someone who then learns otherwise."
            value={draft.maintenanceMonthly === null ? '' : String(draft.maintenanceMonthly)}
            onCommit={commitMoney('maintenanceMonthly')}
          />
        </div>
      ) : null}

      {monthly === null ? null : (
        <div className="chrome p-3">
          <p className="text-label text-ink-soft">Before the commute</p>
          <p className="text-price-lg mt-0.5 text-signal-ink dark:text-signal">
            {formatRupees(monthly)}
            <span className="text-label text-ink-faint"> /mo</span>
          </p>
          <p className="text-data mt-1 text-ink-soft">
            Each seeker sees this plus their own commute from their own office, which is what the
            list is ranked by.
          </p>
        </div>
      )}
    </div>
  );
}
