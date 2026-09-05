import type { ListingDraftView, ListingPatchInput } from '@machiya/shared';
import { Loader2 } from 'lucide-react';
import { useAmenityGroups } from '../../hooks/use-listing-draft';
import { humanizeEnum } from '../../lib/format';
import { cn } from '../../lib/utils';

export function AmenitiesStep({
  draft,
  onPatch,
}: {
  draft: ListingDraftView;
  onPatch: (patch: ListingPatchInput) => void;
}) {
  const groups = useAmenityGroups();
  const selected = new Set(draft.amenitySlugs);

  const toggle = (slug: string) => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    // The patch replaces the set wholesale — the API treats a sent list as
    // "this is the set now", not "add these".
    onPatch({ amenitySlugs: [...next] });
  };

  if (groups.isPending) {
    return (
      <div className="flex items-center gap-2 p-6 text-ink-soft" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading the list…
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-5 pb-4">
      <p className="text-sm text-ink-soft">
        Optional, and worth doing — these are filters people actually use, so an unticked box is a
        search your listing does not appear in.
      </p>

      {(groups.data ?? []).map((group) => (
        <fieldset key={group.category}>
          <legend className="text-label mb-2 text-ink-soft">{humanizeEnum(group.category)}</legend>
          <div className="flex flex-wrap gap-1.5">
            {group.amenities.map((amenity) => {
              const on = selected.has(amenity.slug);
              return (
                <label
                  key={amenity.slug}
                  className={cn(
                    'text-label cursor-pointer rounded-[var(--radius-chrome)] border px-2.5 py-1.5',
                    'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-water',
                    on
                      ? 'border-water bg-water-soft text-ink'
                      : 'border-edge-strong text-ink-soft hover:bg-paper-sunken',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => {
                      toggle(amenity.slug);
                    }}
                  />
                  {amenity.name}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
