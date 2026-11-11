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

A choice point is only considered when Google's own route, or one of the alternatives already
being priced, passes near it. Every combination of the relevant alternatives is priced, and the
lowest `travel time + penalties` is recommended.

## Tests

```bash
node --test
```
