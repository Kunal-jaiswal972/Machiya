import { POI_CATEGORIES, type PoiCategory } from '@machiya/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { POI_META } from '../components/listing/poi-meta';

/**
 * The sidebar's icons, drawn onto the map.
 *
 * The legend and the markers have to be the same picture in the same colour or
 * they are not visibly the same data — pressing "Hospitals" has to light up
 * things that look like the row you pressed.
 *
 * So the glyph is not redrawn here: the actual `POI_META` component is rendered
 * into a detached root, its SVG markup taken, and that rasterised. Copying the
 * paths instead would work until someone changed an icon in the panel and the
 * map quietly kept the old one.
 */
export function poiIconId(category: PoiCategory): string {
  return `poi-${category}`;
}

const SIZE = 34;
const PIXEL_RATIO = 2;

/** The panel's own icon, as SVG markup, in the marker's foreground colour. */
function iconMarkup(category: PoiCategory, color: string): string {
  const host = document.createElement('div');
  const root = createRoot(host);

  // Synchronous on purpose: the markup is read on the next line, and a
  // concurrent render would hand back an empty div.
  flushSync(() => {
    root.render(
      createElement(POI_META[category].Icon, {
        color,
        strokeWidth: 2.4,
        size: 24,
        absoluteStrokeWidth: true,
      }),
    );
  });

  const markup = host.innerHTML;
  root.unmount();
  return markup;
}

async function rasterise(markup: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  return image;
}

/**
 * Registers one image per category: a filled disc in the category's colour with
 * the panel's glyph on top, so a marker still reads at 12px.
 *
 * Idempotent — an existing image is replaced rather than left stale, which is
 * what makes a theme change repaint the markers instead of keeping the previous
 * theme's colours until the next listing.
 */
export async function registerPoiIcons(
  map: MapLibreMap,
  colors: Record<PoiCategory, string>,
  background: string,
): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * PIXEL_RATIO;
  canvas.height = SIZE * PIXEL_RATIO;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;

  const glyphs = await Promise.all(
    POI_CATEGORIES.map(async (category) => ({
      category,
      image: await rasterise(iconMarkup(category, background)),
    })),
  );

  for (const { category, image } of glyphs) {
    // The style can be swapped or the map removed while the glyphs decode.
    if (!map.getStyle()) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(PIXEL_RATIO, PIXEL_RATIO);

    const center = SIZE / 2;
    context.beginPath();
    context.arc(center, center, center - 2, 0, Math.PI * 2);
    context.fillStyle = colors[category];
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = background;
    context.stroke();

    const glyph = SIZE * 0.56;
    context.drawImage(image, center - glyph / 2, center - glyph / 2, glyph, glyph);
    context.restore();

    const id = poiIconId(category);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);

    if (map.hasImage(id)) {
      map.updateImage(id, data);
    } else {
      map.addImage(id, data, { pixelRatio: PIXEL_RATIO });
    }
  }

  map.triggerRepaint();
}
