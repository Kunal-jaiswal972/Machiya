import type { Coordinate, ListingDraftView, OutOfCoverage } from '@machiya/shared';
import { coverageMessage } from '@machiya/shared';
import { MapPin, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCoverage, nearestCoveredCity } from '../../hooks/use-coverage';
import { describeCoordinate, reverseGeocode } from '../../lib/places';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { PinMap } from './PinMap';

/**
 * The location step, where three of this project's hard-won constraints meet.
 *
 * **The pin is the fact and the typed address is a label (D59).** The reverse
 * geocode fills the locality box *only* when it actually resolved a locality;
 * the street line is always left empty and editable, because at Golghar the
 * geocoder answers "Patna" and writing that into a street field would be a
 * confident lie the lister then has to notice and undo.
 *
 * **Coverage is checked on the coordinate, and a refusal blocks this step
 * (D53).** The served cities render as one-tap buttons from the payload the
 * error carries, so nobody fills six steps and fails at publish.
 *
 * **The city is resolved from the coordinates, not from a dropdown (D50).** It
 * is re-resolved whenever the pin moves, which is what the server does with a
 * patch that carries a new lat/lng — so there is no city control on this screen
 * at all, only the name of the city the pin landed in.
 */
export interface LocationStepProps {
  draft: ListingDraftView | undefined;
  /** Creates the draft row from the first accepted pin. */
  onOpenDraft: (input: {
    citySlug: string;
    lat: number;
    lng: number;
    locality?: string | undefined;
  }) => Promise<void>;
  onPatch: (patch: {
    lat?: number;
    lng?: number;
    citySlug?: string;
    locality?: string | null;
    address?: string | null;
  }) => void;
  /** Set when the last write was refused as out of coverage. */
  coverageRefusal: OutOfCoverage | null;
  onClearRefusal: () => void;
  busy: boolean;
}

