/**
 * Bounding-box arithmetic for the city cuts.
 *
 * Two boxes per city, and conflating them is the bug this module exists to
 * prevent:
 *
 * - the **unpadded** bbox is the administrative one. It answers "is this
 *   locality inside its city" and "do two cities overlap enough for city
 *   assignment to be ambiguous".
 * - the **padded** bbox is what `osmium extract` cuts from. It has to reach
 *   well past the built-up area, because a listing or an office near the edge
 *   needs road network and POIs on every side of it.
 *
 * See DECISIONS.md D47 for what an unpadded cut actually broke.
 */
import type { CityBbox } from '../geo/schemas.js';

/**
 * How far past the administrative bbox the extract is cut, in kilometres.
 *
 * The search radius is 3 km and the POI radius 1.5 km, so 3-5 km would be the
 * arithmetic minimum. It is 9 because a **route** is not bounded by either: a
 * road from an office near the edge to a listing near the edge can legitimately
 * leave the box and come back, and a graph that ends mid-carriageway produces
 * either no route or an absurd detour. 9 km of extra ring costs a few MB of
 * extract per city.
 */
export const BBOX_PAD_KM = 9;

/** Mean metres per degree of latitude. Good to ~0.1% anywhere. */
const KM_PER_DEG_LAT = 110.574;
/** At the equator; scaled by cos(latitude) below. */
const KM_PER_DEG_LNG_AT_EQUATOR = 111.32;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Grows a bbox by `padKm` on every side.
 *
 * Longitude padding is computed at the latitude **furthest from the equator**,
 * where a degree of longitude is shortest — so the pad is at least `padKm`
 * everywhere in the box rather than only at its centre. Results are clamped to
 * valid WGS84 ranges; no seed city is anywhere near a pole or the antimeridian,
 * but a silently invalid box would fail much later inside osmium.
 */
export function padBbox(bbox: CityBbox, padKm: number = BBOX_PAD_KM): CityBbox {
  const latPad = padKm / KM_PER_DEG_LAT;

  const worstLat = Math.max(Math.abs(bbox.minLat), Math.abs(bbox.maxLat));
  const kmPerDegLng = KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(toRadians(worstLat));
  const lngPad = padKm / kmPerDegLng;

  const round = (value: number): number => Number(value.toFixed(4));

  return {
    minLng: round(Math.max(-180, bbox.minLng - lngPad)),
    minLat: round(Math.max(-90, bbox.minLat - latPad)),
    maxLng: round(Math.min(180, bbox.maxLng + lngPad)),
    maxLat: round(Math.min(90, bbox.maxLat + latPad)),
  };
}

/** The overlapping rectangle of two boxes, or null when they do not overlap. */
export function bboxIntersection(a: CityBbox, b: CityBbox): CityBbox | null {
  const minLng = Math.max(a.minLng, b.minLng);
  const maxLng = Math.min(a.maxLng, b.maxLng);
  const minLat = Math.max(a.minLat, b.minLat);
  const maxLat = Math.min(a.maxLat, b.maxLat);

  if (minLng >= maxLng || minLat >= maxLat) return null;
  return { minLng, minLat, maxLng, maxLat };
}

/** Rough area in square kilometres. Used to judge how bad an overlap is. */
export function bboxAreaSqKm(bbox: CityBbox): number {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const heightKm = (bbox.maxLat - bbox.minLat) * KM_PER_DEG_LAT;
  const widthKm =
    (bbox.maxLng - bbox.minLng) * KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(toRadians(midLat));

  return Math.max(0, heightKm) * Math.max(0, widthKm);
}

export function isInsideBbox(point: { lat: number; lng: number }, bbox: CityBbox): boolean {
  return (
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat &&
    point.lng >= bbox.minLng &&
    point.lng <= bbox.maxLng
  );
}

/**
 * The smallest box containing every input box.
 *
 * This is what "coverage" means as an outer bound: the union of the **padded**
 * boxes is the region the OSM artifacts were cut from, so it is the region
 * where a route, a POI lookup or a reverse geocode can be answered at all.
 * Outside it every geo service is guessing, which is why correction 9 makes it
 * an explicit state rather than an empty result.
 *
 * A rectangle rather than a true union of rectangles, deliberately: the three
 * seed cities are a thousand kilometres apart, so their true union is three
 * disjoint boxes and their bounding rectangle covers most of India. That is
 * fine for the ONE thing the rectangle is used for — the map's `maxBounds`,
 * which only has to stop someone panning to Europe. Membership is tested
 * per-box by `isInsideAnyBbox`, never against this rectangle.
 */
export function bboxUnion(boxes: readonly CityBbox[]): CityBbox {
  const first = boxes[0];
  if (!first) {
    throw new Error('bboxUnion needs at least one box');
  }

  return boxes.reduce<CityBbox>(
    (union, box) => ({
      minLng: Math.min(union.minLng, box.minLng),
      minLat: Math.min(union.minLat, box.minLat),
      maxLng: Math.max(union.maxLng, box.maxLng),
      maxLat: Math.max(union.maxLat, box.maxLat),
    }),
    first,
  );
}

/**
 * Whether a point is inside ANY of the boxes.
 *
 * The membership test for coverage, and the reason `bboxUnion` is not: a point
 * in the middle of the Deccan is inside the bounding rectangle of Patna,
 * Bengaluru and Pune and inside none of them. Getting this backwards would
 * declare most of the country covered and then fail every downstream call.
 */
export function isInsideAnyBbox(
  point: { lat: number; lng: number },
  boxes: readonly CityBbox[],
): boolean {
  return boxes.some((box) => isInsideBbox(point, box));
}
