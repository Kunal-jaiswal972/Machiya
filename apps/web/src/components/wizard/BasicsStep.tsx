import type { ListingDraftView, ListingPatchInput } from '@machiya/shared';
import { FURNISHING_TYPES, PROPERTY_TYPES } from '@machiya/shared';
import { humanizeEnum } from '../../lib/format';
import { ChipGroup, TextField } from './fields';
import { Field } from './fields';

const PROPERTY_OPTIONS = PROPERTY_TYPES.map((value) => ({ value, label: humanizeEnum(value) }));
const FURNISHING_OPTIONS = FURNISHING_TYPES.map((value) => ({ value, label: humanizeEnum(value) }));

export function BasicsStep({
  draft,
  onPatch,
}: {
  draft: ListingDraftView;
  onPatch: (patch: ListingPatchInput) => void;
}) {
  const commitNumber = (key: 'bedrooms' | 'bathrooms' | 'areaSqft' | 'floor' | 'totalFloors') => {
    return (raw: string) => {
      const trimmed = raw.trim();
      // An emptied number box means "I do not know yet", which is a null the
      // draft can hold — not a zero, which would be a claim.
      onPatch({ [key]: trimmed === '' ? null : Number(trimmed) } as ListingPatchInput);
    };
  };

  return (
    <div className="mx-auto grid max-w-3xl gap-5 pb-4">
      <ChipGroup
        name="listingType"
        label="Are you letting it or selling it?"
        value={draft.listingType}
        options={[
          { value: 'RENT' as const, label: 'To let' },
          { value: 'SALE' as const, label: 'For sale' },
        ]}
        onSelect={(listingType) => {
          onPatch({ listingType });
        }}
      />

      <ChipGroup
        name="propertyType"
        label="What kind of property"
        value={draft.propertyType}
        options={PROPERTY_OPTIONS}
        onSelect={(propertyType) => {
          onPatch({ propertyType });
        }}
      />

      <TextField
        id="wizard-title"
        label="Title"
        value={draft.title ?? ''}
        placeholder="Bright 2BHK a short walk from Golghar"
        hint="What someone scanning a list of forty flats would notice. At least 8 characters."
        onCommit={(title) => {
          onPatch({ title: title.trim() === '' ? null : title.trim() });
        }}
      />

      <Field
        label="Description"
        htmlFor="wizard-description"
        hint="At least 30 characters. Say what a photo cannot: the light, the water, the neighbours."
      >
        <textarea
          id="wizard-description"
          key={draft.description ?? ''}
          defaultValue={draft.description ?? ''}
          rows={5}
          className="w-full rounded-[var(--radius-chrome)] border bg-transparent px-3 py-2 text-sm"
          onBlur={(event) => {
            const value = event.target.value.trim();
            onPatch({ description: value === '' ? null : value });
          }}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          id="wizard-bedrooms"
          label="Bedrooms"
          type="number"
          value={draft.bedrooms === null ? '' : String(draft.bedrooms)}
          onCommit={commitNumber('bedrooms')}
        />
        <TextField
          id="wizard-bathrooms"
          label="Bathrooms"
          type="number"
          value={draft.bathrooms === null ? '' : String(draft.bathrooms)}
          onCommit={commitNumber('bathrooms')}
        />
        <TextField
          id="wizard-area"
          label="Carpet area"
          type="number"
          hint="Square feet"
          value={draft.areaSqft === null ? '' : String(draft.areaSqft)}
          onCommit={commitNumber('areaSqft')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="wizard-floor"
          label="Floor"
          type="number"
          hint="Leave empty for a house. 0 is the ground floor."
          value={draft.floor === null ? '' : String(draft.floor)}
          onCommit={commitNumber('floor')}
        />
        <TextField
          id="wizard-total-floors"
          label="Floors in the building"
          type="number"
          value={draft.totalFloors === null ? '' : String(draft.totalFloors)}
          onCommit={commitNumber('totalFloors')}
        />
      </div>

      <ChipGroup
        name="furnishing"
        label="Furnishing"
        value={draft.furnishing}
        options={FURNISHING_OPTIONS}
        onSelect={(furnishing) => {
          onPatch({ furnishing });
        }}
      />
    </div>
  );
}
