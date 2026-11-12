// "One fork at a time" planning. Instead of pricing every combination of alternatives, it
// prices one reference route (the current plan) and then one variation per other alternative,
// holding the rest of the route at the reference. Roads that merge again before the next fork
// make each fork's time difference independent of the others, so any combination's time is the
// reference plus the differences of the alternatives it swaps in.
//
// An alternative marked `standalone` (driving through NYC, say) does not combine with other
// forks: it is priced once as a complete route with only its own pass-through points.

import { bearing, distanceToPath } from './geo.js';
import { byDistanceFrom, combinations, isOnTheWay, isTriggered, orientChoicePoints } from './planner.js';

const keyOf = (selection) => selection.map((alt) => `${alt.choicePoint}=${alt.name}`).join('|');

/**
 * @param {object} options
 * @param {Array} options.choicePoints  entries from choice-points.json
 * @param {(vias: {lat:number,lng:number}[], label: string) => Promise<{durationS:number, distanceM:number, path:{lat:number,lng:number}[]}>} options.computeRoute
 * @param {Record<string,string>} [options.plan]  choice point name -> alternative the driver last chose
 * @param {number} [options.triggerRadiusM]
 * @param {number} [options.onTheWayRatio]  how much longer than the straight line a trip via a fork may be for the fork to count as on the way (0 turns this off)
 * @param {number} [options.maxRoutes]  upper limit on priced routes per plan
 */
