import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * Designed empty states (docs/design.md).
 *
 * Three parts, always: an illustration built from the design's own vocabulary —
 * ring tracks, map hairlines, a price chip — one sentence naming what is
 * missing, and one button that does the next useful thing. An empty screen is
 * an invitation to act, not a place to apologise.
 */
export type EmptyIllustration = 'rings' | 'listing' | 'thread' | 'heart' | 'search';

function Illustration({ kind }: { kind: EmptyIllustration }) {
  const common = {
    width: 132,
    height: 92,
    viewBox: '0 0 132 92',
    fill: 'none' as const,
    'aria-hidden': true,
  };

  // A faint map graticule sits behind every one of them, so the empty state
  // still reads as part of the same surface as the search.
  const grid = (
    <g stroke="var(--color-edge)" strokeWidth={1} opacity={0.7}>
      <path d="M0 24h132M0 48h132M0 72h132" />
      <path d="M26 0v92M62 0v92M98 0v92" />
    </g>
  );

  if (kind === 'rings') {
    return (
      <svg {...common}>
        {grid}
        <circle cx={66} cy={46} r={30} stroke="var(--color-ring-3)" strokeWidth={2} opacity={0.5} />
        <circle cx={66} cy={46} r={20} stroke="var(--color-ring-2)" strokeWidth={2} opacity={0.6} />
        <circle cx={66} cy={46} r={10} stroke="var(--color-ring-1)" strokeWidth={2} />
        <circle cx={66} cy={46} r={3.5} fill="var(--color-water)" />
      </svg>
    );
  }

  if (kind === 'search') {
    return (
      <svg {...common}>
        {grid}
        <circle cx={60} cy={42} r={18} stroke="var(--color-water)" strokeWidth={2.5} />
        <path
          d="M73 55l14 14"
          stroke="var(--color-water)"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <rect
          x={40}
          y={70}
          width={46}
          height={14}
          rx={2}
          fill="var(--color-signal)"
          opacity={0.35}
        />
      </svg>
    );
  }

  if (kind === 'listing') {
    return (
      <svg {...common}>
        {grid}
        <rect
          x={34}
          y={26}
          width={64}
          height={44}
          rx={2}
          fill="var(--color-paper-sunken)"
          stroke="var(--color-edge-strong)"
          strokeWidth={1.5}
        />
        <path
          d="M34 52l16-12 14 10 12-8 22 16"
          stroke="var(--color-edge-strong)"
          strokeWidth={1.5}
        />
        <rect x={40} y={58} width={28} height={8} rx={2} fill="var(--color-signal)" opacity={0.5} />
      </svg>
    );
  }

  if (kind === 'thread') {
    return (
      <svg {...common}>
        {grid}
        <rect
          x={26}
          y={24}
          width={58}
          height={26}
          rx={2}
          fill="var(--color-paper-sunken)"
          stroke="var(--color-edge-strong)"
          strokeWidth={1.5}
        />
        <rect
          x={50}
          y={54}
          width={56}
          height={22}
          rx={2}
          fill="var(--color-water-soft)"
          stroke="var(--color-water)"
          strokeWidth={1.5}
        />
      </svg>
    );
  }

  return (
    <svg {...common}>
      {grid}
      <path
        d="M66 74S38 58 38 42a14 14 0 0128-6 14 14 0 0128 6c0 16-28 32-28 32z"
        stroke="var(--color-clay)"
        strokeWidth={2}
        fill="none"
      />
    </svg>
  );
}

export interface EmptyStateProps {
  illustration: EmptyIllustration;
  /** One sentence naming what is missing. Not a paragraph. */
  title: string;
  /** Optional second line, only when it tells them something they can use. */
  detail?: string;
  /** The next useful thing. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ illustration, title, detail, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      <Illustration kind={illustration} />
      <p className="text-title max-w-[28ch] text-balance">{title}</p>
      {detail ? <p className="max-w-[42ch] text-sm text-ink-soft">{detail}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
