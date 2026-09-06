import { RING_RADII_METERS, type ListingCard, type Poi } from '@machiya/shared';
import { bbox as turfBbox, circle } from '@turf/turf';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapRef } from 'react-map-gl/maplibre';
import Map, {
  AttributionControl,
  Layer,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  Source,
  type MapLayerMouseEvent,
} from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../lib/maplibre-setup';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Moon, Sun, X } from 'lucide-react';
import { useMapPalette } from '../../hooks/use-map-palette';
import { useMapStyle } from '../../hooks/use-map-style';
import { registerPoiIcons } from '../../lib/poi-sprites';
import { formatDistance, formatRupeesCompact } from '../../lib/format';
import { POI_META } from '../listing/poi-meta';
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
  /**
   * The hard pan limit: the bounding rectangle of every covered city's padded
   * bbox, from `/api/coverage`.
   *
   * The cheapest fix in correction 9 and the one that prevents most of the
   * confusion before any message is needed — panning to a city the product does
   * not serve is simply never offered. Derived from the manifest server-side, so
   * a fourth city widens it with nothing to change here.
   */
  maxBounds?: [number, number, number, number] | undefined;
  onPickOffice: (point: { lat: number; lng: number }) => void;
  onSelectListing: (listing: ListingCard) => void;
  /** Set only while the detail panel is open; a bare map press then closes it. */
  onDismissDetail?: (() => void) | undefined;
}

