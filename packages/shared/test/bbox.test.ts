import { describe, expect, it } from 'vitest';
import {
  BBOX_PAD_KM,
  bboxAreaSqKm,
  bboxIntersection,
  bboxUnion,
  isInsideAnyBbox,
  isInsideBbox,
  padBbox,
} from '../src/cities/bbox.js';

/**
 * The padding arithmetic, and the invariants that make two boxes per city safe
 * to keep. The live consequences — a route across a former cut edge, a POI
 * count near one — need real OSRM and Overpass, and live in
 * `apps/api/test/geo-boundary.test.ts`.
 */
const PATNA = { minLng: 84.95, minLat: 25.5, maxLng: 85.3, maxLat: 25.68 };
const BENGALURU = { minLng: 77.45, minLat: 12.82, maxLng: 77.78, maxLat: 13.14 };

/** Haversine, so the assertions are about kilometres rather than degrees. */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

describe('padBbox', () => {
  it('grows the box by at least the requested distance on every side', () => {
    const padded = padBbox(PATNA, BBOX_PAD_KM);
    const midLng = (PATNA.minLng + PATNA.maxLng) / 2;

    const sides = [
      distanceKm({ lat: PATNA.minLat, lng: midLng }, { lat: padded.minLat, lng: midLng }),
      distanceKm({ lat: PATNA.maxLat, lng: midLng }, { lat: padded.maxLat, lng: midLng }),
      // Longitude padding is computed at the latitude furthest from the
      // equator, where a degree is shortest — so it is at least the target
      // everywhere in the box, and a little over at the other edge.
      distanceKm(
        { lat: PATNA.maxLat, lng: PATNA.minLng },
        { lat: PATNA.maxLat, lng: padded.minLng },
      ),
      distanceKm(
        { lat: PATNA.maxLat, lng: PATNA.maxLng },
        { lat: PATNA.maxLat, lng: padded.maxLng },
      ),
    ];

    for (const side of sides) {
      expect(side).toBeGreaterThanOrEqual(BBOX_PAD_KM - 0.1);
      expect(side).toBeLessThan(BBOX_PAD_KM + 1.5);
    }
  });

  it('contains the unpadded box completely', () => {
    for (const bbox of [PATNA, BENGALURU]) {
      const padded = padBbox(bbox);
      expect(isInsideBbox({ lat: bbox.minLat, lng: bbox.minLng }, padded)).toBe(true);
      expect(isInsideBbox({ lat: bbox.maxLat, lng: bbox.maxLng }, padded)).toBe(true);
    }
  });

  it('admits a point a few kilometres outside the administrative edge', () => {
    // The case an unpadded cut broke: an office 4 km south of Patna's edge is
    // inside the extract but outside the city — which is exactly the state a
    // real office on a city's outskirts is in.
    const justOutside = { lat: PATNA.minLat - 0.036, lng: 85.1 };
    expect(isInsideBbox(justOutside, PATNA)).toBe(false);
    expect(isInsideBbox(justOutside, padBbox(PATNA))).toBe(true);
  });

  it('never produces an invalid box', () => {
    const nearPole = padBbox({ minLng: 179.9, minLat: 89.9, maxLng: 180, maxLat: 90 }, 50);
    expect(nearPole.maxLat).toBeLessThanOrEqual(90);
    expect(nearPole.maxLng).toBeLessThanOrEqual(180);
  });
});

describe('bboxIntersection', () => {
  it('is null for boxes that do not touch, padding included', () => {
    expect(bboxIntersection(padBbox(PATNA), padBbox(BENGALURU))).toBeNull();
  });

  it('reports the overlapping rectangle when they do', () => {
    const shifted = { minLng: 85.0, minLat: 25.55, maxLng: 85.5, maxLat: 25.9 };
    const overlap = bboxIntersection(PATNA, shifted);

    expect(overlap).not.toBeNull();
    expect(overlap ? bboxAreaSqKm(overlap) : 0).toBeGreaterThan(100);
  });
});

describe('bboxUnion and isInsideAnyBbox', () => {
  it('encloses every input box', () => {
    const union = bboxUnion([PATNA, BENGALURU]);

    for (const box of [PATNA, BENGALURU]) {
      expect(union.minLng).toBeLessThanOrEqual(box.minLng);
      expect(union.minLat).toBeLessThanOrEqual(box.minLat);
      expect(union.maxLng).toBeGreaterThanOrEqual(box.maxLng);
      expect(union.maxLat).toBeGreaterThanOrEqual(box.maxLat);
    }
  });

  it('is a RECTANGLE, so membership must not be tested against it', () => {
    // The bug this pair of functions exists to prevent. Nagpur is inside the
    // rectangle enclosing Patna and Bengaluru and inside neither city, so a
    // coverage check written against `bboxUnion` would declare most of central
    // India covered and then fail every route, POI and geocode from it.
    const nagpur = { lat: 21.1458, lng: 79.0882 };

    expect(isInsideBbox(nagpur, bboxUnion([PATNA, BENGALURU]))).toBe(true);
    expect(isInsideAnyBbox(nagpur, [PATNA, BENGALURU])).toBe(false);
  });

  it('admits a point inside any one of the boxes', () => {
    const koramangala = { lat: 12.9352, lng: 77.6245 };

    expect(isInsideAnyBbox(koramangala, [PATNA, BENGALURU])).toBe(true);
    expect(isInsideAnyBbox(koramangala, [PATNA])).toBe(false);
  });

  it('admits nothing when there are no boxes', () => {
    expect(isInsideAnyBbox({ lat: 25.6, lng: 85.1 }, [])).toBe(false);
    expect(() => bboxUnion([])).toThrow(/at least one box/);
  });
});
