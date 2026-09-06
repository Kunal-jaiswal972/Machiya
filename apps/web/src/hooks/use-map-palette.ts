import { POI_CATEGORIES, type PoiCategory } from '@machiya/shared';
import { useEffect, useState } from 'react';
import { useMapStyle } from './use-map-style';

/**
 * Which token each POI category is drawn in. The same mapping the legend
 * renders from, so a colour cannot differ between the map and the key beside it.
 *
 * Seven distinct hues rather than the palette's judgement colours: `verdant`
 * and `clay` say "this suits you" and "this does not", which a school is
 * neither, and reusing them left two pairs of categories sharing a colour.
 */
const POI_TOKENS: Record<PoiCategory, string> = {
  hospital: '--poi-hospital',
  police: '--poi-police',
  school: '--poi-school',
  pharmacy: '--poi-pharmacy',
  atm: '--poi-atm',
  supermarket: '--poi-supermarket',
  transit: '--poi-transit',
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

/**
 * The token set for the MAP's theme, which is not always the app's.
 *
 * Someone can run a dark interface with a light map (D83), and reading the
 * tokens off `<html>` then paints dark-mode overlays onto a pale basemap: the
 * price marker measured 1.27:1 against the ground, which is a marker nobody can
 * see. So the values are read from a detached element carrying the map's own
 * theme class instead.
 */
function readPalette(isDark: boolean): MapPalette {
  const host = document.createElement('div');
  host.className = isDark ? 'dark' : '';
  host.style.display = 'none';
  document.body.append(host);

  const styles = getComputedStyle(host);

  const palette: MapPalette = {
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

  host.remove();
  return palette;
}

export function useMapPalette(): MapPalette {
  const { isDark } = useMapStyle();
  const [palette, setPalette] = useState<MapPalette>(() => readPalette(isDark));

  useEffect(() => {
    // A frame's grace so a theme transition has settled before the values are
    // read; the class on the detached host is set synchronously either way.
    const frame = requestAnimationFrame(() => setPalette(readPalette(isDark)));
    return () => cancelAnimationFrame(frame);
  }, [isDark]);

  return palette;
}
