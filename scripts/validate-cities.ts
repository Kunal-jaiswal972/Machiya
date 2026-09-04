/**
 * Reports the city-configuration rules, and fails CI when any is broken.
 *
 *   pnpm cities:validate
 *
 * The rules themselves live in `@machiya/shared/cities` (`validate.ts`) so they
 * can be unit-tested against deliberately broken configs — a validator with no
 * tests is a validator nobody trusts when it fires. This file is the reporting
 * half, and the exit code.
 */
import { basename } from 'node:path';
import { CITIES, planDownloads, validateCities } from '@machiya/shared/cities';

function main(): void {
  const issues = validateCities();
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const plan = planDownloads();

  console.log(`Validated ${String(CITIES.length)} cities: ${CITIES.map((c) => c.slug).join(', ')}`);
  console.log(`Download plan: ${plan.strategy} — ${plan.reason}`);

  for (const issue of [...errors, ...warnings]) {
    const where = issue.city ? `${issue.city}: ` : '';
    const mark = issue.severity === 'error' ? 'ERROR' : 'warn ';
    console.log(`  ${mark} [${issue.rule}] ${where}${issue.message}`);
  }

  if (errors.length > 0) {
    console.error('');
    console.error(
      `${String(errors.length)} error(s). The city config is the source of truth for the seed, the artifacts and the scrapers — fix it before anything reads it.`,
    );
    process.exit(1);
  }

  console.log('');
  console.log(
    warnings.length > 0 ? `OK with ${String(warnings.length)} warning(s).` : 'OK — no issues.',
  );
}

if (process.argv[1] && basename(process.argv[1]) === 'validate-cities.ts') {
  main();
}
