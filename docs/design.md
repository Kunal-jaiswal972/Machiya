# Design

**Read this when** you are building or changing UI. It is the committed
direction, not a survey of options — if a component disagrees with this
document, the component is wrong.

## The subject, and the one job

Someone in Patna, Bengaluru or Pune has a job at a fixed address and is deciding
where to live. Every listing site shows them rent. Rent is not the number they
will pay: a ₹14,000 flat 12 km away costs ₹17,991 a month to a car commuter
against ₹17,000 for one they can walk to, and nobody shows them that.

The distance in that sentence used to be 9 km, which does not survive the
arithmetic — run through `computeCommuteCost` at the scrapers' own Patna petrol
price, 9 km by car is ₹2,993 a month and the two flats land within ₹10 of each
other. A design document whose opening example overstates the product's own
argument is the last place that should happen, so the number is the measured
one. See [why.md](why.md) for the full table.

**The page's single job: make total monthly cost — rent plus real commute —
comparable at a glance, anchored to one point on a map.**

Everything below follows from that. The map is not a feature; it is the axis the
whole product is measured against.

## Direction: instrument, not brochure

Property sites look like brochures — big soft photographs, generous white space,
aspirational serif. That look sells a _feeling_ about a home. This product sells
an _argument about arithmetic_, and a brochure aesthetic actively fights it: it
makes the numbers decorative.

So the direction is an **instrument**. A rangefinder, a fare table, a survey
panel. Dense where density is honest, calibrated, with numbers set like numbers.
The map is the bright, soft, real-world surface; the UI is the precise chrome
laid over it. That contrast — warm cartographic paper against cool measured
chrome — is the whole look.

What this rules out, deliberately: hero photography with text over it, cards
that are mostly image with a small price, decorative gradients, and any use of
white space that pushes two comparable numbers apart.

### The risk being taken

Rental UI convention is photo-first. This is **number-first**: on a result card
the price is the largest element on the card and the photo is a 4:3 band beside
it, not behind it. If a listing's photo is the reason someone clicks, they will
still click — but they will have seen the total cost before they did. That is the
bet, and it is the one place the design is willing to be strange.

## Colour: taken from the map, so UI and tiles read as one surface

Every value below is derived from the OpenFreeMap Liberty style the map actually
renders, so nothing in the chrome is a colour the map does not already contain.
This is the difference between a UI that sits _on_ the map and one that sits
_over_ it like a foreign panel.

| Token     | oklch            | Taken from                          | Used for                                    |
| --------- | ---------------- | ----------------------------------- | ------------------------------------------- |
| `paper`   | `0.97 0.008 85`  | Liberty land fill                   | The lightest surface. The map's own ground. |
| `ink`     | `0.22 0.035 250` | Liberty water, pushed dark          | Chrome, text, the panel ground in dark mode |
| `signal`  | `0.82 0.155 85`  | Liberty motorway casing (the ochre) | **Price.** The active ring. Nothing else.   |
| `water`   | `0.72 0.095 240` | Liberty water fill                  | The office pin, the route line, focus rings |
| `verdant` | `0.80 0.085 132` | Liberty park fill                   | Within budget, good value, success          |
| `clay`    | `0.58 0.16 33`   | Liberty building fill, saturated    | Over budget, destructive, errors            |

Two rules that keep it disciplined:

1. **`signal` is the price colour and the active-ring colour, and nothing else.**
   The moment it appears on a button, a badge and a chart, price stops being the
   loudest thing on the page and the direction collapses.
2. **`verdant` and `clay` are judgements, not decoration.** They mean "this fits
   your budget" and "this does not". Never used to differentiate categories.

Ring colours are the third judgement: `verdant`, `signal`, `clay` for 1 km, 2 km
and 3 km. Distance from the office is not a category — it is the product's
opinion about a listing — so the rings carry the same green/amber/red on the map
as the badge on the card, and the two read as one system.

**Colour never carries it alone.** Every ring badge says "within 1 km" in words
beside the dot and explains the scheme in a tooltip, so it survives colour
blindness and a greyscale screenshot. `signal` on the middle ring is the one
place the price colour appears away from a price, and it is the same rule as
before: the active ring is the exception, not a new licence.

### Dark mode is designed, not inverted

Dark mode moves both ends of the relationship rather than inverting the palette:

- chrome surfaces move from `paper` to the `ink` family (three steps, not one);
- `signal` gains lightness rather than losing it, because ochre on ink needs more
  luminance to stay a price and not a warning;
- the map is drawn with its own dark style — OpenFreeMap serves one beside
  Liberty, so the tiles are not stuck being bright (D83). The framing stays: a
  1px `ink`-at-40% inner edge and a short scrim at the panel boundary, which is
  what keeps the map reading as a surface inside an instrument rather than a
  hole in the page.