export async function planForks({
  choicePoints,
  computeRoute,
  plan = {},
  triggerRadiusM = 2000,
  onTheWayRatio = 1.15,
  maxRoutes = 16,
}) {
  const baseline = await computeRoute([], "Google's own route");
  const origin = baseline.path[0];
  const destination = baseline.path[baseline.path.length - 1];

  const pending = orientChoicePoints(choicePoints, bearing(origin, destination), triggerRadiusM, onTheWayRatio);
  const forks = [];
  const activateTriggered = (path) => {
    let added = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const group = pending[i];
      // A fork counts when a priced route drives past it, or when it simply lies on the way.
      if (
        isTriggered(group.alternatives, path, group.radiusM, origin) ||
        isOnTheWay(group.alternatives, origin, destination, group.onTheWayRatio)
      ) {
        forks.push(...pending.splice(i, 1));
        added = true;
      }
    }
    forks.sort(byDistanceFrom(origin));
    return added;
  };

  // ----- pricing, with each distinct route requested at most once -----
  const requests = new Map(); // key -> Promise<route>
  let calls = 1; // the baseline
  let truncated = false;
  const price = (selection) => {
    const key = keyOf(selection);
    if (!requests.has(key)) {
      const route = {
        name: selection.map((alt) => alt.name).join(' → '),
        selection,
        vias: selection.flatMap((alt) => alt.vias),
        penaltyMinutes: selection.reduce((sum, alt) => sum + alt.penaltyMinutes, 0),
        estimated: false,
      };
      if (calls >= maxRoutes) {
        truncated = true;
        requests.set(key, Promise.resolve(Object.assign(route, { error: 'route limit reached' })));
      } else {
        calls++;
        requests.set(
          key,
          computeRoute(route.vias, route.name).then(
            (priced) => Object.assign(route, priced, { scoreS: priced.durationS + route.penaltyMinutes * 60 }),
            (error) => Object.assign(route, { error: error.message }),
          ),
        );
      }
    }
    return requests.get(key);
  };

  // ----- the reference route: the planned (or default) alternative at every fork -----
  const combinable = (fork) => fork.alternatives.filter((alt) => !alt.standalone);
  const referenceAlt = (fork) =>
    combinable(fork).find((alt) => alt.name === plan[fork.name]) ??
    combinable(fork).find((alt) => alt.isDefault) ??
    combinable(fork).reduce((best, alt) => (alt.penaltyMinutes < best.penaltyMinutes ? alt : best));
  const chain = () => forks.filter((fork) => combinable(fork).length > 0);

  activateTriggered(baseline.path);
  let reference = null;
  // The reference route can pass a fork the baseline never went near (the New Jersey side only
  // shows up after crossing the Cuomo Bridge), so repeat until no new forks appear.
  while (chain().length > 0) {
    reference = await price(chain().map(referenceAlt));
    if (reference.error) throw new Error(`Could not price ${reference.name}: ${reference.error}`);
    if (!activateTriggered(reference.path)) break;
  }

  // ----- one variation per non-reference alternative -----
  const variations = new Map(); // alternative -> route
  await Promise.all(
    forks.flatMap((fork) =>
      fork.alternatives.map(async (alt) => {
        if (alt.standalone) {
          variations.set(alt, await price([alt]));
        } else if (alt === referenceAlt(fork)) {
          variations.set(alt, reference);
        } else {
          variations.set(alt, await price(chain().map((f) => (f === fork ? alt : referenceAlt(f)))));
        }
      }),
    ),
  );
  const usable = (alt) => !variations.get(alt).error;
  const deltaS = (alt) => variations.get(alt).durationS - reference.durationS;

  // ----- every route: priced where we have it, estimated from the differences otherwise -----
  const results = new Map();
  for (const [key, request] of requests) results.set(key, await request);

  const buildRoutes = () => {
    const routes = [];
    if (reference) {
      for (const selection of combinations(chain().map((fork) => combinable(fork).filter(usable)))) {
        const priced = results.get(keyOf(selection));
        if (priced && !priced.error) {
          routes.push(priced);
          continue;
        }
        const penaltyMinutes = selection.reduce((sum, alt) => sum + alt.penaltyMinutes, 0);
        const durationS = reference.durationS + selection.reduce((sum, alt) => sum + deltaS(alt), 0);
        routes.push({
          name: selection.map((alt) => alt.name).join(' → '),
          selection,
          vias: selection.flatMap((alt) => alt.vias),
          penaltyMinutes,
          durationS,
          distanceM: null,
          scoreS: durationS + penaltyMinutes * 60,
          estimated: true,
        });
      }
    }
    for (const fork of forks) {
      for (const alt of fork.alternatives) {
        if (alt.standalone && usable(alt)) routes.push(variations.get(alt));
      }
    }
    return routes.sort((a, b) => a.scoreS - b.scoreS);
  };

  let routes = buildRoutes();
  // An estimated winner gets one real call so the recommendation never rests on arithmetic alone.
  if (routes[0]?.estimated) {
    const confirmed = await price(routes[0].selection);
    results.set(keyOf(confirmed.selection), confirmed);
    routes = buildRoutes();
  }

  for (const route of routes) {
    route.matchesBaseline =
      !route.estimated && route.vias.every((via) => distanceToPath(via, baseline.path) <= 150);
  }

  // ----- per-fork view: the best route available through each alternative -----
  const recommended = routes[0] ?? null;
  const forkViews = forks.map((fork) => ({
    name: fork.name,
    tiles: fork.alternatives
      .map((alt) => ({
        name: alt.name,
        penaltyMinutes: alt.penaltyMinutes,
        standalone: alt.standalone,
        route: routes.find((route) => route.selection.includes(alt)) ?? null, // routes are sorted best first
        recommended: recommended?.selection.includes(alt) ?? false,
      }))
      .filter((tile) => tile.route),
  }));

  const plannedStandalone = forks
    .flatMap((fork) => fork.alternatives)
    .find((alt) => alt.standalone && plan[alt.choicePoint] === alt.name && usable(alt));

  return {
    baseline,
    forks: forkViews,
    routes,
    recommended,
    reference,
    planRoute: plannedStandalone ? variations.get(plannedStandalone) : reference,
    fastestS: Math.min(baseline.durationS, ...routes.map((route) => route.durationS)),
    failed: [...results.values()].filter((route) => route.error),
    truncated,
    calls,
  };
}
