import { RING_RADII_METERS, type Ring } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '../lib/utils';

/**
 * The signature element (docs/design.md).
 *
 * Three concentric tracks — 1 km, 2 km, 3 km. The track containing the listing
 * is filled; the others stay quiet. A tick outside the rings marks ROAD distance
 * against the straight-line fill, so the gap between "2.4 km away" and "6.1 km
 * of actual road" is visible rather than explained.
 *
 * It is the product's argument as a glyph, so it appears at exactly three sizes
 * and nowhere else. Inline SVG, no library.
 */
export interface RingGaugeProps {
  ring: Ring;
  /** Straight-line metres. Drives the arc. */
  distanceMeters: number;
  /** Road metres from OSRM, when known. Drives the tick. */
  roadMeters?: number | null;
  size?: 20 | 56 | 96;
  className?: string;
}

const TRACK_COLORS = ['var(--color-ring-1)', 'var(--color-ring-2)', 'var(--color-ring-3)'];

export function RingGauge({
  ring,
  distanceMeters,
  roadMeters,
  size = 20,
  className,
}: RingGaugeProps) {
  const reduced = useReducedMotion();
  const box = 100;
  const center = box / 2;

  // At 20px, three concentric tracks are three grey smudges — so the small
  // variant collapses to ONE thick track showing which ring this is, and only
  // the larger sizes draw the full dial. A gauge whose ticks cannot be resolved
  // is noise, and noise beside a price is worse than nothing.
  const compact = size < 56;

  // Three tracks, evenly spaced, outermost first so the fill draws on top.
  const radii = compact ? [34, 34, 34] : [18, 30, 42];
  const outer = radii[2] ?? 42;

  const activeRadius = radii[ring - 1] ?? outer;
  const maxMeters = RING_RADII_METERS[2];

  // Fraction of the way through the whole 3 km, used for the arc sweep.
  const fraction = Math.max(0.04, Math.min(1, distanceMeters / maxMeters));
  const circumference = 2 * Math.PI * activeRadius;

  // The road tick sits outside the tracks. Beyond 3 km of road it pins to the
  // edge rather than leaving the box — the point is "further by road", and how
  // much further is the label's job.
  const roadFraction =
    roadMeters === null || roadMeters === undefined
      ? null
      : Math.max(0.04, Math.min(1, roadMeters / maxMeters));

  const showTicks = size >= 56;

  return (
    <svg
      viewBox={`0 0 ${String(box)} ${String(box)}`}
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      role="img"
      aria-label={
        roadMeters === null || roadMeters === undefined
          ? `Ring ${String(ring)}, ${String(Math.round(distanceMeters))} metres straight line`
          : `Ring ${String(ring)}, ${String(Math.round(distanceMeters))} metres straight line, ${String(Math.round(roadMeters))} metres by road`
      }
    >
      {(compact ? [radii[0] ?? 34] : radii).map((radius, index) => (
        <circle
          key={`${String(radius)}-${String(index)}`}
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={compact ? TRACK_COLORS[ring - 1] : TRACK_COLORS[index]}
          strokeWidth={compact ? 12 : 3}
          opacity={compact ? 0.3 : index + 1 === ring ? 0.28 : 0.16}
        />
      ))}

      {/* The filled arc. `signal` is the price and active-ring colour, and this
          is the active ring — the one place it appears outside a price. */}
      <motion.circle
        cx={center}
        cy={center}
        r={activeRadius}
        fill="none"
        stroke="var(--color-signal)"
        strokeWidth={compact ? 12 : 5}
        strokeLinecap="round"
        transform={`rotate(-90 ${String(center)} ${String(center)})`}
        strokeDasharray={circumference}
        initial={reduced ? false : { strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: circumference * (1 - fraction) }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 120, damping: 20 }}
      />

      {showTicks && roadFraction !== null && (
        <g transform={`rotate(-90 ${String(center)} ${String(center)})`}>
          {/* Road distance, as a tick on an outer arc. Deliberately a
                different shape from the fill: it is a different measurement. */}
          <circle
            cx={center}
            cy={center}
            r={outer + 6}
            fill="none"
            stroke="var(--color-ink-faint)"
            strokeWidth={1}
            opacity={0.35}
          />
          <line
            x1={center + outer + 1}
            y1={center}
            x2={center + outer + 11}
            y2={center}
            stroke="var(--color-water)"
            strokeWidth={2.5}
            strokeLinecap="round"
            transform={`rotate(${String(roadFraction * 360)} ${String(center)} ${String(center)})`}
          />
        </g>
      )}

      {size >= 56 && (
        <text
          x={center}
          y={center + 4}
          textAnchor="middle"
          className="fill-ink"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 20, letterSpacing: '0.02em' }}
        >
          {ring}
        </text>
      )}
    </svg>
  );
}
