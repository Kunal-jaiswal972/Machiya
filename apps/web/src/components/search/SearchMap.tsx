import { RING_RADII_METERS, type ListingCard } from '@machiya/shared';
import { bbox as turfBbox, circle } from '@turf/turf';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';

import type { MapRef } from 'react-map-gl/maplibre';
import Map, {
  AttributionControl,
  Layer,
  Marker,
  NavigationControl,
  ScaleControl,
  Source,
  type MapLayerMouseEvent,
} from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../lib/maplibre-setup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { env } from '../../env';
import { useMapPalette } from '../../hooks/use-map-palette';
import { formatRupeesCompact } from '../../lib/format';
import { useDetailOverlay } from '../../stores/detail-overlay';
import { useSearchUi } from '../../stores/search-ui';

/**
 * The map. Everything in docs/design.md's "motion discipline" applies here:
 *
 *  - the CAMERA is animated with the map's own `easeTo`, never by driving
 *    view state from React;
 *  - LAYER properties are animated with `requestAnimationFrame` writing
 *    straight through `setPaintProperty`, never from React state;
 *  - hover is a maplibre **feature-state**, so highlighting a marker is a GPU
 *    paint rather than a re-render of the source.
 *
 * Driving any of these from React at frame rate re-renders the tree sixty times
 * a second and drops frames, and the map fights back.
 */
export interface SearchMapProps {
  office: { lat: number; lng: number } | null;
  radiusMeters: number;
  listings: ListingCard[];
  /** Fit the view to this city's bounds when there is no office yet. */
  initialBounds?: [number, number, number, number] | undefined;
  onPickOffice: (point: { lat: number; lng: number }) => void;
  onSelectListing: (listing: ListingCard) => void;
}

const RINGS_SOURCE = 'machiya-rings';
const ROUTE_SOURCE = 'machiya-route';
const POI_SOURCE = 'machiya-pois';
const LISTINGS_SOURCE = 'machiya-listings';
const RING_LAYERS = ['ring-3-fill', 'ring-2-fill', 'ring-1-fill'] as const;
const RING_LINE_LAYERS = ['ring-3-line', 'ring-2-line', 'ring-1-line'] as const;

/** Fill opacity each ring settles at. Quieter outward, like the gauge. */
const RING_FILL_OPACITY = [0.05, 0.07, 0.1];

function ringsFeatureCollection(
  office: { lat: number; lng: number },
  radiusMeters: number,
): FeatureCollection<Polygon> {
  // The radius filter can be tighter than 3 km, so the rings drawn are the ones
  // inside it — showing a 3 km ring for a 1 km search would be a lie.
  const radii = RING_RADII_METERS.filter((radius) => radius <= radiusMeters);
  const effective = radii.length > 0 ? radii : [radiusMeters];

  return {
    type: 'FeatureCollection',
    features: effective.map((radius, index): Feature<Polygon> => ({
      type: 'Feature',
      // 64 steps is smooth at every zoom the product uses and keeps the
      // geometry small enough to re-generate on a pin drag.
      geometry: circle([office.lng, office.lat], radius / 1000, { steps: 64, units: 'kilometers' })
        .geometry,
      properties: { ring: index + 1, radius },
    })),
  };
}

function listingsFeatureCollection(listings: ListingCard[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: listings.map((listing): Feature<Point> => ({
      type: 'Feature',
      id: listing.id,
      geometry: { type: 'Point', coordinates: [listing.lng, listing.lat] },
      properties: {
        id: listing.id,
        slug: listing.slug,
        price: formatRupeesCompact(
          listing.listingType === 'RENT' ? listing.rentAmount : listing.salePrice,
        ),
        ring: listing.ring,
      },
    })),
  };
}

