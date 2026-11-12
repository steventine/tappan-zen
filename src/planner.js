// Choice point helpers shared by the route planner in forks.js: which direction a trip takes
// through a choice point, whether a route passes it, and how alternatives combine.

import { angleDiff, distanceToPath, haversine } from './geo.js';

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

/**
 * True when one of the alternatives lies roughly between the start and the destination: it is
 * closer to the destination than the start is (so not already behind), and driving via it adds
 * no more than `ratio` to the straight-line distance. This keeps a choice point on screen even
 * when today's traffic sends every priced route down some third road that passes none of its
 * points.
 */
export function isOnTheWay(alternatives, origin, destination, ratio) {
  const direct = haversine(origin, destination);
  return alternatives.some((alt) => {
    const via = alt.vias[0];
    const remaining = haversine(via, destination);
    return remaining < direct && haversine(origin, via) + remaining <= ratio * direct;
  });
}

/** One group of alternatives per choice point, oriented for the trip's direction of travel. */
export function orientChoicePoints(choicePoints, tripBearing, triggerRadiusM, onTheWayRatio) {
  return choicePoints
    .map((cp) => ({
      name: cp.name,
      radiusM: cp.triggerRadiusM ?? triggerRadiusM,
      onTheWayRatio: cp.onTheWayRatio ?? onTheWayRatio,
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
