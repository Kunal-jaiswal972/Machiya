import type { ListerAnalytics } from '@machiya/shared';
import { motion, useReducedMotion } from 'motion/react';
import { Bar, BarChart, CartesianGrid, Line, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '../ui/chart';

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
 * The cards animate in on load. The chart's own bars do not: `isAnimationActive`
 * is off, because no animation may gate the appearance of content the reader is
 * waiting for, and the numbers are what they came for.
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
      // person-window, so the two are not the denominators a funnel implies.
      meta: totals.views === 0 ? 'no views yet' : 'per 100 people who looked',
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

/**
 * Colours come from the design tokens, not from recharts' defaults.
 *
 * `water` is the colour of a measured thing everywhere else in this product,
 * and `signal` is reserved for price and the active ring — an enquiry earns it
 * here because it is the outcome a lister is actually reading the chart for.
 */
const CHART_CONFIG = {
  views: { label: 'Views', color: 'var(--color-water)' },
  enquiries: { label: 'Enquiries', color: 'var(--color-signal)' },
} satisfies ChartConfig;

function ViewsChart({ analytics }: { analytics: ListerAnalytics }) {
  const empty = analytics.series.every((point) => point.views === 0 && point.enquiries === 0);

  return (
    <figure className="chrome p-3">
      <figcaption className="text-label mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span>Views and enquiries per day</span>
        <span className="text-data text-ink-faint">
          {/* Stated from the payload, not from a constant typed here. */}
          one viewer per {analytics.viewWindowMinutes} minutes
          {analytics.excludesOwner ? ', your own visits excluded' : ''}
        </span>
      </figcaption>

      {empty ? (
        <p className="text-data py-8 text-center text-ink-soft">
          Nothing yet. Views appear here the day after someone opens a listing.
        </p>
      ) : (
        <ChartContainer config={CHART_CONFIG} className="h-[180px] w-full">
          <BarChart data={analytics.series} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <CartesianGrid vertical={false} stroke="var(--color-edge)" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={formatDayTick}
            />
            <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent labelFormatter={formatTooltipLabel} />}
            />
            <Bar dataKey="views" fill="var(--color-views)" radius={2} isAnimationActive={false} />
            {/* A line rather than a second bar: enquiries are an order of
                magnitude rarer than views, so two bars on one scale would make
                them invisible and two scales would make the chart unreadable. */}
            <Line
              type="monotone"
              dataKey="enquiries"
              stroke="var(--color-enquiries)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </BarChart>
        </ChartContainer>
      )}
    </figure>
  );
}

const DAY_TICK = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const DAY_FULL = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function formatDayTick(value: string): string {
  return DAY_TICK.format(new Date(value));
}

function formatTooltipLabel(value: unknown): string {
  return typeof value === 'string' ? DAY_FULL.format(new Date(value)) : String(value);
}
