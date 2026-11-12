import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planForks } from '../src/forks.js';
import { isOnTheWay, isTriggered } from '../src/planner.js';

// A toy world heading west along latitude 41. Google's own route goes through the City.
// "Approach" comes first, then "Crossing" (Bridge, or the standalone City), and the "Far side"
// fork only appears on routes that use the Bridge.
const ORIGIN = { lat: 41.2, lng: -73 };
const DESTINATION = { lat: 41, lng: -75 };
const P = {
  north: [41.3, -73.5],
  south: [41.2, -73.5],
  bridge: [41.3, -74],
  city: [41, -74],
  parkway: [41.15, -74.5],
  interstate: [41.16, -74.5],
};
const one = (point) => ({ forward: [point], reverse: [point] });
const choicePoints = [
  {
    name: 'Far side',
    bearing: 270,
    alternatives: [
      { name: 'Parkway', penaltyMinutes: 0, ...one(P.parkway) },
      { name: 'Interstate', penaltyMinutes: 3, ...one(P.interstate) },
    ],
  },
  {
    name: 'Crossing',
    bearing: 270,
    alternatives: [
      { name: 'Bridge', penaltyMinutes: 0, ...one(P.bridge) },
      { name: 'City', penaltyMinutes: 30, standalone: true, ...one(P.city) },
    ],
  },
  {
    name: 'Approach',
    bearing: 270,
    alternatives: [
      { name: 'South road', penaltyMinutes: 0, ...one(P.south) },
      { name: 'North road', penaltyMinutes: 0, ...one(P.north) },
    ],
  },
];

/** Durations are a base plus a cost for each pass-through point used. */
function fakeRoutes(costs) {
  const calls = [];
  const computeRoute = async (vias, label) => {
    calls.push(label);
    const used = (point) => vias.some((via) => via.lat === point[0] && via.lng === point[1]);
    const mid = vias.length ? vias : [{ lat: P.south[0], lng: P.south[1] }, { lat: P.city[0], lng: P.city[1] }];
    const durationS = 7000 + Object.entries(costs).reduce((sum, [name, cost]) => sum + (used(P[name]) ? cost : 0), 0);
    return { durationS, distanceM: 100000, path: [ORIGIN, ...mid, DESTINATION] };
  };
  return { calls, computeRoute };
}

test('prices one variation per alternative instead of every combination', async () => {
  const { calls, computeRoute } = fakeRoutes({ north: 300, interstate: 120, city: -200 });
  const result = await planForks({ onTheWayRatio: 0, choicePoints, computeRoute });

  assert.deepEqual(result.forks.map((fork) => fork.name), ['Approach', 'Crossing', 'Far side']);
  // baseline, reference before and after the Far side fork appears, North road, Interstate, City
  assert.equal(calls.length, 6);
  assert.equal(result.calls, 6);
  // 2 x 1 x 2 combinable routes plus the standalone City
  assert.equal(result.routes.length, 5);
  assert.equal(result.recommended.name, 'South road → Bridge → Parkway');
  assert.equal(result.planRoute, result.recommended);

  const both = result.routes.find((route) => route.name === 'North road → Bridge → Interstate');
  assert.equal(both.estimated, true);
  assert.equal(both.durationS, 7000 + 300 + 120);
});

test('a standalone alternative is priced alone and wins only beyond its penalty', async () => {
  const mild = await planForks({ onTheWayRatio: 0, choicePoints, ...fakeRoutes({ city: -1000 }) });
  assert.equal(mild.recommended.name, 'South road → Bridge → Parkway');

  const { calls, computeRoute } = fakeRoutes({ city: -2000 });
  const severe = await planForks({ onTheWayRatio: 0, choicePoints, computeRoute });
  assert.equal(severe.recommended.name, 'City');
  assert.equal(severe.recommended.vias.length, 1);
  assert.ok(calls.includes('City'));
});

test('an estimated winner is confirmed with a real call', async () => {
  const { calls, computeRoute } = fakeRoutes({ south: 600, parkway: 600 });
  const result = await planForks({ onTheWayRatio: 0, choicePoints, computeRoute });
  assert.equal(result.recommended.name, 'North road → Bridge → Interstate');
  assert.equal(result.recommended.estimated, false);
  assert.equal(calls.length, 7);
});

