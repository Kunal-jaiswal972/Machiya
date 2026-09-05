# Why this is built the way it is

**Read this when** you are new here, or when a decision in `DECISIONS.md` looks
arbitrary and you want the argument it follows from.

Seventy-one entries record how every piece works. None of them records what the
thing is for. This is that, in the order a new reader needs it.

## The problem: rent is not what you pay

Someone in Patna has a job at a fixed address and is deciding where to live.
Every rental site in the country shows them a monthly rent, sorted by that rent,
filtered by area.

The rent is not the number they will pay.

Take a ₹14,000 flat 12 km from the office against a ₹17,000 flat they can walk
to. Driving, at the engine's default 15 km/l and Patna's scraped petrol price of
₹113.37, twelve kilometres each way twice a day for twenty-two days is **₹3,991
a month**. The cheap flat costs ₹17,991 and the dear one costs ₹17,000. The
cheaper flat is the more expensive one — before counting the hour a day it also
takes.

The margin matters, so here is where it goes:

| Distance | Car (15 km/l) | Scooter (45 km/l) |
| -------- | ------------- | ----------------- |
| 9 km     | ₹2,993        | ₹998              |
| 12 km    | ₹3,991        | ₹1,330            |

At 9 km by car the two flats above are within ₹10 of each other — a dead heat,
which is still a fact worth showing and is not what a rent-sorted list says. On
a scooter the cheap flat really is cheaper, and the product should say so rather
than pretend otherwise. **That is the point: the answer depends on numbers
nobody puts in front of you**, and it is hidden not by malice but because the
sort key is rent, and rent is the one cost the landlord happens to name.

(Those figures are `computeCommuteCost` run against the price the scrapers
actually hold, not an illustration. The same function computes what the UI
shows.)

So the product's single job is: **make total monthly cost — rent plus real
commute — comparable at a glance, anchored to one point on a map.**

Everything below follows from that sentence.

## Why office-first, not area-first

Every competitor starts with "which area are you looking in". That question
assumes the person already knows the answer, and it is exactly the answer they
came to find. Worse, it is the question that hides the arithmetic: choosing an
area first fixes the commute before any price is seen, so the trade-off the
product exists to surface never comes up.

Starting from the office inverts it. One point, a 3 km radius drawn as 1/2/3 km
rings, and every listing inside it priced against **that** point. The area is
the output, not the input.

Two consequences run through the whole codebase:

- **The map is not a feature; it is the axis.** The search is a `ST_DWithin`
  around one coordinate, and a listing has no meaning in this product without a
  point to measure it from. `GET /api/listings/search` refuses with 400
  `office_required` rather than returning everything, because an unanchored list
  would silently be the thing this product exists not to be.
- **Coverage is a hard frontier, and it is honest about itself.** Answering "no
  listings near you" for a city we do not serve would be a lie of the same
  family, so out-of-coverage is a distinct state with its own message and its
  own "tell me when you cover this" capture — which is also the only data that
  says where to expand (D52-D56, D71).

## Why total monthly cost is the sort that matters

The argument only lands if the number is honest, so three things are
non-negotiable:

1. **Distance is real road distance, from OSRM.** Never straight-line. A city
   with a river through it makes straight-line understate every commute, and a
   product claiming "this is your real commute" cannot be doing that.
   `ST_Distance` computes the rings and nothing else (D61).
2. **Fuel prices are scraped and attributed, and checked against the city the
   page names.** Two of the originally configured sources returned HTTP 200
   with a different city's price. No plausibility band catches that — both
   numbers are plausible — so the only defence is refusing a figure the page
   does not itself attach to this city (D62).
3. **The sort happens inside the SQL, over every candidate in the radius.**
   Re-sorting a page would show the cheapest of the 24 listings on screen rather
   than the cheapest of the 200 nearby — and the listing whose rent looks high
   until you price the commute is, by construction, the one a page-local sort
   buries. That inversion is the entire product (D64).