export function LocationStep({
  draft,
  onOpenDraft,
  onPatch,
  coverageRefusal,
  onClearRefusal,
  busy,
}: LocationStepProps) {
  const { cities, maxBounds } = useCoverage();

  const [pin, setPin] = useState<Coordinate | null>(
    draft ? { lat: draft.lat, lng: draft.lng } : null,
  );
  const [locality, setLocality] = useState(draft?.locality ?? '');
  const [address, setAddress] = useState(draft?.address ?? '');
  const [naming, setNaming] = useState(false);
  const [precisionNote, setPrecisionNote] = useState<string | null>(null);
  const [localCoverage, setLocalCoverage] = useState<OutOfCoverage | null>(null);

  /**
   * Seeded from the draft ONCE per draft, not on every change to it.
   *
   * `draft` gets a fresh object identity after each autosave, so keying this on
   * the object re-ran it while someone was typing in the other box: the
   * locality's save landed, this fired, and the half-typed street address was
   * replaced by the server's copy mid-word (docs/ux-audit.md W-02). The draft
   * id is what actually means "a different listing".
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || seededFor.current === draft.id) return;
    seededFor.current = draft.id;
    setPin({ lat: draft.lat, lng: draft.lng });
    setLocality(draft.locality ?? '');
    setAddress(draft.address ?? '');
  }, [draft]);

  const refusal = coverageRefusal ?? localCoverage;

  const handlePick = useCallback(
    async (point: Coordinate) => {
      setPin(point);
      setNaming(true);
      onClearRefusal();
      setLocalCoverage(null);

      let resolvedLocality: string | undefined;

      try {
        const { place, coverage } = await reverseGeocode(point);

        if (coverage) {
          // Refused before anything is written. The pin stays where it was
          // dropped so the buttons below can be read against it.
          setLocalCoverage(coverage);
          setNaming(false);
          return;
        }

        // D59's first rule. `exact` is a building or a named POI, so it is a
        // reasonable locality label too; `locality` is a neighbourhood, suburb
        // or road. `area` is the city, which is not a locality and must not be
        // written into one.
        if (place && place.matchPrecision !== 'area') {
          resolvedLocality = place.label;
          setLocality(place.label);
          setPrecisionNote(
            place.matchPrecision === 'locality'
              ? `Nearest we could name is ${place.label} — correct it if the locality is different.`
              : null,
          );
        } else {
          setPrecisionNote(
            place
              ? `We could only resolve this to ${place.label}, so the locality is yours to fill in.`
              : 'Nothing is mapped at this point, so the locality is yours to fill in.',
          );
        }
      } catch {
        // A failed lookup is not an uncovered point: the pin stands and the
        // boxes stay editable.
        setPrecisionNote('Could not look that point up — fill the locality in yourself.');
      } finally {
        setNaming(false);
      }

      const citySlug =
        nearestCoveredCity(cities, point)?.slug ?? draft?.citySlug ?? cities[0]?.slug;
      if (!citySlug) return;

      if (draft) {
        // The server re-resolves the city from the coordinates whenever the pin
        // moves, so the slug sent here is only the hint D50 describes.
        // The locality is only written when the lookup produced one. Sending
        // `null` because THIS point resolved no further than the city wiped a
        // locality the lister had typed by hand (docs/ux-audit.md W-03).
        onPatch({
          lat: point.lat,
          lng: point.lng,
          citySlug,
          ...(resolvedLocality ? { locality: resolvedLocality } : {}),
        });
      } else {
        await onOpenDraft({
          citySlug,
          lat: point.lat,
          lng: point.lng,
          ...(resolvedLocality ? { locality: resolvedLocality } : {}),
        });
      }
    },
    [cities, draft, onClearRefusal, onOpenDraft, onPatch],
  );

  const initialCenter = cities[0]?.centroid ?? { lat: 25.5941, lng: 85.1376 };

  return (
    <div className="grid h-full gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="min-h-[22rem] lg:min-h-0">
        <PinMap
          pin={pin}
          initialCenter={initialCenter}
          maxBounds={maxBounds}
          onPick={(point) => {
            void handlePick(point);
          }}
          busy={busy || naming}
        />
      </div>

      <div className="flex flex-col gap-4">
        {refusal ? (
          <CoverageRefusal
            coverage={refusal}
            onPickCity={(centroid) => {
              void handlePick(centroid);
            }}
          />
        ) : (
          <div className="chrome p-3">
            <p className="text-label flex items-center gap-1.5">
              <MapPin className="size-3.5 text-water" aria-hidden />
              {pin ? 'Pin placed' : 'Click the map to place the pin'}
            </p>
            <p className="text-data mt-1 text-ink-soft">
              {pin ? describeCoordinate(pin) : 'Drag it afterwards to fine-tune.'}
            </p>
            {draft ? (
              <p className="text-data mt-1 text-ink-faint">
                {/* Resolved from the coordinates, never chosen. */}
                Filed under {draft.cityName}
              </p>
            ) : null}
          </div>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="wizard-locality">Locality</Label>
          <Input
            id="wizard-locality"
            value={locality}
            placeholder="Golghar, Koramangala, Kothrud…"
            disabled={!draft}
            onChange={(event) => {
              setLocality(event.target.value);
            }}
            onBlur={() => {
              onPatch({ locality: locality.trim() === '' ? null : locality.trim() });
            }}
          />
          {precisionNote ? <p className="text-data text-ink-soft">{precisionNote}</p> : null}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="wizard-address">Street address</Label>
          <Input
            id="wizard-address"
            value={address}
            placeholder="House and street, as you would write it on a letter"
            disabled={!draft}
            onChange={(event) => {
              setAddress(event.target.value);
            }}
            onBlur={() => {
              onPatch({ address: address.trim() === '' ? null : address.trim() });
            }}
          />
          {/* Deliberately never prefilled. Nominatim resolves a house number in
              Indian cities roughly one time in ten, so filling this from a
              reverse geocode would be an approximation presented as an address. */}
          <p className="text-data text-ink-soft">
            We do not guess this one — the map knows where the pin is, not what your door says.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The refusal, with the served cities as actions.
 *
 * The point of carrying the payload on the error rather than only a sentence
 * (D53): these are buttons, not a list to read.
 */
function CoverageRefusal({
  coverage,
  onPickCity,
}: {
  coverage: OutOfCoverage;
  onPickCity: (centroid: Coordinate) => void;
}) {
  return (
    <div className="chrome border-clay/40 p-3">
      <p className="text-label flex items-center gap-1.5 text-clay">
        <TriangleAlert className="size-3.5" aria-hidden />
        Outside the area we cover
      </p>
      <p className="mt-1 text-sm text-ink-soft">{coverageMessage(coverage)}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {coverage.supportedCities.map((city) => (
          <Button
            key={city.slug}
            size="sm"
            variant="secondary"
            onClick={() => {
              // Re-runs the whole pick at that city's centroid, so the camera
              // moves, the reverse geocode runs and the draft opens — rather
              // than merely dismissing the refusal.
              onPickCity(city.centroid);
            }}
          >
            {city.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