test('the driver\'s plan becomes the reference route', async () => {
  const { computeRoute } = fakeRoutes({ north: 60 });
  const result = await planForks({ onTheWayRatio: 0, choicePoints, computeRoute, plan: { Approach: 'North road' } });
  assert.equal(result.planRoute.name, 'North road → Bridge → Parkway');
  // South road is a minute faster with the same penalty, so a switch is suggested.
  assert.equal(result.recommended.name, 'South road → Bridge → Parkway');
});

test('an alternative marked default is the reference even with a higher penalty', async () => {
  const withDefault = structuredClone(choicePoints);
  withDefault[0].alternatives[1].default = true; // Interstate, penalty 3
  const { computeRoute } = fakeRoutes({});
  const result = await planForks({ onTheWayRatio: 0, choicePoints: withDefault, computeRoute });
  assert.equal(result.planRoute.name, 'South road → Bridge → Interstate');
  // The driver's own pick still wins over the default.
  const picked = await planForks({ onTheWayRatio: 0, choicePoints: withDefault, computeRoute, plan: { 'Far side': 'Parkway' } });
  assert.equal(picked.planRoute.name, 'South road → Bridge → Parkway');
});

test('each fork lists the best route through each alternative', async () => {
  const { computeRoute } = fakeRoutes({ north: 300, interstate: 120 });
  const result = await planForks({ onTheWayRatio: 0, choicePoints, computeRoute });
  const approach = result.forks[0];
  assert.deepEqual(approach.tiles.map((tile) => [tile.name, tile.route.name, tile.recommended]), [
    ['South road', 'South road → Bridge → Parkway', true],
    ['North road', 'North road → Bridge → Parkway', false],
  ]);
});

test('no forks on the way returns only the baseline', async () => {
  const { calls, computeRoute } = fakeRoutes({});
  const result = await planForks({ onTheWayRatio: 0, choicePoints: [], computeRoute });
  assert.equal(calls.length, 1);
  assert.equal(result.recommended, null);
  assert.deepEqual(result.forks, []);
});

test('a point just behind the starting position does not trigger', () => {
  const road = [{ lat: 41, lng: -74 }, { lat: 41, lng: -75 }]; // heading west from -74
  const alternatives = (lng) => [{ vias: [{ lat: 41, lng }] }];
  assert.equal(isTriggered(alternatives(-74.01), road, 2000, road[0]), true); // 840 m ahead
  assert.equal(isTriggered(alternatives(-73.99), road, 2000, road[0]), false); // 840 m behind
});

test('a fork between start and destination shows up even when no priced route passes it', async () => {
  // 5 km north of the City road and far from the Bridge road: no route drives past it.
  const sideRoads = {
    name: 'Side roads',
    bearing: 270,
    alternatives: [
      { name: 'Upper', penaltyMinutes: 0, ...one([41.05, -74.2]) },
      { name: 'Lower', penaltyMinutes: 0, ...one([41.06, -74.2]) },
    ],
  };
  const onlyByPath = await planForks({ onTheWayRatio: 0, choicePoints: [sideRoads], ...fakeRoutes({}) });
  assert.deepEqual(onlyByPath.forks, []);

  const byGeography = await planForks({ choicePoints: [sideRoads], ...fakeRoutes({}) });
  assert.deepEqual(byGeography.forks.map((fork) => fork.name), ['Side roads']);
});

test('isOnTheWay rejects points that are behind the start or a long way off the line', () => {
  const origin = { lat: 41, lng: -74 };
  const destination = { lat: 41, lng: -75 };
  const at = (lat, lng) => [{ vias: [{ lat, lng }] }];
  assert.equal(isOnTheWay(at(41.02, -74.5), origin, destination, 1.15), true); // between the two
  assert.equal(isOnTheWay(at(41, -73.95), origin, destination, 1.15), false); // behind the start
  assert.equal(isOnTheWay(at(41.5, -74.5), origin, destination, 1.15), false); // big detour north
});
