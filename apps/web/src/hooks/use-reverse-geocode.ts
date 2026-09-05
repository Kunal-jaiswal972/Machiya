import type { Coordinate, OutOfCoverage } from '@machiya/shared';
import { useMutation } from '@tanstack/react-query';
import { describeCoordinate, reverseGeocode } from '../lib/places';

/**
 * Names a dropped pin, without making the map wait for it.
 *
 * A mutation rather than a query because it is fired by a gesture — a click or
 * a drag-end — not derived from state. The office moves immediately and the
 * label arrives when it arrives: making someone wait on a network round trip
 * before the rings move would be backwards, and a pin over an unmapped field is
 * a legitimate office the geocoder simply cannot name.
 *
 * The coverage half is the part worth having in one place: `place: null` with a
 * `coverage` payload means the point is outside the served cities, which is a
 * different answer from "no address here" and wants a different UI.
 */
export interface OfficeNaming {
  /** Fire it at a point; the callbacks below deliver the answer. */
  name: (point: Coordinate) => void;
  isNaming: boolean;
}

export function useReverseGeocode(handlers: {
  onNamed: (label: string) => void;
  onCoverage: (coverage: OutOfCoverage | null) => void;
}): OfficeNaming {
  const mutation = useMutation({
    mutationFn: (point: Coordinate) => reverseGeocode(point),
    onSuccess: ({ place, coverage }, point) => {
      handlers.onCoverage(coverage ?? null);
      handlers.onNamed(
        place?.label
          ? [place.label, place.context].filter(Boolean).join(', ')
          : describeCoordinate(point),
      );
    },
    onError: (_error, point) => {
      // A failed lookup is not an uncovered point: show the coordinates, which
      // are a perfectly good description of where the pin is.
      handlers.onCoverage(null);
      handlers.onNamed(describeCoordinate(point));
    },
  });

  return { name: mutation.mutate, isNaming: mutation.isPending };
}
