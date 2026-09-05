/**
 * Every number the user sees is formatted here.
 *
 * Two rules that matter for a product whose argument is arithmetic:
 *  - **Indian digit grouping.** ₹1,25,000 not ₹125,000. `en-IN` does it, and
 *    getting it wrong makes every price look foreign.
 *  - **No decimals on rupees.** Prices are whole rupees in the database (D17),
 *    and "₹14,000.00" reads like a bank statement, not a rent.
 */

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const compactRupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const plainNumber = new Intl.NumberFormat('en-IN');

export function formatRupees(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return rupees.format(amount);
}

/**
 * For a map marker, where there is room for six characters and no more.
 * ₹1.2L, not ₹1,25,000 — a sale price at full width covers the pin beside it.
 */
export function formatRupeesCompact(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return compactRupees.format(amount);
}

export function formatNumber(value: number): string {
  return plainNumber.format(value);
}

/**
 * Distance, with the precision the number deserves.
 *
 * Under a kilometre, metres rounded to 10 — "480 m" is useful, "483 m" implies
 * a survey. Over it, one decimal.
 */
export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '—';
  if (meters < 1000) return `${String(Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Duration, as a commute is actually spoken: "38 min", "1 h 12 m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} m`;
}

/**
 * An em dash, for a value a DRAFT listing has not been given yet.
 *
 * These three take nullable input because a listing genuinely has none of them
 * until the wizard's later steps (D67), and the alternative is `??` at every
 * call site — where one omission renders the word "null" to a user.
 */
export const UNKNOWN_VALUE = '—';

export function formatArea(sqft: number | null | undefined): string {
  if (sqft == null) return UNKNOWN_VALUE;
  return `${plainNumber.format(sqft)} sq ft`;
}

/** "2 BHK", and "Studio" when that is what one bedroom with no wall means. */
export function formatBedrooms(
  bedrooms: number | null | undefined,
  propertyType: string | null | undefined,
): string {
  if (propertyType === 'STUDIO') return 'Studio';
  if (bedrooms == null) return UNKNOWN_VALUE;
  if (propertyType === 'PG') return `PG · ${String(bedrooms)} bed`;
  return `${String(bedrooms)} BHK`;
}

const TITLE_CASE_EXCEPTIONS = new Set(['PG']);

/** APARTMENT → Apartment, BUILDER_FLOOR → Builder floor, PG → PG. */
export function humanizeEnum(value: string | null | undefined): string {
  if (value == null || value === '') return UNKNOWN_VALUE;
  if (TITLE_CASE_EXCEPTIONS.has(value)) return value;
  const spaced = value.toLowerCase().replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "Available now" reads better than a date in the past. */
export function formatAvailability(from: string | Date | null | undefined): string {
  if (!from) return 'Available now';
  const date = typeof from === 'string' ? new Date(from) : from;
  if (Number.isNaN(date.getTime())) return 'Available now';
  if (date.getTime() <= Date.now()) return 'Available now';
  return `From ${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Relative time for enquiry threads and view charts. */
export function formatRelative(when: string | Date): string {
  const date = typeof when === 'string' ? new Date(when) : when;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${String(days)} d ago`;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
