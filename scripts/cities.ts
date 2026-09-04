/**
 * CLI over the city configuration, for `scripts/bootstrap.sh`.
 *
 * The configuration itself moved to `@machiya/shared/cities` in correction 8:
 * the API needs it (to notice that artifacts predate the running config), the
 * seed needs it, the validator needs it, and a copy in `scripts/` that the API
 * cannot import would have meant two lists. This file is the shell-facing view
 * of that one list, so `bootstrap.sh` never hardcodes a coordinate — and it is
 * re-exported here so the older `../../../scripts/cities.js` import path still
 * resolves.
 *
 *   tsx scripts/cities.ts slugs      -> one city slug per line
 *   tsx scripts/cities.ts downloads  -> one Geofabrik file name per line
 *   tsx scripts/cities.ts plan       -> "<strategy> <reason>", one line
 *   tsx scripts/cities.ts extracts   -> "slug sourceFile minLng minLat maxLng maxLat",
 *                                       with the PADDED box: it is what osmium cuts
 *   tsx scripts/cities.ts bboxes     -> the same for the unpadded administrative box
 *   tsx scripts/cities.ts zones      -> one Geofabrik zone name per line
 */
import { basename } from 'node:path';
import { CITIES, ZONES, planDownloads } from '@machiya/shared/cities';

export {
  CITIES,
  ZONES,
  cityBySlug,
  planDownloads,
  type CityConfig,
  type GeofabrikZone,
  type Locality,
} from '@machiya/shared/cities';

/**
 * Which downloaded file each city is cut from.
 *
 * With three zones that is the city's own zone extract; past the whole-country
 * threshold it is `india-latest.osm.pbf` for every city. Resolving it here
 * rather than in the shell means bootstrap.sh does not have to know the two
 * strategies apart.
 */
function sourceFileFor(zone: string): string {
  const plan = planDownloads();
  return plan.strategy === 'country' ? 'india-latest.osm.pbf' : `${zone}-latest.osm.pbf`;
}

function main(command: string | undefined): void {
  switch (command) {
    case 'zones':
      console.log(ZONES.join('\n'));
      return;
    case 'downloads':
      console.log(planDownloads().files.join('\n'));
      return;
    case 'plan': {
      const plan = planDownloads();
      console.log(`${plan.strategy} ${plan.reason}`);
      return;
    }
    case 'extracts':
      // The PADDED box, deliberately: this is what bootstrap.sh cuts with.
      console.log(
        CITIES.map((city) =>
          [
            city.slug,
            sourceFileFor(city.zone),
            city.paddedBbox.minLng,
            city.paddedBbox.minLat,
            city.paddedBbox.maxLng,
            city.paddedBbox.maxLat,
          ].join(' '),
        ).join('\n'),
      );
      return;
    case 'bboxes':
      // The administrative box, for anything validating membership.
      console.log(
        CITIES.map((city) =>
          [
            city.slug,
            city.zone,
            city.bbox.minLng,
            city.bbox.minLat,
            city.bbox.maxLng,
            city.bbox.maxLat,
          ].join(' '),
        ).join('\n'),
      );
      return;
    case 'slugs':
      console.log(CITIES.map((city) => city.slug).join('\n'));
      return;
    default:
      console.error('Usage: tsx scripts/cities.ts <slugs|downloads|plan|extracts|bboxes|zones>');
      process.exit(1);
  }
}

// Only act as a CLI when executed directly, never when imported by the seed.
if (process.argv[1] && basename(process.argv[1]) === 'cities.ts') {
  main(process.argv[2]);
}