const RINGS_SOURCE = 'machiya-rings';
const ROUTE_SOURCE = 'machiya-route';
declare global {
  interface Window {
    /** Set in development only; see the `onLoad` handler below. */
    __machiyaMap?: MapLibreMap;
  }
}

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
  maxBounds,
  onPickOffice,
  onSelectListing,
  onDismissDetail,
}: SearchMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);
  const palette = useMapPalette();
  const mapStyle = useMapStyle();

  /**
   * Where a click landed, waiting to be confirmed as the office.
   *
   * Click-then-confirm rather than click-to-move: the gesture that used to
   * destroy the search is now the gesture that offers to change it, and the
   * offer is dismissible (D77).
   */
  const [pendingOffice, setPendingOffice] = useState<{ lat: number; lng: number } | null>(null);

  /** The POI whose bubble is open. Cleared when the panel or the listing goes. */
  const [selectedPoi, setSelectedPoi] = useState<Poi | null>(null);

  useEffect(() => {
    if (!pendingOffice) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPendingOffice(null);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingOffice]);

  // A confirmation anchored to a point the office has since left is a
  // confirmation for a question nobody asked any more.
  useEffect(() => {
    setPendingOffice(null);
  }, [office?.lat, office?.lng]);
  const hoveredId = useSearchUi((state) => state.hoveredId);
  const setHoveredId = useSearchUi((state) => state.setHoveredId);
  const lastHovered = useRef<string | null>(null);
  const everLoaded = useRef(false);

  // The detail panel is a child route rendered through an Outlet, so what it
  // wants drawn arrives through a store rather than props. See
  // stores/detail-overlay.ts.
  const routeGeometry = useDetailOverlay((state) => state.routeGeometry);
  const pois = useDetailOverlay((state) => state.pois);
  const visibleCategories = useDetailOverlay((state) => state.visibleCategories);

  // Switching styles is a full teardown inside maplibre: every layer this
  // component adds is removed and re-added by react-map-gl when the new style
  // loads. The paint effects key off `styleReady`, so it goes false the moment
  // the URL changes and true again on `styledata`.
  useEffect(() => {
    setStyleReady(false);
  }, [mapStyle.url]);

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
            // Also in `properties`, not only as the feature id: a click event
            // hands back the properties, and the id alone cannot be read from
            // them — which is why the bubble opened on nothing.
            id: poi.id,
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

  // Applied imperatively rather than as a `<Map maxBounds>` prop, for the same
  // reason the camera is: the value arrives from an async fetch, and handing a
  // changing bounds prop to react-map-gl re-derives view state on a component
  // that is otherwise camera-authoritative. Setting it once, when it lands,
  // keeps one owner of the camera.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !styleReady || !maxBounds) return;

    const [minLng, minLat, maxLng, maxLat] = maxBounds;
    map.setMaxBounds([
      [minLng, minLat],
      [maxLng, maxLat],
    ]);
  }, [maxBounds, styleReady]);

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

      if (!done) frame = requestAnimationFrame(step);
    };

    let frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
  }, [rings, styleReady]);

  useEffect(() => {
    setSelectedPoi((current) =>
      current &&
      pois.some((poi) => poi.id === current.id) &&
      visibleCategories.has(current.category)
        ? current
        : null,
    );
  }, [pois, visibleCategories]);

  // --- POI markers carry the sidebar's icons ---------------------------------
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !styleReady) return;

    // Re-registered when the palette moves: a theme change repaints the markers
    // rather than leaving the previous theme's colours until the next listing.
    //
    // Deferred a frame because building the glyphs renders the panel's own icon
    // components, and React refuses a synchronous render from inside a commit.
    const frame = requestAnimationFrame(() => {
      void registerPoiIcons(map, palette.poi, palette.markerBg);
    });

    return () => cancelAnimationFrame(frame);
  }, [styleReady, palette]);

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
      // Re-checked every frame, not only before the first one. A style reload
      // drops every layer while React still believes the route is mounted, and
      // the loop then paints a layer that is gone (docs/ux-audit.md 1.6).
      if (!map.getLayer('route-line')) return;

      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;

      // A 400-unit pattern: the drawn part grows and the gap shrinks.
      map.setPaintProperty('route-line', 'line-dasharray', [
        Math.max(0.01, eased * 400),
        Math.max(0.01, (1 - eased) * 400),
      ]);

      if (progress < 1) frame = requestAnimationFrame(step);
    };

    let frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
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

      if (feature?.layer.id === 'poi-dot') {
        const id = feature.properties?.id as string | undefined;
        setSelectedPoi(pois.find((poi) => poi.id === id) ?? null);
        return;
      }

      if (feature?.layer.id === 'cluster-circle') {
        // Zoom into a cluster rather than expanding it in place: an expanded
        // cluster at low zoom overlaps its neighbours immediately.
        const map = mapRef.current?.getMap();
        map?.easeTo({ center: event.lngLat, zoom: map.getZoom() + 2, duration: 400 });
        return;
      }

      // With a listing open, the map is the outside of the panel, so pressing
      // it dismisses — the desktop half of docs/ux-audit.md 1.8, and the reason
      // the desktop panel needs no scrim of its own.
      if (onDismissDetail) {
        onDismissDetail();
        return;
      }

      // A bare click does NOT move the office — it offers to.
      //
      // It used to move it outright, which meant one stray click silently
      // re-anchored every distance, ring and commute figure on screen, ~2.4km
      // away in the measured case, with no confirmation and no undo
      // (docs/ux-audit.md 1.5). Setting the office is a deliberate act; a click
      // on a map is not. See DECISIONS.md D77.
      setPendingOffice({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    },
    [listings, onSelectListing, onDismissDetail, pois],
  );

  if (styleError) {
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-paper-sunken p-6 text-center"
      >
        <p className="text-title">The map could not load</p>
        <p className="max-w-md text-sm text-ink-soft">
          The map could not be reached. Every listing is still in the list beside it, with the same
          distances and the same costs.
        </p>
      </div>
    );
  }

  return (
    <div className="map-frame h-full w-full">
      {/* aria-hidden with the markers exposed through the result list instead:
          a map is not navigable by keyboard, so the keyboard path does not go
          through it. See docs/design.md. */}
      {/* Top-LEFT: the detail panel occupies the right edge, and a control the
          panel covers is a control nobody can reach with a listing open.
          Outside the map's own wrapper, because this one IS for everybody: a
          button, labelled, in the tab order. */}
      <button
        type="button"
        onClick={mapStyle.toggle}
        title={mapStyle.isDark ? 'Switch the map to light' : 'Switch the map to dark'}
        className="chrome absolute top-2 left-2 z-10 grid size-8 place-items-center text-ink-soft hover:text-ink"
      >
        {mapStyle.isDark ? (
          <Sun className="size-4" aria-hidden />
        ) : (
          <Moon className="size-4" aria-hidden />
        )}
        <span className="sr-only">
          {mapStyle.isDark ? 'Switch the map to light' : 'Switch the map to dark'}
        </span>
      </button>

      <div aria-hidden className="h-full w-full">
        <Map
          ref={mapRef}
          initialViewState={{ longitude: 85.1376, latitude: 25.5941, zoom: 12 }}
          mapStyle={mapStyle.url}
          style={{ width: '100%', height: '100%' }}
          attributionControl={false}
          // Lets a test read the rendered map back as pixels — without it the
          // drawing buffer is cleared before anything can sample it, and a
          // contrast check against the basemap is not possible. Dev only: it
          // costs a copy per frame.
          canvasContextAttributes={{ preserveDrawingBuffer: import.meta.env.DEV }}
          interactiveLayerIds={['listing-marker', 'cluster-circle', 'poi-dot']}
          cursor="crosshair"
          onLoad={(event) => {
            everLoaded.current = true;
            setStyleReady(true);

            // A handle for the browser tests, which need to project a
            // coordinate to a pixel before they can click a marker. Dev builds
            // only — `import.meta.env.DEV` is statically false in a production
            // build, so this and the property go with it.
            if (import.meta.env.DEV) window.__machiyaMap = event.target;
          }}
          onStyleData={() => setStyleReady(true)}
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
              {/* One layer for all seven, picking its image from the feature,
                  so toggling a category is a source update rather than seven
                  layers being added and removed. The images are the sidebar's
                  own icons — see lib/poi-sprites.ts. */}
              <Layer
                id="poi-dot"
                type="symbol"
                layout={{
                  'icon-image': ['concat', 'poi-', ['get', 'category']],
                  'icon-size': 0.62,
                  'icon-allow-overlap': true,
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

          {selectedPoi ? (
            <Popup
              longitude={selectedPoi.lng}
              latitude={selectedPoi.lat}
              anchor="bottom"
              offset={14}
              closeButton={false}
              onClose={() => setSelectedPoi(null)}
              className="machiya-popup"
            >
              <div className="flex items-start gap-2 p-0.5">
                <span
                  className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-round"
                  style={{ backgroundColor: palette.poi[selectedPoi.category] }}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {selectedPoi.name ?? POI_META[selectedPoi.category].label}
                  </p>
                  <p className="text-data text-ink-faint">
                    {POI_META[selectedPoi.category].label} ·{' '}
                    {formatDistance(selectedPoi.distanceMeters)} from this listing
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPoi(null)}
                  className="ml-1 rounded-inset p-0.5 text-ink-faint hover:text-ink"
                >
                  <X className="size-3.5" aria-hidden />
                  <span className="sr-only">Close</span>
                </button>
              </div>
            </Popup>
          ) : null}

          {pendingOffice ? (
            <Marker
              longitude={pendingOffice.lng}
              latitude={pendingOffice.lat}
              anchor="bottom"
              // Otherwise the click that lands on this bubble reaches the map
              // underneath it and moves the pending point out from under itself.
              onClick={(event) => {
                event.originalEvent.stopPropagation();
              }}
            >
              <div
                className="chrome-over flex items-center gap-1 p-1"
                role="dialog"
                aria-label="Set your office here?"
              >
                <button
                  type="button"
                  autoFocus
                  className="text-label rounded-inset bg-water px-2 py-1 text-white"
                  onClick={() => {
                    onPickOffice(pendingOffice);
                    setPendingOffice(null);
                  }}
                >
                  Set office here
                </button>
                <button
                  type="button"
                  aria-label="Leave the office where it is"
                  className="text-label rounded-inset px-1.5 py-1 text-ink-soft hover:bg-paper-sunken"
                  onClick={() => {
                    setPendingOffice(null);
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            </Marker>
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
                  radius scale reserves for them.

                  Bigger than the 16px dot it was, with a grab cursor and a
                  title: dragging was already the safe way to move the office
                  and was the one nobody could see, while the discoverable
                  gesture was the destructive one (D77). */}
              <span
                title="Drag to move your office"
                aria-label="Your office — drag to move it"
                role="img"
                className="block size-6 cursor-grab rounded-round border-2 border-white bg-water shadow-[0_0_0_5px_var(--color-water-soft)] transition-transform hover:scale-110 active:cursor-grabbing active:scale-95"
              />
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
