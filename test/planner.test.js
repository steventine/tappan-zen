import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodePolyline, distanceToPath } from '../src/geo.js';
import { combinations, pickDirection } from '../src/planner.js';

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
