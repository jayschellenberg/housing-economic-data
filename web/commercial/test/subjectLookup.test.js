/*
 * Placing a subject by typing where it is.
 *
 * All offline — the page promises nothing leaves the machine, so there is
 * no geocoder. Coordinates, Winnipeg's civic address points (shipped in the
 * folder), and every geocoded listing's own address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCoordinates, displayAddress, buildSubjectIndex, lookupSubject,
} from '../src/lib/subjectLookup.js';

const POINTS = [
  'address,lat,lon',
  '233 PORTAGE AVENUE,49.895100,-97.141200',
  '221 PORTAGE AVENUE,49.895000,-97.140900',
  '101 REGENT AVENUE W,49.900000,-97.100000',
  '101 REGENT AVENUE E,49.901000,-97.050000',
  '1353 DAWSON ROAD S,49.860000,-97.090000',
  '1076A MAIN STREET,49.930000,-97.120000',
  '1050 MAIN STREET,49.928000,-97.121000',
].join('\n');

const LISTINGS = [
  { address: '11 Sabrina Way', municipality: 'RM of Headingley', latitude: 49.87, longitude: -97.40 },
  { address: '11 Sabrina Way', municipality: 'RM of Headingley', latitude: 49.87, longitude: -97.40 },
  { address: '233 Portage Avenue', municipality: 'City of Winnipeg', latitude: 49.8952, longitude: -97.1413 },
  { address: 'The Forks', municipality: 'City of Winnipeg', latitude: 49.88, longitude: -97.13 },
  { address: '90 Bole Street', municipality: 'City of Winnipeg', latitude: null, longitude: null },
];

const index = () => buildSubjectIndex(POINTS, LISTINGS);
const labels = (q) => lookupSubject(q, index()).map((h) => h.label);

// ---------- coordinates ----------

test('a pasted coordinate pair is a place, in either order', () => {
  assert.deepEqual(parseCoordinates('49.8951, -97.1384'), { lat: 49.8951, lng: -97.1384 });
  /* GIS exports write longitude first. */
  assert.deepEqual(parseCoordinates('-97.1384, 49.8951'), { lat: 49.8951, lng: -97.1384 });
  assert.deepEqual(parseCoordinates('(49.8951 -97.1384)'), { lat: 49.8951, lng: -97.1384 });
});

test('a pair outside Manitoba is not a place the data can speak to', () => {
  assert.equal(parseCoordinates('40.7, -74.0'), null);
  assert.equal(parseCoordinates('233 Portage'), null, 'an address is not a coordinate');
  assert.equal(parseCoordinates(''), null);
});

// ---------- addresses ----------

test('an alias door finds its own point, not its parcel’s primary address', () => {
  /* 233 Portage is one of thirteen doors on the roll filed under 221. The
     subject belongs at the door that was typed. */
  const [hit] = lookupSubject('233 portage ave', index());
  assert.equal(hit.label, '233 Portage Avenue');
  assert.equal(hit.source, 'address');
});

test('a dropped street type or direction still resolves', () => {
  assert.deepEqual(labels('1353 Dawson Rd'), ['1353 Dawson Road S']);
  assert.deepEqual(labels('233 Portage'), ['233 Portage Avenue']);
});

test('a typed direction decides between two real properties', () => {
  /* 101 Regent W is a commercial block, 101 Regent E a restaurant. */
  assert.deepEqual(labels('101 Regent W'), ['101 Regent Avenue W']);
  assert.equal(labels('101 Regent').length, 2, 'without one, both are offered');
});

test('a civic number is exact, with a letter suffix allowed', () => {
  assert.deepEqual(labels('105 Main'), [], '105 is not 1050');
  assert.deepEqual(labels('1050 Main'), ['1050 Main Street']);
  assert.deepEqual(labels('1076 Main'), ['1076A Main Street']);
});

test('a place needs a number', () => {
  /* "Portage" is a street, not a subject, and would offer thousands. */
  assert.deepEqual(labels('portage'), []);
});

// ---------- listings ----------

test('outside Winnipeg a listing’s own address is the source', () => {
  const [hit] = lookupSubject('11 Sabrina Way', index());
  assert.equal(hit.source, 'listing');
  assert.equal(hit.where, 'RM of Headingley');
});

test('a listed address appears once however many records share it', () => {
  assert.equal(labels('11 Sabrina').length, 1);
});

test('the city’s point outranks a geocoded listing at the same door', () => {
  const hits = lookupSubject('233 Portage Avenue', index());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'address');
});

test('a listing with no coordinates or no number is not a place', () => {
  const idx = index();
  assert.equal(idx.listings, 2, '11 Sabrina Way and 233 Portage; not The Forks or ungeocoded Bole');
  assert.deepEqual(lookupSubject('90 Bole', idx), []);
});

test('a folder without the address points still resolves listings', () => {
  const idx = buildSubjectIndex('', LISTINGS);
  assert.equal(idx.points, 0);
  assert.equal(lookupSubject('11 Sabrina Way', idx)[0].source, 'listing');
});

// ---------- display ----------

test('an address point reads as an address', () => {
  assert.equal(displayAddress('233 PORTAGE AVENUE'), '233 Portage Avenue');
  assert.equal(displayAddress('1721 10TH STREET'), '1721 10th Street');
  assert.equal(displayAddress('55 NASSAU STREET N'), '55 Nassau Street N');
  assert.equal(displayAddress('1 LAKEVIEW DRIVE NE'), '1 Lakeview Drive NE');
  assert.equal(displayAddress('1076A MAIN STREET'), '1076A Main Street');
});