A preference overrides the pairing in either direction — a light map inside a
dark interface was the original position here and is still one press away.

Every token is defined in both blocks. A token missing from one renders as an
invisible control, which is far harder to spot than a wrong colour.

## Typography: three roles, one pairing

| Role    | Face                    | Why this one                                                                                                                                                                               |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Display | **Bricolage Grotesque** | A variable grotesque with genuine irregularity — it has opinions at 48px and stays legible at 20px. Used for prices, headings and map chrome. Not Inter, not a serif, not the safe choice. |
| Body    | **Instrument Sans**     | Slightly condensed, quiet, excellent at 14-16px in dense panels. It gets out of the way, which is exactly its job next to Bricolage.                                                       |
| Data    | **IBM Plex Mono**       | Distances, durations, coordinates, per-litre prices. These are _measurements_; setting them monospaced makes a column of them scannable and reinforces the instrument.                     |

Fallback stacks are real, not decorative: `Bricolage Grotesque` falls back to
`ui-sans-serif, Segoe UI, system-ui`, and the mono role to
`ui-monospace, SFMono-Regular, Menlo`.

**Prices use `font-variant-numeric: tabular-nums`, always.** A column of rents
that jitters as digits change is the single most obvious tell that nobody thought
about the numbers.

Scale, and it is short on purpose — six sizes, not twelve:

```
price-xl   40 / 40   Bricolage 700, tabular, -0.02em    detail sidebar price
price-lg   28 / 30   Bricolage 700, tabular, -0.02em    result card price
title      20 / 26   Bricolage 600                      headings, listing titles
body       15 / 22   Instrument Sans 400                 prose, descriptions
label      13 / 16   Instrument Sans 500, 0.01em         controls, chips, meta
data       12 / 16   Plex Mono 400, 0.02em               distances, durations, ₹/L
```

`data` is deliberately the smallest and the most legible-per-pixel of the three
small sizes; measurements are read, not skimmed.

## Radius, elevation, spacing

**Radius encodes what a thing is.** Chrome is nearly square — an instrument
bezel; map-native objects are round.

```
--radius-chrome: 4px    panels, inputs, cards, buttons
--radius-inset:  2px    chips, tags, inputs inside panels
--radius-sheet:  12px   the bottom sheet's top corners only
--radius-round:  999px  the office pin, the price marker, the ring gauge
```

Nothing gets a radius between 4 and 12. If a component seems to want one, it is
probably chrome pretending to be a card.

**Two elevation levels, not five.** More than two and "which of these is on top"
stops being answerable.

```
--elev-chrome: 0 1px 0 var(--edge), 0 8px 24px -12px oklch(0.22 0.035 250 / 0.18)
--elev-over:   0 1px 0 var(--edge), 0 24px 48px -16px oklch(0.22 0.035 250 / 0.32)
```

`--elev-chrome` is for anything resting on the map. `--elev-over` is for the
sheet, dropdowns and dialogs. A hairline `--edge` accompanies both, because on a
busy map a shadow alone does not separate a panel from a park.

**Spacing is a 4px base, six steps**, and map chrome uses the tighter half:

```
1 = 4px   2 = 8px   3 = 12px   4 = 16px   5 = 24px   6 = 40px
```

Chrome on the map: steps 1-3. Page-level layout: steps 4-6. A 32px gap inside a
map panel is the design failing.

## The signature: the ring gauge

One memorable element, and it is the product's argument as a glyph.

A small circular gauge with three concentric tracks — 1 km, 2 km, 3 km. The
track containing the listing is filled in `signal`; the others stay in `water` at
low opacity. A single tick outside the rings marks **road** distance against the
straight-line fill, so the gap between "3 km away" and "7 km of actual road" is
visible rather than explained.

It appears at three sizes and nowhere else:

```
  20px  on a result card, beside the distance
  56px  in the detail sidebar, with road/straight labels
  96px  in the map legend, doubling as the ring filter control
```

It is drawn as inline SVG with no library, it animates its arc on change (see
below), and at 20px it degrades to the filled track alone — a gauge with
unreadable ticks is noise.

Everything else stays quiet. This is the one accessory that does not come off.

## Motion

Motion earns its place by making structure legible or state legible. Nothing
here decorates.

