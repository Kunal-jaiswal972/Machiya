import { coverageMessage, type OutOfCoverage } from '@machiya/shared';
import { Check, Loader2, MapPin } from 'lucide-react';
import { useId, useState } from 'react';
import { useCoverageRequest } from '../../hooks/use-coverage';
import { Button } from '../ui/button';
import { EmptyState } from '../EmptyState';
import { Input } from '../ui/input';

/**
 * The out-of-coverage state: "Machiya covers Patna, Bengaluru and Pune.
 * Bengaluru is nearest, 840 km away."
 *
 * The designed alternative to an empty result set, and the reason the whole
 * concept exists. Three parts, in the order they are useful:
 *
 *  1. **the message**, built from the response rather than hardcoded here, so
 *     a fourth city changes it with no edit to this file;
 *  2. **the supported cities as one-tap actions**, because the most likely next
 *     thing a visitor wants is to look at a city that does exist;
 *  3. **an email capture**, because "tell me when you cover Mumbai" is a signal
 *     for which city to add fourth and a dead end is not.
 *
 * Copy is honest about what happens next: it says the address is recorded, not
 * that the city is coming.
 */
export interface CoverageNoticeProps {
  coverage: OutOfCoverage;
  /** Move the search to a covered city. */
  onPickCity: (city: OutOfCoverage['supportedCities'][number]) => void;
  className?: string;
}

export function CoverageNotice({ coverage, onPickCity, className }: CoverageNoticeProps) {
  const emailId = useId();
  const [email, setEmail] = useState('');
  const ask = useCoverageRequest();

  const place = coverage.requestedLabel ?? 'there';

  return (
    <div className={className}>
      <EmptyState
        illustration="rings"
        title={coverageMessage(coverage)}
        detail={
          coverage.requestedLabel
            ? `${coverage.requestedLabel} is outside the three cities we have map data for. Everything here — routes, nearby places, commute cost — is measured on real roads, and we have only mapped the cities below.`
            : 'Everything here — routes, nearby places, commute cost — is measured from a real road graph, and we only build one per city we cover.'
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {coverage.supportedCities.map((city) => (
              <Button key={city.slug} variant="outline" size="sm" onClick={() => onPickCity(city)}>
                <MapPin aria-hidden />
                {city.name}
              </Button>
            ))}
          </div>
        }
      />

      {coverage.requested ? (
        <div className="mx-auto max-w-sm border-t border-edge px-6 pt-4 pb-6">
          {ask.requests === null ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (email.trim().length > 0) {
                  ask.submit({
                    email: email.trim(),
                    // No requested point means the query never resolved to a
                    // coordinate — an autocomplete miss rather than a dropped
                    // pin. The form is hidden in that case, so this branch is
                    // unreachable from the UI and the `?? 0` is only here
                    // because the type allows it.
                    lat: coverage.requested?.lat ?? 0,
                    lng: coverage.requested?.lng ?? 0,
                    ...(coverage.requestedLabel ? { placeLabel: coverage.requestedLabel } : {}),
                  });
                }
              }}
              className="flex flex-col gap-2"
            >
              <label htmlFor={emailId} className="text-label text-ink-soft">
                Tell me when you cover {place}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={emailId}
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={ask.isSaving}>
                  {ask.isSaving ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Notify me
                </Button>
              </div>
              {ask.error ? (
                <p role="alert" className="text-data text-clay">
                  {ask.error.message}
                </p>
              ) : (
                <p className="text-data text-ink-faint">
                  We record the request and the location. No newsletter.
                </p>
              )}
            </form>
          ) : (
            <p className="flex items-start gap-1.5 text-sm text-ink-soft">
              <Check className="mt-0.5 size-4 shrink-0 text-water" aria-hidden />
              <span>
                Recorded.{' '}
                {ask.requests > 1
                  ? `${String(ask.requests)} people have asked about somewhere near ${place}.`
                  : `You are the first to ask about ${place}.`}
              </span>
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
