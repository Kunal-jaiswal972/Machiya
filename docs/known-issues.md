# Known issues

**Read this when** you want to know what is broken, worked around, or
deliberately left for later — before you spend an afternoon rediscovering it.

An index, not an explanation. One line each, linking to the `DECISIONS.md` entry
that carries the reasoning. Add a line when you defer work, leave a workaround in
place, or find a bug you are not fixing now; **delete the line in the commit that
fixes it**. A list nobody prunes is a list nobody reads.

## Deferred work

- **Transit fares are configuration and go stale silently.** No free API
  publishes them reliably, so they live in each city record and nothing warns
  when they age. A commute costed by transit is only as current as that table.
- **No orientation-tag test fixture.** The EXIF strip is tested; applying an
  orientation tag is not, because `withExif` cannot produce a non-1 orientation
  and a real fixture means committing binary image data.
  ([D66](../DECISIONS.md#d66-two-tests-that-could-not-fail))

## Workarounds still in force

- **`pnpm auth:check` exists because the Better Auth CLI's output is a draft.**
  `@better-auth/cli` 1.4.x generates a schema for a 1.7.x runtime and omits
  columns the adapter writes; the check diffs against the runtime instead. Run
  it after every upgrade.
  ([D22](../DECISIONS.md#d22-the-better-auth-schema-is-checked-against-the-runtime-not-the-cli))
- **HEIC is in the upload allowlist but usually cannot be decoded.** sharp
  prebuilds ship without HEIF, so the worker probes at runtime and returns
  "export as JPEG instead" rather than a decode crash.
  ([D37](../DECISIONS.md#d37-the-declared-content-type-is-never-trusted-magic-bytes-decide))
- **`minio/mc:latest` is the one unpinned image.** It creates a bucket and
  exits; revisit if bucket setup becomes load-bearing.
  ([D11](../DECISIONS.md#d11-minioumclatest-is-the-one-unpinned-image))
- **`--max-table-size` is set on both OSRM services and bounds nothing we
  call.** Kept for the all-to-all shape it does bound; the real ceiling on the
  total-cost sort's `/table` is `TABLE_CHUNK` in the adapter.
  ([D61](../DECISIONS.md#d61-one-table-call-prices-a-whole-page-of-listings--and-the---max-table-size-pin-does-not-bound-it))

## Bugs and gaps recorded, not fixed

- **The autocomplete's tier 2 is still stubbed in every suite**, which is why
  D57, D58 and D60 were all found by a live run. `apps/e2e` now walks sign-up to
  enquiry against the real stack, but its geocoding is not on that path — the
  wizard sends a pin, not a query.
  ([D60](../DECISIONS.md#d60-three-bugs-the-live-run-found-that-the-tests-could-not))

## Not issues, recorded so they stop being rediscovered

- A **locally-answered autocomplete query is the fast path, not a degraded
  one**, and the API says `ok` for it on purpose.
  ([D54](../DECISIONS.md#d54-degraded-and-out-of-coverage-are-separate-autocomplete-states-because-they-were-the-same-bug))
- A **`nearest`-method city assignment inside coverage is correct**, not a
  fallback that needs removing. Across the coverage frontier it is refused
  instead. ([D50](../DECISIONS.md#d50-city-assignment-is-containment-first-nearest-centroid-second--and-says-which),
  [D53](../DECISIONS.md#d53-out-of-coverage-is-a-200-for-a-read-and-a-422-for-a-write))
- **`/health` is green on a clone with no OSM artifacts, and that is the
  truth.** `/health/geo` is the one that answers 503.
  ([D51](../DECISIONS.md#d51-artifact-staleness-is-detectable-and-the-download-strategy-switches-itself))
