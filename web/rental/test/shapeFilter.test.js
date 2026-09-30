import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInRing, pointInShape, passesShapeFilter, circleRing, rectRing, shapesToFc, normalizeShapes, formatKm,
} from '../src/lib/shapeFilter.js';

const square = [[-97.2, 49.8], [-97.0, 49.8], [-97.0, 50.0], [-97.2, 50.0]];   // open ring
const inside = { lng: -97.1, lat: 49.9 };
const outside = { lng: -96.5, lat: 49.9 };

test('pointInRing open and closed rings', () => {
  assert.equal(pointInRing(inside, square), true);
  assert.equal(pointInRing(outside, square), false);
  assert.equal(pointInRing(inside, [...square, square[0]]), true);
  assert.equal(pointInRing(inside, square.slice(0, 2)), false);
  assert.equal(pointInRing(null, square), false);
});

test('pointInShape circle uses great-circle distance', () => {
  const c = { kind: 'circle', mode: 'include', center: { lng: -97.1, lat: 49.9 }, radiusKm: 5 };
  assert.equal(pointInShape({ lng: -97.1, lat: 49.93 }, c), true);     // ~3.3 km north
  assert.equal(pointInShape({ lng: -97.1, lat: 49.96 }, c), false);    // ~6.7 km north
  assert.equal(pointInShape(inside, { kind: 'circle', mode: 'include', center: null, radiusKm: 1 }), false);
});

test('passesShapeFilter: include/exclude semantics', () => {
  const inc = { id: 1, kind: 'polygon', mode: 'include', ring: square };
  const exc = { id: 2, kind: 'rectangle', mode: 'exclude', ring: rectRing({ lng: -97.15, lat: 49.85 }, { lng: -97.05, lat: 49.95 }) };
  assert.equal(passesShapeFilter(inside, []), true);
  assert.equal(passesShapeFilter(null, []), true);
  assert.equal(passesShapeFilter(null, [inc]), false);
  assert.equal(passesShapeFilter(inside, [inc]), true);
  assert.equal(passesShapeFilter(outside, [inc]), false);
  assert.equal(passesShapeFilter(inside, [inc, exc]), false);           // exclude wins
  assert.equal(passesShapeFilter({ lng: -97.19, lat: 49.99 }, [inc, exc]), true);
  assert.equal(passesShapeFilter(outside, [exc]), true);                // only excludes: outside passes
});

test('rings, labels, feature collection, normalization', () => {
  assert.equal(circleRing({ lng: 0, lat: 0 }, 1).length, 65);
  assert.equal(rectRing({ lng: 0, lat: 0 }, { lng: 1, lat: 1 }).length, 5);
  assert.equal(formatKm(0.65), '650 m');
  assert.equal(formatKm(2.345), '2.35 km');
  const fc = shapesToFc([{ id: 1, kind: 'circle', mode: 'include', center: { lng: -97, lat: 50 }, radiusKm: 2 },
    { id: 2, kind: 'polygon', mode: 'exclude', ring: square }]);
  assert.equal(fc.features.length, 4);
  assert.equal(fc.features[1].properties.label, 'Include · 2.00 km');
  assert.equal(fc.features[3].properties.label, 'Exclude');
  assert.equal(fc.features[2].geometry.coordinates[0].length, 5);       // closed
  const norm = normalizeShapes([
    { kind: 'circle', mode: 'exclude', center: { lat: '49.9', lng: '-97.1' }, radiusKm: '2' },
    { kind: 'circle', center: { lat: 1 }, radiusKm: 2 },                 // bad
    { kind: 'polygon', mode: 'bogus', ring: [[1, 1], [2, 2], ['x', 3], [3, 1]] },
    { kind: 'polygon', ring: [[1, 1], [2, 2]] },                          // too short
    'junk',
  ]);
  assert.equal(norm.length, 2);
  assert.deepEqual(norm[0], { id: 1, kind: 'circle', mode: 'exclude', center: { lat: 49.9, lng: -97.1 }, radiusKm: 2 });
  assert.deepEqual(norm[1], { id: 2, kind: 'polygon', mode: 'include', ring: [[1, 1], [2, 2], [3, 1]] });
  assert.deepEqual(normalizeShapes('nope'), []);
});
