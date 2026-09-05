import { useCallback, useEffect, useRef } from 'react';
import Map, {
  AttributionControl,
  Marker,
  NavigationControl,
  type MapLayerMouseEvent,
  type MapRef,
} from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../lib/maplibre-setup';
import { env } from '../../env';

/**
 * The wizard's map: one draggable pin, no rings, no listings.
 *
 * Deliberately not `SearchMap` with props switched off. That component owns
 * ring geometry, a marker source, hover feature-state and a detail overlay
 * store, none of which this needs — and threading a "wizard mode" through it
 * would put two unrelated jobs in one 400-line file.
 *
 * The camera is moved with the map's own `easeTo`, never by driving view state
 * from React, which is the rule for every map in this app (docs/design.md).
 */
export interface PinMapProps {
  pin: { lat: number; lng: number } | null;
  /** Where to look before a pin exists. */
  initialCenter: { lat: number; lng: number };
  maxBounds?: [number, number, number, number] | undefined;
  onPick: (point: { lat: number; lng: number }) => void;
  /** Disables picking while a save or a coverage check is in flight. */
  busy?: boolean;
}

export function PinMap({ pin, initialCenter, maxBounds, onPick, busy }: PinMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const lastEased = useRef<string | null>(null);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !maxBounds) return;
    map.setMaxBounds([
      [maxBounds[0], maxBounds[1]],
      [maxBounds[2], maxBounds[3]],
    ]);
  }, [maxBounds]);

  // Follow the pin only when it moves somewhere the camera is not already
  // looking — re-centring on every render would fight a user who has panned.
  useEffect(() => {
    if (!pin) return;
    const key = `${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}`;
    if (lastEased.current === key) return;
    lastEased.current = key;

    const map = mapRef.current?.getMap();
    if (!map) return;
    if (map.getBounds().contains([pin.lng, pin.lat])) return;

    map.easeTo({
      center: [pin.lng, pin.lat],
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450,
    });
  }, [pin]);

  const handleClick = useCallback(
    (event: MapLayerMouseEvent) => {
      if (busy) return;
      onPick({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    },
    [busy, onPick],
  );

  return (
    <div className="map-frame h-full w-full overflow-hidden rounded-[var(--radius-chrome)]">
      <Map
        ref={mapRef}
        mapStyle={env.VITE_MAP_STYLE_URL}
        initialViewState={{
          latitude: pin?.lat ?? initialCenter.lat,
          longitude: pin?.lng ?? initialCenter.lng,
          zoom: pin ? 15 : 12,
        }}
        onClick={handleClick}
        cursor={busy ? 'progress' : 'crosshair'}
        attributionControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <AttributionControl compact position="bottom-right" />

        {pin ? (
          <Marker
            latitude={pin.lat}
            longitude={pin.lng}
            draggable={!busy}
            anchor="bottom"
            onDragEnd={(event) => {
              onPick({ lat: event.lngLat.lat, lng: event.lngLat.lng });
            }}
          >
            <PinGlyph />
          </Marker>
        ) : null}
      </Map>
    </div>
  );
}

/**
 * Round, because it is a map-native object rather than chrome — the radius rule
 * in docs/design.md. `water`, because that is the colour of a placed point
 * everywhere else in the product.
 */
function PinGlyph() {
  return (
    <svg width={28} height={36} viewBox="0 0 28 36" aria-hidden>
      <path
        d="M14 35C14 35 26 21.5 26 13.6A12 12 0 1 0 2 13.6C2 21.5 14 35 14 35Z"
        fill="var(--color-water)"
        stroke="var(--color-paper-raised)"
        strokeWidth={2}
      />
      <circle cx={14} cy={13} r={4.5} fill="var(--color-paper-raised)" />
    </svg>
  );
}
