#!/bin/sh
# Container healthcheck for the postgis service.
#
# Deliberately stronger than pg_isready alone: it also asserts the PostGIS
# extension is present in the image, so a plain-Postgres image can never be
# mistaken for a healthy spatial database.
set -e

pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"

psql -qtAX -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'" | grep -q 1