export function SearchMap({
  office,
  radiusMeters,
  listings,
  initialBounds,
  onPickOffice,
  onSelectListing,
}: SearchMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);
  const palette = useMapPalette();
  const hoveredId = useSearchUi((state) => state.hoveredId);
  const setHoveredId = useSearchUi((state) => state.setHoveredId);
  const lastHovered = useRef<string | null>(null);
  const ringAnimation = useRef<number | null>(null);
  const routeAnimation = useRef<number | null>(null);
  const everLoaded = useRef(false);

  // The detail panel is a child route rendered through an Outlet, so what it
  // wants drawn arrives through a store rather than props. See
  // stores/detail-overlay.ts.
  const routeGeometry = useDetailOverlay((state) => state.routeGeometry);
  const pois = useDetailOverlay((state) => state.pois);
  const visibleCategories = useDetailOverlay((state) => state.visibleCategories);

  const rings = useMemo(
    () => (office ? ringsFeatureCollection(office, radiusMeters) : null),
    [office, radiusMeters],
  );
  const points = useMemo(() => listingsFeatureCollection(listings), [listings]);

  const routeLine = useMemo<FeatureCollection<LineString> | null>(() => {
    if (!routeGeometry) return null;
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: routeGeometry, properties: {} }],
    };
  }, [routeGeometry]);

  const poiPoints = useMemo<FeatureCollection<Point>>(
    () => ({
      type: 'FeatureCollection',
      features: pois
        .filter((poi) => visibleCategories.has(poi.category))
        .map((poi) => ({
          type: 'Feature' as const,
          id: poi.id,
          geometry: { type: 'Point' as const, coordinates: [poi.lng, poi.lat] },
          // The colour rides on the FEATURE rather than a `match` expression in
          // the paint spec. Two reasons: the tokens are CSS variables maplibre
          // cannot parse, so they have to be resolved on the client anyway, and
          // a data-driven `['get', 'color']` stays one layer for seven
          // categories instead of seven layers being added and removed.
          properties: {
            category: poi.category,
            name: poi.name ?? '',
            color: palette.poi[poi.category],
          },
        })),
    }),
    [pois, visibleCategories, palette.poi],
  );

  // --- camera: the map's own easing, never React view state -----------------
  // Read out as a primitive, deliberately: `office` is a fresh object on every
  // render (it is derived from the URL), so depending on the object would move
  // the camera on every keystroke in the filter bar.
  const officeLat = office?.lat;

  useEffect(() => {
    const map = mapRef.current?.getMap();
    // `styleReady` is in the deps for a reason: on first mount this effect runs
    // before the map instance exists, so without it the camera never moves and
    // the map sits on its initial city while the results are somewhere else.
    if (!map || !styleReady || !rings) return;

    // Fit to the OUTER RING's bounds rather than nudging the zoom. A
    // `Math.max(getZoom(), n)` approach depends on whatever zoom the map
    // happens to be at, which made the same URL open at two different scales
    // depending on how the style loaded. The ring bbox is deterministic: the
    // search area fills the viewport, every time, at any radius.
    const [minLng, minLat, maxLng, maxLat] = turfBbox(rings) as [number, number, number, number];

    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 56, duration: 600, maxZoom: 16, essential: true },
    );
  }, [rings, styleReady]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !styleReady || officeLat !== undefined || !initialBounds) return;

    map.fitBounds(initialBounds, { padding: 48, duration: 0 });
  }, [initialBounds, officeLat, styleReady]);

  // --- rings draw outward in sequence ---------------------------------------
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !styleReady || !rings) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      // The fallback is an instant state change, not a shorter animation.
      RING_LAYERS.forEach((layer, index) => {
        if (map.getLayer(layer)) {
          map.setPaintProperty(layer, 'fill-opacity', RING_FILL_OPACITY[index] ?? 0.08);
        }
      });
      RING_LINE_LAYERS.forEach((layer) => {
        if (map.getLayer(layer)) map.setPaintProperty(layer, 'line-opacity', 0.5);
      });
      return;
    }

    // 1 km, then 2 km, then 3 km — 90ms apart, so the structure is legible
    // rather than three circles appearing at once. rAF writing straight through
    // setPaintProperty: no React state is involved at any point.
    const start = performance.now();
    const stagger = 90;
    const duration = 420;

    const step = (now: number): void => {
      let done = true;

      RING_LAYERS.forEach((layer, index) => {
        // RING_LAYERS is outermost-first for paint order; the sequence runs
        // inside-out, so the delay is reversed.
        const order = RING_LAYERS.length - 1 - index;
        const progress = Math.min(1, Math.max(0, (now - start - order * stagger) / duration));
        if (progress < 1) done = false;

        const eased = 1 - (1 - progress) ** 3;
        if (map.getLayer(layer)) {
          map.setPaintProperty(layer, 'fill-opacity', eased * (RING_FILL_OPACITY[index] ?? 0.08));
        }
        const line = RING_LINE_LAYERS[index];
        if (line && map.getLayer(line)) {
          map.setPaintProperty(line, 'line-opacity', eased * 0.5);
        }
      });

      if (!done) ringAnimation.current = requestAnimationFrame(step);
    };

    ringAnimation.current = requestAnimationFrame(step);

    return () => {
      if (ringAnimation.current !== null) cancelAnimationFrame(ringAnimation.current);
    };
  }, [rings, styleReady]);

  // --- hover sync: feature-state, not a re-render ----------------------------
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !styleReady || !map.getSource(LISTINGS_SOURCE)) return;

    if (lastHovered.current && lastHovered.current !== hoveredId) {
      map.setFeatureState({ source: LISTINGS_SOURCE, id: lastHovered.current }, { hover: false });
    }

    if (hoveredId) {
      map.setFeatureState({ source: LISTINGS_SOURCE, id: hoveredId }, { hover: true });
    }

    lastHovered.current = hoveredId;
  }, [hoveredId, styleReady, points]);

  // --- the route draws from office to listing --------------------------------
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !styleReady || !routeLine || !map.getLayer('route-line')) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      map.setPaintProperty('route-line', 'line-dasharray', [1, 0]);
      return;
    }

    // Drawn with a stroke-dashoffset-style trick: the dash pattern starts as
    // one long gap and closes up, so the line appears to travel from the office
    // to the listing. Direction is information — it is YOUR commute, one way —
    // and this is written through setPaintProperty from rAF rather than from
    // React state, per the motion discipline in docs/design.md.
    const start = performance.now();
    const duration = 700;

    const step = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;

      // A 400-unit pattern: the drawn part grows and the gap shrinks.
      map.setPaintProperty('route-line', 'line-dasharray', [
        Math.max(0.01, eased * 400),
        Math.max(0.01, (1 - eased) * 400),
      ]);

      if (progress < 1) routeAnimation.current = requestAnimationFrame(step);
    };

    routeAnimation.current = requestAnimationFrame(step);

    return () => {
      if (routeAnimation.current !== null) cancelAnimationFrame(routeAnimation.current);
    };
  }, [routeLine, styleReady]);

  const onClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];

      if (feature?.layer.id === 'listing-marker') {
        const id = feature.properties?.id as string | undefined;
        const listing = listings.find((candidate) => candidate.id === id);
        if (listing) onSelectListing(listing);
        return;
      }

      if (feature?.layer.id === 'cluster-circle') {
        // Zoom into a cluster rather than expanding it in place: an expanded
        // cluster at low zoom overlaps its neighbours immediately.
        const map = mapRef.current?.getMap();
        map?.easeTo({ center: event.lngLat, zoom: map.getZoom() + 2, duration: 400 });
        return;
      }

      // A click on the map itself moves the office. This is the second of the
      // three ways to set one, alongside the field and dragging the pin.
      onPickOffice({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    },
    [listings, onPickOffice, onSelectListing],
  );

  if (styleError) {
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-paper-sunken p-6 text-center"
      >
        <p className="text-title">The map could not load</p>
        <p className="max-w-md text-sm text-ink-soft">
          Tiles come from {env.VITE_MAP_STYLE_URL}. Check the network, or point VITE_MAP_STYLE_URL
          at a self-hosted style. Every listing is still available in the list view.
        </p>
      </div>
    );
  }

  return (
    <div className="map-frame h-full w-full">
      {/* aria-hidden with the markers exposed through the result list instead:
          a map is not navigable by keyboard, so the keyboard path does not go
          through it. See docs/design.md. */}
      <div aria-hidden className="h-full w-full">
        <Map
          ref={mapRef}
          initialViewState={{ longitude: 85.1376, latitude: 25.5941, zoom: 12 }}
          mapStyle={env.VITE_MAP_STYLE_URL}
          style={{ width: '100%', height: '100%' }}
          attributionControl={false}
          interactiveLayerIds={['listing-marker', 'cluster-circle']}
          cursor="crosshair"
          onLoad={() => {
            everLoaded.current = true;
            setStyleReady(true);
          }}
          onClick={onClick}
          onMouseMove={(event) => {
            const id = event.features?.[0]?.properties?.id as string | undefined;
            if (id !== undefined && id !== hoveredId) setHoveredId(id);
          }}
          onMouseOut={() => setHoveredId(null)}
          onError={(event) => {
            const error = event.error as (Error & { status?: number }) | undefined;
            const message = error?.message ?? 'unknown map error';

            // An ABORTED request is not a failure. React's StrictMode mounts
            // this component twice in development, so the first mount's
            // TileJSON fetch is cancelled — and treating that as fatal put an
            // error panel over a map that was about to work perfectly.
            if (error?.name === 'AbortError' || /abort/i.test(message)) return;

            // Only a failure BEFORE the style loaded is fatal. After that, a
            // maplibre error is a single tile that 404'd or a font missing from
            // the style — replacing a working map with an error panel because
            // one tile failed is a worse bug than the missing tile.
            if (everLoaded.current) {
              console.warn('[map]', message);
              return;
            }

            // Deferred out of the render phase on purpose: maplibre fires
            // `error` synchronously while react-map-gl is committing a Layer,
            // so setting state straight from here is a render-phase update to a
            // different component.
            queueMicrotask(() => setStyleError(message));
          }}
        >
          {rings ? (
            <Source id={RINGS_SOURCE} type="geojson" data={rings}>
              {/* Outermost first so the inner rings paint on top. Opacity starts
                  at 0 and the rAF sequence above brings each one in. */}
              <Layer
                id="ring-3-fill"
                type="fill"
                filter={['==', ['get', 'ring'], 3]}
                paint={{ 'fill-color': palette.ring3, 'fill-opacity': 0 }}
              />
              <Layer
                id="ring-2-fill"
                type="fill"
                filter={['==', ['get', 'ring'], 2]}
                paint={{ 'fill-color': palette.ring2, 'fill-opacity': 0 }}
              />
              <Layer
                id="ring-1-fill"
                type="fill"
                filter={['==', ['get', 'ring'], 1]}
                paint={{ 'fill-color': palette.ring1, 'fill-opacity': 0 }}
              />
              <Layer
                id="ring-3-line"
                type="line"
                filter={['==', ['get', 'ring'], 3]}
                paint={{ 'line-color': palette.ring3, 'line-width': 1, 'line-opacity': 0 }}
              />
              <Layer
                id="ring-2-line"
                type="line"
                filter={['==', ['get', 'ring'], 2]}
                paint={{ 'line-color': palette.ring2, 'line-width': 1, 'line-opacity': 0 }}
              />
              <Layer
                id="ring-1-line"
                type="line"
                filter={['==', ['get', 'ring'], 1]}
                paint={{ 'line-color': palette.ring1, 'line-width': 1.5, 'line-opacity': 0 }}
              />
            </Source>
          ) : null}

          {/* Native maplibre clustering, so 120 points stay one draw call.
              promoteId is what makes feature-state hover possible. */}
          <Source
            id={LISTINGS_SOURCE}
            type="geojson"
            data={points}
            cluster
            clusterRadius={44}
            clusterMaxZoom={13}
            promoteId="id"
          >
            <Layer
              id="cluster-circle"
              type="circle"
              filter={['has', 'point_count']}
              paint={{
                'circle-color': palette.markerBg,
                'circle-stroke-color': palette.markerEdge,
                'circle-stroke-width': 1.5,
                'circle-radius': ['step', ['get', 'point_count'], 15, 5, 19, 15, 24],
              }}
            />
            <Layer
              id="cluster-count"
              type="symbol"
              filter={['has', 'point_count']}
              layout={{
                'text-field': ['get', 'point_count_abbreviated'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 12,
              }}
              paint={{ 'text-color': palette.markerFg }}
            />
            <Layer
              id="listing-marker"
              type="circle"
              filter={['!', ['has', 'point_count']]}
              paint={{
                'circle-color': palette.markerPriceBg,
                'circle-stroke-color': palette.markerEdge,
                // The hover lift the list card shares. A feature-state
                // expression, so hovering costs a paint and nothing else.
                'circle-stroke-width': [
                  'case',
                  ['boolean', ['feature-state', 'hover'], false],
                  3,
                  1.5,
                ],
                'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 11, 8],
              }}
            />
            <Layer
              id="listing-price"
              type="symbol"
              filter={['!', ['has', 'point_count']]}
              layout={{
                'text-field': ['get', 'price'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 11,
                'text-offset': [0, -1.4],
                'text-allow-overlap': false,
              }}
              paint={{
                'text-color': palette.markerFg,
                'text-halo-color': palette.markerBg,
                'text-halo-width': 1.4,
              }}
            />
          </Source>

          {routeLine ? (
            <Source id={ROUTE_SOURCE} type="geojson" data={routeLine}>
              {/* A casing under the line, so it stays readable over a yellow
                  arterial road — the map's own colour for a motorway. */}
              <Layer
                id="route-casing"
                type="line"
                paint={{
                  'line-color': palette.markerBg,
                  'line-width': 7,
                  'line-opacity': 0.85,
                }}
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              />
              <Layer
                id="route-line"
                type="line"
                paint={{
                  'line-color': palette.route,
                  'line-width': 3.5,
                  'line-dasharray': [0.01, 400],
                }}
                layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
              />
            </Source>
          ) : null}

          {poiPoints.features.length > 0 ? (
            <Source id={POI_SOURCE} type="geojson" data={poiPoints}>
              {/* One layer, coloured by category through a match expression, so
                  toggling a category is a source update rather than seven
                  layers being added and removed. */}
              <Layer
                id="poi-dot"
                type="circle"
                paint={{
                  'circle-radius': 5,
                  'circle-stroke-width': 1.5,
                  'circle-stroke-color': palette.markerBg,
                  'circle-color': ['get', 'color'],
                }}
              />
              <Layer
                id="poi-label"
                type="symbol"
                minzoom={14}
                layout={{
                  'text-field': ['get', 'name'],
                  'text-font': ['Noto Sans Regular'],
                  'text-size': 10,
                  'text-offset': [0, 1],
                  'text-anchor': 'top',
                  'text-allow-overlap': false,
                }}
                paint={{
                  'text-color': palette.markerFg,
                  'text-halo-color': palette.markerBg,
                  'text-halo-width': 1.2,
                }}
              />
            </Source>
          ) : null}

          {office ? (
            <Marker
              longitude={office.lng}
              latitude={office.lat}
              draggable
              anchor="center"
              onDragEnd={(event) => {
                onPickOffice({ lat: event.lngLat.lat, lng: event.lngLat.lng });
              }}
            >
              {/* Round, because it is a map-native object — the one shape the
                  radius scale reserves for them. */}
              <span className="block size-4 cursor-grab rounded-round border-2 border-white bg-water shadow-[0_0_0_4px_var(--color-water-soft)] active:cursor-grabbing" />
            </Marker>
          ) : null}

          <NavigationControl position="top-right" showCompass={false} />
          <ScaleControl position="bottom-left" unit="metric" />
          <AttributionControl position="bottom-right" compact />
        </Map>
      </div>
    </div>
  );
}
