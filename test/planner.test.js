import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodePolyline, distanceToPath } from '../src/geo.js';
import { combinations, pickDirection, plan } from '../src/planner.js';

test('decodePolyline decodes the reference example', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('distanceToPath measures to the segment, not just the vertices', () => {
  const path = [{ lat: 41, lng: -74 }, { lat: 41, lng: -73 }];
  const distance = distanceToPath({ lat: 41.01, lng: -73.5 }, path);
  assert.ok(Math.abs(distance - 1112) < 5, `expected about 1112 m, got ${distance}`);
});

test('pickDirection follows the trip bearing', () => {
  assert.equal(pickDirection({ bearing: 225 }, 200), 'forward');
  assert.equal(pickDirection({ bearing: 225 }, 30), 'reverse');
});

test('combinations picks one alternative per group', () => {
  assert.deepEqual(combinations([['a', 'b'], ['x', 'y', 'z']]).length, 6);
  assert.deepEqual(combinations([]), [[]]);
});

// A toy world heading west along latitude 41. The "crossing" choice point is on the direct
// line; the "far side" choice point lies on the way from the bridge and is never reached via the city.
const ORIGIN = { lat: 41, lng: -73 };
const DESTINATION = { lat: 41, lng: -75 };
const choicePoints = [
  {
    name: 'Far side',
    bearing: 270,
    alternatives: [
      { name: 'Parkway', penaltyMinutes: 0, forward: [[41.15, -74.5]], reverse: [[41.15, -74.5]] },
      { name: 'Interstate', penaltyMinutes: 5, forward: [[41.16, -74.5]], reverse: [[41.16, -74.5]] },
    ],
  },
  {
    name: 'Crossing',
    bearing: 270,
    alternatives: [
      { name: 'Bridge', penaltyMinutes: 0, forward: [[41.3, -74]], reverse: [[41.3, -74.01]] },
      { name: 'City', penaltyMinutes: 30, forward: [[41, -74]], reverse: [[41, -74.01]] },
    ],
  },
];

function fakeRoutes(durationFor) {
  const calls = [];
  const computeRoute = async (vias) => {
    calls.push(vias);
    const path = [ORIGIN, ...vias, DESTINATION];
    return { durationS: durationFor(vias), distanceM: 100000, path };
  };
  return { calls, computeRoute };
}

const viaCity = (vias) => vias.some((via) => via.lat === 41);

test('plan discovers a choice point that only appears on an alternative route', async () => {
  const { calls, computeRoute } = fakeRoutes((vias) => (viaCity(vias) ? 7000 : 7200));
  const result = await plan({ choicePoints, computeRoute });

  assert.deepEqual(result.choicePointNames, ['Crossing', 'Far side']);
  assert.equal(result.candidates.length, 4);
  // 1 baseline + 2 crossing-only routes + 4 full combinations
  assert.equal(calls.length, 7);
  // City is 200 s faster but carries a 30 minute penalty, so the bridge wins.
  assert.equal(result.recommended.name, 'Bridge → Parkway');
  assert.equal(result.fastestS, 7000);
});

test('plan recommends the penalised route once it saves more than the penalty', async () => {
  const { computeRoute } = fakeRoutes((vias) => (viaCity(vias) ? 7000 : 9000));
  const result = await plan({ choicePoints, computeRoute });
  assert.equal(result.recommended.name, 'City → Parkway');
});

test('plan returns only the baseline when no choice point is on the way', async () => {
  const { calls, computeRoute } = fakeRoutes(() => 3600);
  const elsewhere = [{ ...choicePoints[1], alternatives: [{ name: 'Far', forward: [[45, -74]] }] }];
  const result = await plan({ choicePoints: elsewhere, computeRoute });
  assert.equal(calls.length, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.recommended, null);
});

test('plan stops at maxRoutes and says so', async () => {
  const { calls, computeRoute } = fakeRoutes(() => 7000);
  const result = await plan({ choicePoints, computeRoute, maxRoutes: 4 });
  assert.equal(calls.length, 4);
  assert.equal(result.truncated, true);
});

test('plan keeps going when one combination has no route', async () => {
  const computeRoute = async (vias) => {
    if (viaCity(vias)) throw new Error('no route');
    return { durationS: 7200, distanceM: 1, path: [ORIGIN, ...vias, DESTINATION] };
  };
  const result = await plan({ choicePoints: [choicePoints[1]], computeRoute });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.recommended.name, 'Bridge');
});
