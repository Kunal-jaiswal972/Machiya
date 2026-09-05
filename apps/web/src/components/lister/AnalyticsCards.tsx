import type { ListerAnalytics } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';

/**
 * Views over time and enquiry conversion, with the definition of "view"
 * attached.
 *
 * D44 is the whole reason this component reads the way it does. A view here is
 * **one viewer per thirty-minute window, with the owner excluded** — not a page
 * load — and the caption says so using the window the API sent rather than a
 * number typed here, so the two cannot drift apart. A chart that silently meant
 * page loads would flatter every listing and be worse than no chart.
 *
 * The cards animate in on load; the chart itself does not animate its bars,
 * because the numbers are what the reader came for.
 */
export function AnalyticsCards({ analytics }: { analytics: ListerAnalytics }) {
  const reduced = useReducedMotion();
  const { totals } = analytics;

  const cards = [
    { label: 'Views', value: String(totals.views), meta: `last ${String(analytics.days)} days` },
    { label: 'Enquiries', value: String(totals.enquiries), meta: 'threads opened' },
    {
      label: 'Enquiries per 100 views',
      value:
        totals.enquiriesPerHundredViews === null ? '—' : totals.enquiriesPerHundredViews.toFixed(1),
      // Not "conversion rate": an enquiry is a person and a view is a
      // person-window, so the two are not the same denominator a funnel implies.
      meta: totals.views === 0 ? 'no views yet' : 'not a funnel — see the note',
    },
    { label: 'Saved by', value: String(totals.favorites), meta: 'people, all time' },
  ];

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((card, index) => (
          <motion.div
            key={card.label}
            className="chrome p-3"
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.24, delay: index * 0.04 }}
          >
            <p className="text-label text-ink-soft">{card.label}</p>
            <p className="text-price-lg mt-0.5">{card.value}</p>
            <p className="text-data mt-0.5 text-ink-faint">{card.meta}</p>
          </motion.div>
        ))}
      </div>

      <ViewsChart analytics={analytics} />
    </div>
  );
}

function ViewsChart({ analytics }: { analytics: ListerAnalytics }) {
  const titleId = useId();
  const series = analytics.series;
  const peak = Math.max(1, ...series.map((point) => point.views));

  const width = 720;
  const height = 120;
  const gap = 2;
  const barWidth = Math.max(1, width / Math.max(series.length, 1) - gap);

  return (
    <figure className="chrome p-3">
      <figcaption className="text-label mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span>Views per day</span>
        <span className="text-data text-ink-faint">
          {/* Stated from the payload, not from a constant typed here. */}
          one viewer per {analytics.viewWindowMinutes} minutes
          {analytics.excludesOwner ? ', your own visits excluded' : ''}
        </span>
      </figcaption>

      {series.every((point) => point.views === 0) ? (
        <p className="text-data py-6 text-center text-ink-soft">
          Nothing yet. Views appear here the day after someone opens a listing.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${String(width)} ${String(height)}`}
            className="h-[120px] w-full min-w-[420px]"
            role="img"
            aria-labelledby={titleId}
            preserveAspectRatio="none"
          >
            <title id={titleId}>
              {`Daily views over the last ${String(analytics.days)} days, peaking at ${String(peak)}`}
            </title>

            {series.map((point, index) => {
              const barHeight = (point.views / peak) * (height - 18);
              const x = index * (barWidth + gap);

              return (
                <g key={point.date}>
                  <rect
                    x={x}
                    y={height - 14 - barHeight}
                    width={barWidth}
                    height={Math.max(barHeight, point.views > 0 ? 1.5 : 0)}
                    fill="var(--color-water)"
                    opacity={0.85}
                  >
                    <title>{`${point.date}: ${String(point.views)} views, ${String(point.enquiries)} enquiries`}</title>
                  </rect>
                  {/* An enquiry sits on its day as a mark rather than a second
                      bar: there are far fewer of them, and a second scale on
                      one axis is a chart nobody reads correctly. */}
                  {point.enquiries > 0 ? (
                    <circle
                      cx={x + barWidth / 2}
                      cy={height - 14 - barHeight - 4}
                      r={2.5}
                      fill="var(--color-signal)"
                    />
                  ) : null}
                </g>
              );
            })}

            <line
              x1={0}
              y1={height - 13}
              x2={width}
              y2={height - 13}
              stroke="var(--color-edge-strong)"
              strokeWidth={1}
            />
          </svg>
        </div>
      )}

      <p className="text-data mt-1.5 flex flex-wrap gap-x-3 text-ink-faint">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm bg-water" aria-hidden />
          views
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-signal" aria-hidden />a day with an
          enquiry
        </span>
      </p>
    </figure>
  );
}
