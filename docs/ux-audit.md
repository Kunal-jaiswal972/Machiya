# UX audit — 2026-09-05

**Read this when** you want to know what is broken in the interaction layer,
how to reproduce it, and why it happens.

Every item below was reproduced by driving the running app with Playwright
against the real stack — not read out of the code and not taken from the brief's
description. Where a reported item did **not** reproduce, it says so and shows
the measurement, because a bug that is not there is worse to "fix" than one that
is.

Severity: **S1** the product is wrong or unusable · **S2** a flow is broken or
badly misleading · **S3** friction, confusion or a11y · **S4** polish.

Method: `pnpm dev` against compose, signed in as `seeker@dev.local` unless
stated, 1440x900 and 390x844. Each item records **what happens**, **what should
happen**, and a **root cause** where I established one.

## Coverage, stated plainly

Audited: the cold landing state, the office autocomplete, the search results
list and filter chrome, the listing detail panel, the commute panel, map
interaction, panel dismissal and focus, the 390px viewport.

**Not yet audited**: the lister wizard, the dashboard, the enquiry thread, the
admin pages, saved searches, the sign-up flow. The brief's assumption — that
they carry the same density of problems and have simply not been looked at — is
untested. Nothing below should be read as a clean bill of health for them.

---

## S1 — the differentiator does not respond to input

### 1.1 Changing any commute input leaves every number unchanged

**Reproduce.** Sign in, open `/listings/patna-boring-road-2bhk-02?lat=25.6127&lng=85.1145`.
Note "₹658 per month". Set mileage to 30. Wait.

**What happens.** The input holds 30. The per-month figure, the all-in total and
the car/bike/bus comparison all stay at their old values. Repeating with 18 and
then 36 changed nothing: the panel showed ₹219 throughout.

**What should happen.** The figure moves immediately.

**Root cause — found, and it is not the client.** The write persists and the
server recomputes correctly:

| Probe                                   | Result                              |
| --------------------------------------- | ----------------------------------- |
| `GET /api/me/commute` after the change  | `mileageKmPerLitre: 36` — persisted |
| `GET .../commute` via the app's own URL | `perMonth: 219.33` — **stale**      |
| Same endpoint with `&mode=car` appended | `perMonth: 328.99` — correct        |
| Same URL again after ~2 minutes         | `perMonth: 274.16` — correct        |

`apps/api/src/routes/fuel.ts` sets `cache-control: private, max-age=120` on
`GET /api/listings/:slug/commute`. The response **varies by the caller's stored
preferences**, which appear nowhere in the URL and in no `Vary` header — so the
browser serves its own cached copy for two minutes and TanStack's refetch never
reaches the server. The comment above the line says "Private: it depends on the
caller's own settings", which is exactly why a URL-keyed cache is wrong here.

This one cause explains every symptom, including the intermittency: a change
lands if and only if more than 120 seconds have passed since that URL was last
fetched. That is why it "sometimes works".

**Fix direction.** The preferences that determine the answer should travel in
the request rather than being ambient — which also gives the brief's per-listing
override for free, and makes the panel work signed-out without a round trip.
Failing that, `no-store`.

### 1.2 Signed out, the controls are decorative — and the panel says otherwise

**Reproduce.** Sign out. Open any listing. Set mileage to 30.

**What happens.** The input snaps back to 15. Console: `401 Unauthorized` on
`PATCH /api/me/commute`. No number moves.

**Root cause.** `useCommutePreferences` gates its query on `isSignedIn`, so
signed out there is no `['commute-preferences']` cache entry. The optimistic
update is written as `current ? { ...current, ...patch } : current` — with
`current` undefined it is a **no-op**. The PATCH then 401s. The hook's own
comment claims "the controls still work, nothing is saved", and the panel tells
the user "Sign in to keep these settings between visits". Both are false: signed
out the controls do nothing at all.

**What should happen.** Preferences need a client-side source of truth that
works signed out, with the server as persistence when signed in.

### 1.3 Switching to Bike keeps a car's vehicle and mileage

**Reproduce.** On a listing, click **Bike**.

**What happens.** Mode changes, but the vehicle select still lists
hatchback/sedan/SUV with `sedan` selected and mileage 13. A bike journey is
priced with a sedan's consumption.

