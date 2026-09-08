-- Rename the role labels: SEEKER -> USER, LISTER -> EDITOR.
--
-- `ALTER TYPE ... RENAME VALUE` renames the label in place, so every existing
-- row keeps its role and the column default follows automatically. The
-- alternative Prisma would otherwise generate for an enum change — create a new
-- type, cast the column, drop the old — needs a USING clause per value and a
-- rewrite of the whole table, and gets the default wrong.
--
-- Not wrapped in a guard: a migration that has already run is recorded in
-- _prisma_migrations and is not re-applied, and silently skipping a rename would
-- leave the schema disagreeing with schema.prisma.
ALTER TYPE "UserRole" RENAME VALUE 'SEEKER' TO 'USER';
ALTER TYPE "UserRole" RENAME VALUE 'LISTER' TO 'EDITOR';