Where a number cannot be earned, it is labelled rather than invented: an OSRM
outage gives a straight-line estimate with `degraded: true` travelling all the
way to the sentence under it (D43), and a sale listing has no monthly total at
all because that would need an interest rate this product never asks for.

## Why the whole stack is self-hosted

Every dependency is free or self-hostable: Nominatim for geocoding, two OSRM
graphs for routing, Overpass for POIs, OpenFreeMap tiles, MapLibre, Better Auth,
MinIO, Postgres with PostGIS. No Google Maps, no Mapbox, no hosted auth, no paid
email SDK.

The obvious reading is cost, and that is the least interesting reason. Three
better ones:

- **A geo product whose core measurement is rate-limited is not a product.** The
  commute number is computed for every listing in every search. On a metered
  routing API that is the one call you cannot afford to make often, so the
  design would bend around the pricing page instead of around the user — and the
  total-cost sort, which needs a road distance for _every_ candidate, would be
  the first thing cut.
- **Borrowed infrastructure is infrastructure you cannot reason about.**
  Measured against public Overpass mirrors, the same query took 38 to 85 seconds
  depending on somebody else's queue, and one mirror answered 406 to every
  User-Agent but curl's. There is no version of that which is reliably fast, and
  no way to tell a slow answer from a broken one (D42, D48).
- **Consistency is a correctness property here, not tidiness.** Routing,
  geocoding and POIs all read from **one merged OSM extract**, so a hospital in
  the POI panel and a road in the route are the same vintage. When they came
  from different sources, a discrepancy was unfalsifiable — nobody could tell a
  data difference from a code bug. Every derived cache is keyed by a hash of
  those artifacts, so a rebuild makes stale answers unreachable rather than
  wrong (D46).

The cost of this is real and is not hidden: about 1 GB of OSM downloads, a long
first bootstrap, and a `geo` compose profile that has to be up before routing
works. `docs/adding-a-city.md` states where it stops scaling — OSRM graph RAM,
not download size.

## Why the supply side looks the way it does

A seeker with nothing to look at is not a product, so the lister side is not an
afterthought:

- **A seeker becomes a lister by publishing**, not by choosing a role at
  sign-up. The transition happens inside the publish transaction, so the role
  and the listing can never disagree.
- **A draft is genuinely incomplete in the database.** The wizard autosaves from
  its first step — a pin and nothing else — so the columns it fills later are
  nullable, with a CHECK making all of them NOT NULL the moment a listing stops
  being a draft. Writing placeholders instead would have meant every reader
  downstream disbelieving its own data (D67).
- **The pin is the fact and the typed address is a label.** Measured, Nominatim
  resolves a specific house number in these cities roughly one time in ten. So
  the product never prefills a street line it cannot know, and says out loud
  what it did resolve (D58, D59).
- **Contact details appear when a conversation exists**, decided server-side, so
  the number is absent from the payload rather than hidden by the client — and
  a lister who ends the conversation takes it back (D69).

## The habits, and why they are in the decisions log

Two rules produced most of what is in `DECISIONS.md`, and both were learned the
expensive way:

**Verify against the running thing, not the documentation.** A pinned
`--max-table-size` that bounds nothing we call. A `PUBLIC_NOMINATIM_URL` read by
no code. An admin plugin mounted, configured, and answering 403 to every
endpoint. Each of those read as correct in the config and was inert in fact
(D57, D61, D70).

**A number that renders is worse than no number.** A silently wrong fuel price,
a chart that means page loads while its caption says viewers, a `NaN` commute
cost from a missing mileage, a listing filed 120 km from where it is. Every one
of them is a plausible-looking answer, and a plausible-looking wrong answer is
harder to find than a blank space — so the codebase is full of places that
refuse, label, or return null instead.

If a change makes one of those two rules harder to follow, it is probably the
wrong change, whatever else it improves.