**Root cause.** Same stale read as 1.1 — the panel filters vehicle options by
`preferences.mode`, and `preferences` is read back stale. D63 names this exact
combination ("`mode: 'bike'` with a car's mileage is two individually valid
fields and one nonsensical setting"); the UI produces it.

### 1.4 Mileage defaulting to 1 km/l — **did not reproduce**

Vehicle changes set real per-class defaults: SUV → 10, sedan → 13, hatchback →
15, matching `VEHICLE_CLASSES`. Signed out shows 15. I could not produce 1 in
any state I reached. The input carries `min="1"`, so a plausible path is a
cleared field showing the spinner minimum — worth re-checking against whatever
produced the original screenshot before changing a default that is currently
correct.

---

## S1 — the office moves on any map click

### 1.5 One click on empty map silently re-anchors the entire search

**Reproduce.** `/?lat=25.612700&lng=85.114500`, click empty map away from any
marker.

**What happens.** The URL becomes `?lat=25.626848&lng=85.136237` — the office
jumped ~2.4 km — and every distance, ring and commute figure on screen is now
measured from somewhere the user did not choose. No confirmation, no undo.

**Root cause.** Deliberate, and wrong. `SearchMap.tsx`'s `onClick` falls through
to `onPickOffice` for any click that is not a listing marker or a cluster, with
the comment "A click on the map itself moves the office. This is the second of
the three ways to set one."

The pin is **already draggable** (`<Marker draggable onDragEnd>`) — but it is a
16px dot with no grab affordance, so the discoverable mechanism is the
destructive one and the safe one is invisible.

**What should happen.** Setting the office is deliberate: drag the pin, or an
explicit "set office here" affordance. A bare click does nothing.

---

## S2 — state and lifecycle

### 1.6 Overlay layers are styled after they are removed

**Reproduce.** Switch between two listings repeatedly with ~350ms between
switches.

**What happens.** Console: `[map] Cannot style non-existing layer "route-line"`
at `SearchMap.tsx:299`, twice in eight switches.

**Root cause.** The effect guards correctly with `map.getLayer('route-line')`
before starting, but the animation it starts runs on `requestAnimationFrame` and
is not cancelled when the listing changes. The layer is unmounted underneath a
loop that is still writing to it.

**On the reported POI symptom.** I reproduced this _class_ of teardown race but
**not** a blank POI layer specifically: across eight rapid switches the sidebar
"What is nearby" list repopulated every time (7 categories each). The map layer
is canvas-rendered and not observable from the DOM, so the reported symptom is
neither confirmed nor cleared. The rAF leak above is a real defect in the same
family and is the first place to look.

### 1.7 Close from a shared link can navigate out of the product

**Reproduce.** Read the code path; then open a listing URL in a tab that already
has history and press Close.

**What happens.** `close()` in `ListingDetailRoute.tsx` tests
`window.history.length > 1` and calls `navigate(-1)`. `history.length` counts
**the whole tab**, not this app's entries — so a listing opened from a link on
another site sends the user back to that site rather than to the search.

The fallback (`navigate('/')`) only runs in a genuinely fresh tab. D45 says
"closing is `navigate(-1)` when there is history"; the test for "is there
history" is the bug.

### 1.8 Dismissal is three ways out of four, and focus is not trapped

The detail panel **does** have a close control and **does** handle Escape
(`DetailPanel.tsx:49`), contrary to the brief — but:

- **no click/tap outside to dismiss** — there is no outside-press handler;
- **focus is moved into the panel but never trapped**, so Tab walks out into the
  map and the list behind it;
- **focus is not returned** to the trigger on close;
- it is bespoke rather than a shadcn `Sheet`/`Dialog`, which is where all four
  behaviours would have come for free.

### 1.9 Search suggestions flicker — **did not reproduce**

Instrumented with a `MutationObserver` and a per-frame poll while typing
character by character:

- the option count never dropped between keystrokes (steady at 8);
- the first option's DOM node was the **same node** throughout — the list is not
  re-created;
- the listbox height was constant at 288px — no layout jump;
- computed `animation-name` on the rows was `none` — nothing re-animates.

`placeholderData` (D39) is doing its job. Whatever produced the reported flicker
is not present on this build at this network speed; re-check under throttling
before changing anything.

---

## S2 — the office picker cannot find a locality

### 1.10 Typing "locality, city" returns only flats

**Reproduce.**

```
GET /api/places/suggest?q=Boring Road          → locality 1.000, then listings 0.736
GET /api/places/suggest?q=Boring Road, Patna   → eight listings, no locality at all
```

**What happens.** The natural way to type a place — "Boring Road, Patna" — drops
the locality **entirely** and offers eight near-identical flats. Setting your
office to a specific stranger's flat is the only thing on offer.

**Root cause.** Tier 1 matches `Locality.name` alone ("Boring Road"), while a
listing matches its full `address` ("Boring Road, Patna") — which already
contains the city. Adding the city to the query therefore _lowers_ the
locality's trigram similarity below the cut while _raising_ the listings'. D39
weights listings ×0.8 and D58 drops them to ×0.35 for street addresses, but this
query is neither: no house number, so no address weighting applies.

This is the same shape as D60's first bug — weak local rows suppressing the
answer — one level up.

---

## S3 — the commute panel says one thing twice

### 1.11 Two blocks, one concept

The panel renders "Commute from your office" (Car/Bike toggle, by-road distance,
travel time) and then "Commute cost" (per month, per trip, and its own
Car/Bike/Bus comparison). Mode is selectable in both places.

### 1.12 The comparison bars make the cheap option look like zero

Car ₹658, Bike ₹152, Bus ₹571 render as proportional bars, so the bike — the
option that most changes a renter's answer — is a sliver. The numbers are the
point; the geometry is actively working against them.

### 1.13 The fuel line is wrong in three ways

Rendered: `Petrol at ₹113/litre, from goodreturns — last checked 05/09/2026,
15:30:00, refreshing now`.

- **No city**, though the price is per city and the payload carries
  `citySlug: "patna"`.
- **One source asserted flat.** The payload has `sources: ["goodreturns"]` — an
  array, and here of length one. One adapter answering out of three is a
  different confidence from three agreeing, and nothing says which this is.
- **A raw timestamp** (`05/09/2026, 15:30:00`) where a person wants "checked
  this morning", plus "refreshing now" which describes our queue rather than
  anything they can act on.

---

## S3 — copy leaks the repository into the product

### 1.14 A source file path is rendering on the listing panel

Top of the gallery: **"Seed photos via Unsplash — credits in
docs/attribution.md"**. A repo path, shown to users. The Unsplash terms do
require credit, so the fix is per-photo attribution, not deletion.

### 1.15 The address line repeats the state

`Boring Road, Patna, Bihar · Bihar`. The formatter appends the state to an
address string that already ends in it.

### 1.16 Other leaks found in one pass

- `Seed data: the address and photos are placeholders, the geometry is real.`
  rendered in the listing description.
- Fuel attribution names the adapter slug `goodreturns` rather than a source.
- Radius chips read `1 km 5 · 2 km 15 · 3 km 3` — those are **per-ring** counts
  beside a line saying "23 within 3.0 km". 5+15+3=23, but nothing on screen says
  the chips are rings rather than cumulative radii.

---

## S3 — chrome, controls and layout

### 1.17 Native controls where shadcn exists

`Sort` is a native `<select>`; so are `Vehicle` and `Fuel` in the commute panel.
Three of them on two screens.

### 1.18 The radius says the same thing three times

Ring chips with counts, a slider, a "3.0 km" readout, and "23 within 3.0 km"
below — four elements for one number.

### 1.19 Mobile at 390px

| Measurement                   | Value                                |
| ----------------------------- | ------------------------------------ |
| Header + chrome above content | 194px of 844 (23%)                   |
| Tap targets under 44px        | **22**                               |
| Horizontal page overflow      | **yes** — `scrollWidth > innerWidth` |

The sideways scroll is a bug on its own: nothing should overflow the viewport
width on a phone.

### 1.20 Dark is not the default

With `localStorage` cleared and the OS set to light, a first-time visitor gets
the **light** theme: `initialTheme()` reads `prefers-color-scheme` and only
falls back to dark. The brief wants dark as the initial state with a stored
preference winning over the system one.

### 1.21 Map a11y

The map region has no accessible name and its zoom controls have no labels
(`button` with no text or `aria-label`). The list is the canonical
representation per docs/design.md, but the controls are still reachable and
unlabelled.

---

## What I did not get to

Listed so the next session starts from the gap rather than rediscovering it:

- the wizard end to end, including whether it resumes and whether D59's rules
  hold in the UI;
- the lister dashboard and its analytics;
- the enquiry thread, both sides;
- the admin queue, users and coverage-demand pages;
- saved searches and the saved-office flow (the brief reports it has no surface
  at all — unverified);
- keyboard-only traversal of a whole flow;
- the list-only fallback view;
- skeleton and empty-state coverage outside the search.
