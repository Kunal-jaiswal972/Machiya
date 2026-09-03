# Images

**Read this when** you are working on photo upload, validation or variants — or
an image is stuck and you need to know why.

## The flow

```
browser ──presigned POST──▶ MinIO / R2   originals/  (PRIVATE)
   │
   └──POST /listings/:id/images/:imageId/uploaded──▶ API
                                                     │  headObject + ownership
                                                     │  commit row, THEN enqueue
                                                     ▼
                                              BullMQ images queue
                                                     │
   worker: file-type sniff ─▶ sharp decode ─▶ 3 sizes × webp + jpeg
                                                     │
                                    variants/ (PUBLIC) + status READY
```

**The API reads no image bytes and has no `sharp` dependency.** It signs the
upload, confirms with `headObject` that the object landed, and enqueues. Why the
derivation is in the worker: [architecture.md](architecture.md) and D34.

`sharp` appears in exactly two `package.json` files: `apps/worker` (runtime) and
`packages/db` (dev-only, so the seed derives its photos through the same code the
worker runs). It is a _peer_ dependency of `packages/shared` and the derivation
module sits behind the `@machiya/shared/images` subpath, so importing
`@machiya/shared` from the browser app can never pull libvips into the web
bundle.

## Two prefixes, two access policies

`originals/` is private. `variants/` is the only publicly readable path.

This matters more than it sounds. Uploads land straight from the browser and are
**not known to be images** until the worker decodes them, so a blanket anonymous
download policy on the bucket would publish whatever anyone uploaded with a valid
ticket. `minio-init` runs `anonymous set none` on the bucket first — so a bucket
created by an older version of the compose file is narrowed rather than left open
— and then grants `download` on `variants/` only.

Verified: a variant fetches anonymously with HTTP 200; an object under
`originals/` returns 403 (D35).

## Where variants live

`ListingImage.variantBaseKey` stores the prefix, without the `/{size}.{ext}`
tail:

- an upload: `variants/{listingId}/{imageId}`, set when the PENDING row is
  created — both ids are known then, which is why the column is NOT NULL;
- a shared seed photo: `variants/fixtures/{photoId}`, written once and pointed at
  by every listing that draws that photo.

It is **stored, not recomputed**. The old code derived it from ids at four call
sites, which made sharing impossible — and with 23 real seed photographs a
private copy per listing would be ~1,200 objects of identical bytes.

The hazard that creates is deletion, and it is guarded explicitly:
`isListingOwnedVariantBase(baseKey, listingId)` is checked before a listing's
variant objects are deleted, so removing one seeded listing cannot blank the
gallery of every other listing sharing the same photo. Four unit tests cover it,
including the prefix trap (`listing-1` must not match `listing-12`). See D41.

## What is enforced, and by whom

**The storage service, before a byte reaches us.** The presigned POST policy
carries a `content-length-range` capping the body at 12 MB and an `eq` condition
on the content type. A presigned PUT cannot bound a request body at all — a
client could stream a gigabyte through a ticket issued for a photo, and we would
find out when the disk filled. Verified: a 13 MB body against a fresh ticket is
refused by MinIO with HTTP 400 (D36).

**The worker, because a declared type proves nothing.** `validateAndDerive`
sniffs the real format with `file-type` _before_ sharp touches the bytes, then
decodes to confirm. A file's extension and its `Content-Type` are both
attacker-controlled.

Verified end to end through the real API and worker:

| Uploaded as `image/jpeg` | Outcome                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| a real JPEG              | READY, 1200x800, six variants, dominant colour                                    |
| a shell script           | REJECTED — "That file is not a recognisable image"                                |
| a PDF                    | REJECTED — "Images must be JPEG, PNG, WebP or HEIC — that one is application/pdf" |

Also rejected: anything over 12,000px on a side, and animated inputs — a
multi-page WebP would otherwise be silently flattened to one frame.

HEIC is in the allowlist but sharp prebuilds usually cannot decode it, so the
code checks `sharp.format.heif.input.buffer` at runtime and returns a clear
"export as JPEG instead" rather than an opaque decode crash.

**EXIF is stripped** by rotating first (`.rotate()` applies the orientation tag
then drops it) and writing no metadata — so GPS coordinates and camera serials in
a phone photo never reach the bucket, which matters when the subject is
somebody's home. A test asserts the derived output has no `exif` and no
`orientation` (D37).

## Rejection versus failure

They are different and are handled differently (D38):

- **`ImageRejected`** — the file is the problem. Terminal: mark `REJECTED` with
  the reason, delete the original, do **not** retry. Three attempts at the same
  corrupt JPEG is three times the work for the same answer.
- **Anything else** — a storage blip, an OOM. Rethrown, so BullMQ backs off and
  retries. Only once attempts are exhausted does the row become `FAILED`.
  Flipping it early would show the user a dead end while a retry was pending.

Idempotency is the image id: it **is** the BullMQ job id, so a double-tap or a
redelivered request collapses onto one job, and a job for an already-`READY`
image returns immediately. (BullMQ 6 rejects `:` in a custom job id, so it cannot
be namespaced — the queue name already scopes it.)

Publishing requires at least one image with status `READY`, not merely present: a
`PENDING` row is an upload the worker has not decoded, so publishing on it would
put a listing live with no servable photo. The 422 distinguishes "still being
processed" from "add a photo", because those need different actions.

## The reconciler

The row commits to Postgres and the job goes to Redis. Two systems, no
transaction between them — so if the enqueue throws, or the API dies in the gap,
the row is committed and nothing is coming for it.

There is **no outbox table**. The `PENDING` row already is the durable record of
intent, and the job id already equals the image id, which makes re-enqueueing
idempotent by construction. What was missing was something to notice:

1. **The enqueue happens strictly after the commit**, and if it throws it is
   logged and the request still returns success. The bytes are in the bucket and
   the row is committed; telling the user the upload failed would be false.
2. **`reconcile-images` runs every 60 seconds**, picks up `PENDING` rows older
   than 2 minutes (a row committed a second ago is one whose enqueue is likely in
   flight), oldest first, bounded to 100 per run, and enqueues those with no
   active, waiting or delayed job.
3. **`reconcileAttempts`** on the row: after five fruitless re-enqueues it
   becomes `FAILED` with a reason the user can act on. A row that never processes
   is a bug to surface, not a loop to hide.
4. **The hourly cleanup sweep now means what it says.** Anything enqueueable is
   drained within minutes, so a `PENDING` row surviving to the 24-hour cutoff
   really is an upload the client never completed.

One case is not idempotent on its own and is handled explicitly: a job that ran
to completion while the row stayed `PENDING` — the process died between the
resize and the database update. BullMQ keeps finished jobs and `add` with an
existing id is a **silent no-op**, so the corpse is removed before the id is
reused. Without that the row is stranded permanently.

What would justify a real outbox table: more than one unrelated side effect per
transaction. Full reasoning in D40.

## Debugging a stuck image

```sql
SELECT id, status, "failureReason", "reconcileAttempts", "createdAt"
FROM "ListingImage" WHERE "listingId" = '…' ORDER BY "sortOrder";
```

| Status     | Means                                                   | Next step                                                 |
| ---------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `PENDING`  | not yet decoded — possibly not yet known to be an image | wait 60 s for the reconciler; check the worker is running |
| `READY`    | variants written, publicly servable                     | —                                                         |
| `REJECTED` | the file is the problem; `failureReason` says how       | the user re-uploads something else                        |
| `FAILED`   | our problem, retries exhausted or reconciled to death   | check worker logs; the row keeps a reason                 |

Worker logs carry `listingId`, `imageId` and the attempt number on every image
job line.
