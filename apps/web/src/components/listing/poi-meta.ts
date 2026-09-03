import type { PoiCategory } from '@machiya/shared';
import {
  Banknote,
  Bus,
  Cross,
  GraduationCap,
  Pill,
  Shield,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';

/**
 * Label and icon per POI category.
 *
 * In its own module rather than beside the panel that renders it, so the legend
 * and the map read one definition — and so the panel file exports only a
 * component, which is what keeps fast refresh working.
 *
 * The COLOUR is deliberately not here: the tokens are CSS variables maplibre
 * cannot parse, so they are resolved once in `use-map-palette` and shared from
 * there.
 */
export const POI_META: Record<PoiCategory, { label: string; Icon: LucideIcon }> = {
  hospital: { label: 'Hospitals', Icon: Cross },
  police: { label: 'Police', Icon: Shield },
  school: { label: 'Schools', Icon: GraduationCap },
  pharmacy: { label: 'Pharmacies', Icon: Pill },
  atm: { label: 'ATMs & banks', Icon: Banknote },
  supermarket: { label: 'Groceries', Icon: ShoppingCart },
  transit: { label: 'Transit', Icon: Bus },
};
