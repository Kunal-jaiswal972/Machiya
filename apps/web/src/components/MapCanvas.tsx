import { useState } from 'react';
import Map, {
  AttributionControl,
  GeolocateControl,
  NavigationControl,
  ScaleControl,
  type MapLayerMouseEvent,
  type ViewState,
} from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../lib/maplibre-setup';
import { env } from '../env';

export interface MapCanvasProps {
  initialViewState?: Partial<ViewState>;
  onMapClick?: (lngLat: { lng: number; lat: number }) => void;
  children?: React.ReactNode;
}

/** Patna centroid — the default city until the office picker lands in step 6. */
const DEFAULT_VIEW: Partial<ViewState> = {
  longitude: 85.1376,
  latitude: 25.5941,
  zoom: 12,
};

export function MapCanvas({ initialViewState, onMapClick, children }: MapCanvasProps) {
  const [styleError, setStyleError] = useState<string | null>(null);

  if (styleError) {
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted p-6 text-center"
      >
        <p className="font-medium">The map could not load.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Tiles come from {env.VITE_MAP_STYLE_URL}. Check the network, or point VITE_MAP_STYLE_URL
          at a self-hosted style. Listings are still available as a list.
        </p>
      </div>
    );
  }

  return (
    <Map
      initialViewState={{ ...DEFAULT_VIEW, ...initialViewState }}
      mapStyle={env.VITE_MAP_STYLE_URL}
      style={{ width: '100%', height: '100%' }}
      attributionControl={false}
      onClick={(event: MapLayerMouseEvent) => onMapClick?.(event.lngLat)}
      onError={(event) => setStyleError(event.error?.message ?? 'unknown map error')}
    >
      <NavigationControl position="top-right" showCompass visualizePitch={false} />
      <GeolocateControl position="top-right" trackUserLocation={false} />
      <ScaleControl position="bottom-left" unit="metric" />
      <AttributionControl position="bottom-right" compact />
      {children}
    </Map>
  );
}
