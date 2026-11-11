// Route planning: decides which choice points matter for a trip, prices every combination of
// their alternatives, and ranks the results. No network or browser code lives here; the caller
// supplies `computeRoute`.

import { angleDiff, bearing, distanceToPath, haversine } from './geo.js';

const toPoint = ([lat, lng]) => ({ lat, lng });

/** 'forward' when the trip heads roughly along the choice point's bearing, otherwise 'reverse'. */
export function pickDirection(choicePoint, tripBearing) {
  return angleDiff(choicePoint.bearing, tripBearing) <= 90 ? 'forward' : 'reverse';
}

/** The alternatives of a choice point that have pass-through points for this direction. */
function alternativesFor(choicePoint, direction) {
  return choicePoint.alternatives
    .filter((alt) => alt[direction]?.length > 0)
    .map((alt) => ({
      choicePoint: choicePoint.name,
      name: alt.name,
      penaltyMinutes: alt.penaltyMinutes ?? 0,
      standalone: alt.standalone === true,
      isDefault: alt.default === true,
      vias: alt[direction].map(toPoint),
    }));
}

/**
 * True when the path passes close to any alternative of the choice point, somewhere ahead.
 * A point whose closest approach is the trip's own starting position has already been driven
 * past, so it does not count.
 */
export function isTriggered(alternatives, path, radiusM, origin) {
  return alternatives.some((alt) =>
    alt.vias.some((via) => {
      const distance = distanceToPath(via, path);
      const fromOrigin = haversine(origin, via);
      return distance <= radiusM && (fromOrigin > radiusM || distance < 0.8 * fromOrigin);
    }),
  );
}

/** One group of alternatives per choice point, oriented for the trip's direction of travel. */
export function orientChoicePoints(choicePoints, tripBearing, triggerRadiusM) {
  return choicePoints
    .map((cp) => ({
      name: cp.name,
      radiusM: cp.triggerRadiusM ?? triggerRadiusM,
      alternatives: alternativesFor(cp, pickDirection(cp, tripBearing)),
    }))
    .filter((group) => group.alternatives.length > 0);
}

/** Sort order for choice points: the way the trip meets them. */
export function byDistanceFrom(origin) {
  return (a, b) =>
    haversine(origin, a.alternatives[0].vias[0]) - haversine(origin, b.alternatives[0].vias[0]);
}

/** Every way of picking one alternative from each group. */
export function combinations(groups) {
  return groups.reduce(
    (partial, group) => partial.flatMap((picked) => group.map((alt) => [...picked, alt])),
    [[]],
  );
}

/**
 * @param {object} options
 * @param {Array} options.choicePoints  entries from choice-points.json
 * @param {(vias: {lat:number,lng:number}[], label: string) => Promise<{durationS:number, distanceM:number, path:{lat:number,lng:number}[]}>} options.computeRoute
 * @param {number} [options.triggerRadiusM]  how close a route must pass to a choice point for it to count
 * @param {number} [options.maxRoutes]  upper limit on priced routes per plan
 */
export async function plan({ choicePoints, computeRoute, triggerRadiusM = 2000, maxRoutes = 16 }) {
  const baseline = await computeRoute([], "Google's own route");
  const origin = baseline.path[0];
  const destination = baseline.path[baseline.path.length - 1];
  const tripBearing = bearing(origin, destination);

  const pending = orientChoicePoints(choicePoints, tripBearing, triggerRadiusM);
  const active = [];

  const activateTriggered = (path) => {
    let added = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (isTriggered(pending[i].alternatives, path, pending[i].radiusM, origin)) {
        active.push(...pending.splice(i, 1));
        added = true;
      }
    }
    return added;
  };

  const priced = new Map(); // combination key -> candidate
  let pricedCount = 1; // the baseline
  let truncated = false;
  let candidates = [];

  activateTriggered(baseline.path);

  // Pricing a combination can reveal a choice point the baseline never went near (for example
  // the New Jersey side only shows up once a route crosses the Cuomo Bridge), so repeat until
  // no new choice points appear.
  while (active.length > 0) {
    // Order the choice points the way the trip meets them.
    active.sort(byDistanceFrom(origin));
    const selections = combinations(active.map((group) => group.alternatives));
    const keyOf = (selection) => selection.map((alt) => `${alt.choicePoint}=${alt.name}`).join('|');

    let unpriced = selections.filter((selection) => !priced.has(keyOf(selection)));
    if (unpriced.length > maxRoutes - pricedCount) {
      unpriced = unpriced.slice(0, Math.max(0, maxRoutes - pricedCount));
      truncated = true;
    }
    pricedCount += unpriced.length;

    await Promise.all(
      unpriced.map(async (selection) => {
        const candidate = {
          name: selection.map((alt) => alt.name).join(' → '),
          selection,
          vias: selection.flatMap((alt) => alt.vias),
          penaltyMinutes: selection.reduce((sum, alt) => sum + alt.penaltyMinutes, 0),
        };
        try {
          Object.assign(candidate, await computeRoute(candidate.vias, candidate.name));
          candidate.scoreS = candidate.durationS + candidate.penaltyMinutes * 60;
        } catch (error) {
          candidate.error = error.message;
        }
        priced.set(keyOf(selection), candidate);
      }),
    );

    candidates = selections.map((selection) => priced.get(keyOf(selection))).filter(Boolean);
    if (truncated) break;
    const newChoicePoint = candidates
      .filter((candidate) => !candidate.error)
      .map((candidate) => activateTriggered(candidate.path))
      .some(Boolean);
    if (!newChoicePoint) break;
  }

  const usable = candidates.filter((candidate) => !candidate.error);
  usable.sort((a, b) => a.scoreS - b.scoreS);
  for (const candidate of usable) {
    // A candidate that follows the same roads as the unconstrained route is "what Google would do".
    candidate.matchesBaseline = candidate.vias.every((via) => distanceToPath(via, baseline.path) <= 150);
  }

  return {
    baseline,
    candidates: usable,
    failed: candidates.filter((candidate) => candidate.error),
    recommended: usable[0] ?? null,
    fastestS: Math.min(baseline.durationS, ...usable.map((candidate) => candidate.durationS)),
    choicePointNames: active.map((group) => group.name),
    truncated,
  };
}
