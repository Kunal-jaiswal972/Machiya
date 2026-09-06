import { RING_RADII_METERS, type Ring } from '@machiya/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { RingGauge } from './RingGauge';
import { cn } from '../lib/utils';

/**
 * How far out this listing is, as a judgement rather than a number.
 *
 * Green, amber, red for the 1, 2 and 3 km rings — but **never colour alone**:
 * the label carries the same fact in words, so the badge survives a greyscale
 * screenshot and every kind of colour blindness. The tooltip explains the
 * scheme, because a coloured dot that nobody has been told the meaning of is
 * decoration (docs/ux-audit.md, the ring item in the brief).
 *
 * The same three tokens tint the ring geometry on the map, so a green badge on
 * a card and the green ring it sits inside are visibly one system.
 */
const RING_LABEL: Record<Ring, string> = {
  1: 'within 1 km',
  2: 'within 2 km',
  3: 'within 3 km',
};

const RING_TONE: Record<Ring, string> = {
  1: 'text-verdant',
  2: 'text-signal-ink dark:text-signal',
  3: 'text-clay',
};

const RING_DOT: Record<Ring, string> = {
  1: 'bg-verdant',
  2: 'bg-signal',
  3: 'bg-clay',
};

export interface RingBadgeProps {
  ring: Ring;
  /** Straight-line metres, shown beside the label. */
  distanceMeters: number;
  /** Road metres, when a route has been measured. Only the large size uses it. */
  roadMeters?: number | null;
  size?: 'sm' | 'lg';
  className?: string;
}

export function RingBadge({
  ring,
  distanceMeters,
  roadMeters,
  size = 'sm',
  className,
}: RingBadgeProps) {
  const label = RING_LABEL[ring];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-round border border-edge px-1.5 py-0.5',
            size === 'lg' && 'gap-2 px-2 py-1',
            className,
          )}
        >
          <span className={cn('size-2 shrink-0 rounded-round', RING_DOT[ring])} aria-hidden />
          <span className={cn('text-label whitespace-nowrap', RING_TONE[ring])}>{label}</span>
          {size === 'lg' ? (
            <RingGauge
              ring={ring}
              distanceMeters={distanceMeters}
              roadMeters={roadMeters ?? null}
              size={56}
            />
          ) : null}
        </span>
      </TooltipTrigger>

      <TooltipContent className="max-w-64">
        <p className="font-medium">{label} of your office</p>
        <p className="mt-1">
          Green is the first kilometre, amber the second, red the third. It is straight-line
          distance — {Math.round(distanceMeters)} m here
          {roadMeters ? `, and ${(roadMeters / 1000).toFixed(1)} km by road` : ''}.
        </p>
        <p className="mt-1 text-ink-faint">
          Everything shown is inside {(RING_RADII_METERS[2] ?? 3000) / 1000} km.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
