/**
 * Compares the tables Better Auth's RUNTIME requires against what
 * packages/db/prisma/schema.prisma actually declares.
 *
 * This exists because @better-auth/cli lags the library: at the time of writing
 * the newest published CLI is 1.4.22 while `better-auth` is 1.7.2, and the CLI's
 * generated schema was missing `Account.issuer`. Every sign-up then failed with
 * "Unknown argument `issuer`" — at runtime, in a 500, with nothing at build time
 * to catch it.
 *
 * `getAuthTables` reads the same definitions the adapter writes through, so it
 * is the authority. Run `pnpm auth:check` after any Better Auth upgrade or
 * plugin change.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAuthTables } from 'better-auth/db';
import { auth } from '../src/auth/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const schemaPath = join(repoRoot, 'packages', 'db', 'prisma', 'schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');

/** Crude but sufficient: field names per Prisma model. */
function prismaModels(source: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  const modelPattern = /model\s+(\w+)\s*\{([^}]*)\}/g;

  for (const match of source.matchAll(modelPattern)) {
    const [, name, body] = match;
    if (!name || !body) continue;

    const fields = new Set<string>();
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('@@') ||
        trimmed.startsWith('///')
      ) {
        continue;
      }
      const field = trimmed.split(/\s+/)[0];
      if (field) fields.add(field);
    }
    models.set(name, fields);
  }

  return models;
}

const models = prismaModels(schema);
const tables = getAuthTables(auth.options);
const problems: string[] = [];

/**
 * Better Auth names its models in lowercase (`user`, `session`); this schema
 * uses PascalCase (`User`, `Session`). The Prisma adapter resolves them through
 * the client's camelCase accessor, so the two agree at runtime — but the
 * comparison here has to be case-insensitive to see that.
 */
function findModel(modelName: string): [string, Set<string>] | undefined {
  for (const [name, fields] of models) {
    if (name.toLowerCase() === modelName.toLowerCase()) {
      return [name, fields];
    }
  }
  return undefined;
}

for (const [tableKey, table] of Object.entries(tables)) {
  const found = findModel(table.modelName);

  if (!found) {
    problems.push(
      `model ${table.modelName} (auth table "${tableKey}") is missing from schema.prisma`,
    );
    continue;
  }

  const [modelName, declared] = found;

  for (const [fieldKey, definition] of Object.entries(table.fields)) {
    const column = definition.fieldName ?? fieldKey;
    if (!declared.has(column)) {
      problems.push(
        `${modelName}.${column} is required by Better Auth (${definition.type}${definition.required ? ', required' : ''}) but not declared`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('Better Auth schema mismatch:\n');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    '\nAdd the fields above to packages/db/prisma/schema.prisma and run pnpm db:migrate.',
  );
  process.exit(1);
}

const summary = Object.entries(tables)
  .map(([, table]) => `${table.modelName}(${Object.keys(table.fields).length} fields)`)
  .join(', ');
console.log(`Better Auth schema matches: ${summary}`);
// Importing the auth module opens a Prisma client and a Redis connection.
process.exit(0);
