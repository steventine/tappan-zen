# Route Chooser

Compares live-traffic ETAs for the routes *you* prefer (Cuomo Bridge, Palisades, Saw Mill, ...)
against the one Google Maps insists on, then opens Google Maps navigation on the route you tap.

## Run it

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Open <http://localhost:8765>, paste a Google API key under **Settings**, and compare.
The key and saved places are stored only in that browser.

The key needs the **Routes API** enabled. The **Places API (New)** is optional: it powers the
search suggestions, and without it a typed address still works.

## Choice points

`choice-points.json` lists the places where two or more roads do the same job.

| Field | Meaning |
|---|---|
| `bearing` | Compass direction of travel that counts as "forward" for this choice point. |
| `alternatives[].forward` / `reverse` | Pass-through points as `[lat, lng]`, in driving order, on the correct side of the highway for that direction. |
| `alternatives[].penaltyMinutes` | How many minutes this road must save before it is recommended over the others. |
| `triggerRadiusM` | How close a route must pass to a choice point for it to be considered. |
| `maxRoutes` | Upper limit on routes priced per comparison (each one is a billed Routes API call). |
| `alternatives[].default` | `true` for the road that is part of your plan until you select a different one. Without it, the lowest-penalty road is used. |
| `alternatives[].standalone` | `true` for a road that is a complete route on its own (driving through NYC). It is priced once with only its own pass-through points and never combined with other choice points. |

A choice point is only considered when Google's own route, or a route already being priced,
passes near it ahead of the starting position. The lowest `travel time + penalties` is recommended.

## How routes are priced

One reference route is priced (your plan: the `default` road at each choice point until you
select a different one), plus one variation per other alternative. Other combinations are
estimated by adding up the per-fork differences and marked with ≈; an estimated winner is
confirmed with one real call. That is roughly `2 + number of alternatives` calls per compare.

## Tests

```bash
node --test
```
