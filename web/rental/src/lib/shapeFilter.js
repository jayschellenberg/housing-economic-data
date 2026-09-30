/*
 * shapeFilter.js — the pure half of the draw-a-shape area filter, ported
 * from the parcel search (lib/shapeFilter.js) with the same Matrix-MLS
 * include/exclude semantics. Geometry predicates and ring builders only;
 * the drawing state machine and the map layers live in ../drawShapes.js.
 *
 * A shape is one of:
 *   { id, kind: 'circle',    mode, center: {lng, lat}, radiusKm }
 *   { id, kind: 'rectangle', mode, ring: [[lng,lat], ...] }
 *   { id, kind: 'polygon',   mode, ring: [[lng,lat], ...] }
 * where `mode` is 'include' | 'exclude'. Membership is tested against the
 * listing's point; circles by great-circle distance to the centre.
 */

import { haversineKm } from './filters.js';

/** Ray-casting point-in-ring. `ring` is [[lng, lat], ...], open or closed. */
export function pointInRing(pt, ring) {
  if (!pt || !Array.isArray(ring) || ring.length < 3) return false;
  const x = pt.lng, y = pt.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInShape(pt, shape) {
  if (!pt || !shape) return false;
  if (shape.kind === 'circle') {
    if (!shape.center || !Number.isFinite(shape.radiusKm)) return false;
    return haversineKm(pt.lat, pt.lng, shape.center.lat, shape.center.lng) <= shape.radiusKm;
  }
  return pointInRing(pt, shape.ring);
}

/**
 * No shapes → everything passes. Inside ANY exclude → dropped. With an
 * include shape present, the point must be inside one; with only
 * excludes, everything outside them passes. An unplaceable point fails
 * once any shape exists.
 */
export function passesShapeFilter(pt, shapes) {
  if (!Array.isArray(shapes) || shapes.length === 0) return true;
  if (!pt) return false;
  let hasInclude = false, inInclude = false;
  for (const s of shapes) {
    const inside = pointInShape(pt, s);
    if (s.mode === 'exclude') {
      if (inside) return false;
    } else {
      hasInclude = true;
      if (inside) inInclude = true;
    }
  }
  return hasInclude ? inInclude : true;
}

/** Display ring for a circle (the filter itself never reads it). */
export function circleRing(center, radiusKm, steps = 64) {
  const out = [];
  const latRad = (center.lat * Math.PI) / 180;
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.320 * Math.cos(latRad));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    out.push([center.lng + dLng * Math.cos(t), center.lat + dLat * Math.sin(t)]);
  }
  return out;
}

/** Closed 5-vertex ring from two opposite corners. */
export function rectRing(a, b) {
  return [[a.lng, a.lat], [b.lng, a.lat], [b.lng, b.lat], [a.lng, b.lat], [a.lng, a.lat]];
}

function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return ring || [];
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

export function formatKm(km) {
  if (!Number.isFinite(km) || km < 0) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(2)} km`;
}

function labelPoint(s) {
  if (s.kind === 'circle') return [s.center.lng, s.center.lat];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of s.ring || []) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Render FeatureCollection: one Polygon per shape (fill/outline) plus one
 * Point at its label anchor (the clickable centre dot + mode badge).
 */
export function shapesToFc(shapes) {
  const features = [];
  for (const s of shapes || []) {
    features.push({
      type: 'Feature',
      properties: { id: s.id, mode: s.mode, kind: s.kind },
      geometry: { type: 'Polygon', coordinates: [s.kind === 'circle' ? circleRing(s.center, s.radiusKm) : closeRing(s.ring)] },
    });
    const modeWord = s.mode === 'exclude' ? 'Exclude' : 'Include';
    features.push({
      type: 'Feature',
      properties: { id: s.id, mode: s.mode, kind: s.kind, label: s.kind === 'circle' ? `${modeWord} · ${formatKm(s.radiusKm)}` : modeWord },
      geometry: { type: 'Point', coordinates: labelPoint(s) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Validate shapes coming back from storage (localStorage is data).
 * Drops anything malformed; renumbers ids so they stay unique.
 */
export function normalizeShapes(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  let id = 1;
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const mode = s.mode === 'exclude' ? 'exclude' : 'include';
    if (s.kind === 'circle') {
      const lat = num(s.center?.lat), lng = num(s.center?.lng), r = num(s.radiusKm);
      if (lat == null || lng == null || r == null || r <= 0) continue;
      out.push({ id: id++, kind: 'circle', mode, center: { lat, lng }, radiusKm: r });
    } else if (s.kind === 'rectangle' || s.kind === 'polygon') {
      const ring = Array.isArray(s.ring)
        ? s.ring.map((p) => [num(p?.[0]), num(p?.[1])]).filter((p) => p[0] != null && p[1] != null)
        : [];
      if (ring.length < 3) continue;
      out.push({ id: id++, kind: s.kind, mode, ring });
    }
  }
  return out;
}
