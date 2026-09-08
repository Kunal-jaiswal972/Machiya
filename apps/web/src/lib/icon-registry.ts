import {
  Accessibility,
  AirVent,
  ArrowUpDown,
  Ban,
  Bath,
  Baby,
  BedDouble,
  Bike,
  Blocks,
  CalendarClock,
  CarFront,
  ChefHat,
  CigaretteOff,
  Clock,
  Container,
  Dog,
  DoorOpen,
  Droplets,
  Dumbbell,
  Flame,
  Footprints,
  KeyRound,
  Landmark,
  PartyPopper,
  PawPrint,
  Recycle,
  Refrigerator,
  Salad,
  ScrollText,
  Shield,
  ShieldCheck,
  Shirt,
  Sofa,
  Sparkles,
  SquareParking,
  Sun,
  Trees,
  Tv,
  UserCheck,
  Users,
  Utensils,
  Video,
  VolumeOff,
  Warehouse,
  WashingMachine,
  Waves,
  Wifi,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * The icons an `Amenity.icon` or a `HouseRule.icon` name can resolve to.
 *
 * Explicit rather than `lucide-react/dynamicIconImports`: the dynamic map pulls
 * a lazy chunk per icon and turns a static list of thirty into thirty network
 * round trips on the detail page. These are named imports, so the bundler keeps
 * only what is here.
 *
 * Amenity icon names come from the database, which means from the seed — a row
 * naming an icon that is not in this map is possible, and `iconFor` answers with
 * the neutral fallback rather than rendering a hole. See DECISIONS.md D90.
 */
const REGISTRY: Record<string, LucideIcon> = {
  Accessibility,
  AirVent,
  ArrowUpDown,
  Baby,
  Ban,
  Bath,
  BedDouble,
  Bike,
  Blocks,
  CalendarClock,
  CarFront,
  ChefHat,
  CigaretteOff,
  Clock,
  Container,
  Dog,
  DoorOpen,
  Droplets,
  Dumbbell,
  Flame,
  Footprints,
  KeyRound,
  Landmark,
  PartyPopper,
  PawPrint,
  Recycle,
  Refrigerator,
  Salad,
  ScrollText,
  Shield,
  ShieldCheck,
  Shirt,
  Sofa,
  Sparkles,
  SquareParking,
  Sun,
  Trees,
  Tv,
  UserCheck,
  Users,
  Utensils,
  Video,
  VolumeOff,
  Warehouse,
  WashingMachine,
  Waves,
  Wifi,
  Zap,
};

/** The mark used when a name is unknown, missing, or not in the registry. */
export const NeutralIcon = ScrollText;

export function iconFor(name: string | null | undefined): LucideIcon {
  if (!name) return NeutralIcon;
  return REGISTRY[name] ?? NeutralIcon;
}