Library: `motion` (framer-motion's current package name), imported from
`motion/react`.

| Where                            | What                                                                                     | Why it earns it                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Detail sidebar (desktop)         | Springs in from the right, `stiffness 320 / damping 34`                                  | Says "this is layered over the search", not "you navigated away"             |
| Detail sheet (mobile)            | Rises as a bottom sheet; drag to dismiss, velocity-aware snapping between peek/half/full | It is a physical object; treating it as one is the whole affordance          |
| Radius rings                     | Draw outward **in sequence**, 1 km → 2 km → 3 km, 90 ms apart                            | Makes the 1/2/3 structure legible instead of three circles appearing at once |
| Result markers                   | Stagger in (12 ms apart, capped), scale on hover, lift when their list card is hovered   | The map-list hover sync is the interaction that sells the product            |
| Route polyline                   | Draws office → listing via `stroke-dashoffset`                                           | Direction is information: it is _your_ commute, one way                      |
| Filter chips, sort, result count | Shared `layoutId` transitions                                                            | A re-sort reads as a reorder rather than a flash                             |
| Commute cost figures             | Count up on input change; comparison bars animate width                                  | Shows that a number _changed_, which is the point of the panel               |
| Route and wizard step changes    | Directional slides                                                                       | Forward and back are different                                               |

### Motion discipline — this part matters more than the list

- **Never drive maplibre paint or layout properties from React state at frame
  rate.** Animate the camera with the map's own `easeTo` / `flyTo`; animate layer
  properties with `requestAnimationFrame` writing directly through
  `setPaintProperty`. React state changes at 60 Hz will re-render the tree and
  drop frames, and the map will fight you.
- **Reserve motion for DOM chrome.** The map's own objects animate through the
  map's own APIs.
- **`prefers-reduced-motion` falls back to an instant state change**, never to a
  shorter animation. The rings appear, the sheet is open, the number is the new
  number.
- **No animation gates content the user is waiting for.** A staggered marker
  entrance runs while the list is already readable.
- **60 markers on screen, dragging the office pin, must hold 60fps.** If it does
  not, cut the animation rather than the frame rate. Test it; do not assume it.

## States, and they are designed

Empty, loading and error states are where most interfaces stop being designed.
Each of these gets a real treatment, not a centred sentence.

**Empty states** — an illustration built from the design's own vocabulary (ring
gauge, map hairlines, a price chip), one sentence naming what is missing, and one
button that does the next useful thing:

| Screen        | Says                                                    | Button                        |
| ------------- | ------------------------------------------------------- | ----------------------------- |
| No results    | "Nothing inside 3 km with these filters."               | Clear filters / widen to 3 km |
| No listings   | "You have not listed a place yet."                      | Start a listing               |
| No enquiries  | "No one has asked about your places yet."               | View my listings              |
| No favourites | "Nothing saved. Tap the heart on a listing to keep it." | Back to search                |

Errors explain what happened and how to fix it, in the interface's voice. They
do not apologise and they are never vague. Every route has an error boundary
with a retry that retries _that_ route, not a page reload.

**Skeletons match the shape of what loads.** A result card skeleton is a 4:3
photo band, a price-width block, two meta lines and a 20px circle — not three
grey bars. A skeleton that does not match its content produces a visible jump,
which is worse than a spinner.

**Every mutation produces a toast**, success or failure, with the same verb as
the control that started it: "Publish" produces "Published".

**Favourites toggle optimistically** and roll back on failure with a toast. A
heart that waits for a round trip feels broken.

## Keyboard and screen readers

A map is not navigable by keyboard, so the keyboard path does not go through it.

- **Every search flow has a list-only fallback view** that reaches the same data
  and is the canonical target for keyboard and screen-reader users. It is a real
  view with a real URL, not a hidden div — it is announced in the search header
  and toggleable by anyone.
- Full tab order through: office field → radius → filters → sort → each result
  card → detail. Focus visible everywhere, `water` at 2px with a 2px offset.
- Result cards are `<a>` elements. Selecting one moves focus into the detail
  panel and returns it to the card on close.
- The map is `aria-hidden` with its markers exposed through the list instead.
  One canonical representation of the results, and the accessible one is not the
  degraded one.
- Live regions announce the result count after a filter change, once, debounced.

## The quality floor

Not announced in the UI, but non-negotiable:

- responsive to 360px, and the mobile layout is a different composition rather
  than the desktop one squeezed;
- visible keyboard focus on every interactive element;
- `prefers-reduced-motion` respected everywhere;
- contrast at least 4.5:1 for text and 3:1 for UI, in **both** themes — `signal`
  on `paper` is checked at every size it is used;
- no layout shift after fonts load (`font-display: swap` with matched fallback
  metrics).

## Dev-only

Seeded photographs come from Unsplash, and the listing gallery carries a small
dev-only credit line pointing at [attribution.md](attribution.md). It is gated on
`import.meta.env.DEV` and never ships.
