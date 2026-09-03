import { POI_CATEGORIES, type PoiCategory } from '@machiya/shared';
import { useEffect, useState } from 'react';
import { useUiStore } from '../stores/ui';

/**
 * Which token each POI category is drawn in. The same mapping the legend
 * renders from, so a colour cannot differ between the map and the key beside it.
 */
const POI_TOKENS: Record<PoiCategory, string> = {
  hospital: '--clay',
  police: '--water',
  school: '--verdant',
  pharmacy: '--clay',
  atm: '--ink-soft',
  supermarket: '--verdant',
  transit: '--water',
};

/**
 * The design tokens, as literal colours maplibre can use.
 *
 * maplibre paint properties are not CSS — they take colour *values*, so
 * `'var(--color-ring-1)'` silently produces nothing. But the whole colour
 * direction (docs/design.md) is that the map chrome and the tiles are one
 * surface, which means the markers and rings must come from the same tokens as
 * the panels rather than a second hardcoded palette that drifts.
 *
 * So the tokens are read off the document once per theme and handed to the map
 * as literals. Re-reading on a theme change is what keeps dark mode honest.
 */
export interface MapPalette {
  ring1: string;
  ring2: string;
  ring3: string;
  markerBg: string;
  markerFg: string;
  markerEdge: string;
  markerPriceBg: string;
  markerPriceFg: string;
  route: string;
  /** Per POI category, resolved. Keyed by the same categories the legend uses. */
  poi: Record<PoiCategory, string>;
}

/**
 * Converts a CSS colour to `#rrggbb`.
 *
 * This is load-bearing, not a nicety: **maplibre-gl 6 cannot parse `oklch()`**,
 * and every token in this design system is authored in it. Handing an oklch
 * string to a paint property makes maplibre emit
 * `layers.x.paint.fill-color: color expected, "oklch(...)" found` for each
 * layer, fire its `error` event, and paint nothing — which is exactly how this
 * was found: a completely blank map with no CSS mistake anywhere.
 *
 * The conversion PAINTS the colour and reads the pixel back. Serialisation is
 * not enough: assigning an oklch string to `ctx.fillStyle` and reading it again
 * returns the same oklch string, because CSS Color 4 colours serialise in their
 * own space. The rasterised pixel, on the other hand, is already sRGB.
 */
let converter: CanvasRenderingContext2D | null | undefined;

function toHex(value: string, fallback: string): string {
  if (value.length === 0) return fallback;
  // Already something maplibre understands.
  if (value.startsWith('#') || value.startsWith('rgb') || value.startsWith('hsl')) return value;

  if (converter === undefined) {
    converter = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (converter) {
      converter.canvas.width = 1;
      converter.canvas.height = 1;
    }
  }
  if (!converter) return fallback;

  // A sentinel underneath, so an unpaintable value is detectable rather than
  // silently producing whatever was painted last.
  converter.clearRect(0, 0, 1, 1);
  converter.fillStyle = '#000000';
  converter.fillRect(0, 0, 1, 1);
  converter.fillStyle = value;
  converter.fillRect(0, 0, 1, 1);

  const [r, g, b, a] = converter.getImageData(0, 0, 1, 1).data;

  if (r === undefined || g === undefined || b === undefined || a === undefined || a === 0) {
    return fallback;
  }

  const hex = (channel: number): string => channel.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function readToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return toHex(styles.getPropertyValue(name).trim(), fallback);
}

function readPalette(): MapPalette {
  const styles = getComputedStyle(document.documentElement);

  return {
    ring1: readToken(styles, '--color-ring-1', '#4a7fd0'),
    ring2: readToken(styles, '--color-ring-2', '#6b95d8'),
    ring3: readToken(styles, '--color-ring-3', '#8fb0e0'),
    markerBg: readToken(styles, '--card', '#ffffff'),
    markerFg: readToken(styles, '--ink', '#1e2530'),
    markerEdge: readToken(styles, '--edge-strong', '#b6bec9'),
    // Price markers carry the price colour, because that is what they show.
    markerPriceBg: readToken(styles, '--signal', '#e8b13a'),
    markerPriceFg: readToken(styles, '--signal-ink', '#3b2c08'),
    route: readToken(styles, '--water', '#3f74c0'),
    poi: Object.fromEntries(
      POI_CATEGORIES.map((category) => [
        category,
        readToken(styles, POI_TOKENS[category], '#6b7280'),
      ]),
    ) as Record<PoiCategory, string>,
  };
}

export function useMapPalette(): MapPalette {
  const theme = useUiStore((state) => state.theme);
  const [palette, setPalette] = useState<MapPalette>(() => readPalette());

  useEffect(() => {
    // The class is toggled on <html> by the theme store before this runs, but
    // a frame's grace means the computed values are the new ones even when a
    // transition is in play.
    const frame = requestAnimationFrame(() => setPalette(readPalette()));
    return () => cancelAnimationFrame(frame);
  }, [theme]);

  return palette;
}
