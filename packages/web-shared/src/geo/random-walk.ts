export interface GeoPoint {
  lng: number;
  lat: number;
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

// Nudge a position by a bounded random delta on each axis, mirroring
// scripts/stream-gps.sh. Pure: returns a new point, never mutates the input.
export function randomWalk(from: GeoPoint, stepDeg: number): GeoPoint {
  const dLng = (Math.random() * 2 - 1) * stepDeg;
  const dLat = (Math.random() * 2 - 1) * stepDeg;
  return {
    lng: clamp(from.lng + dLng, -180, 180),
    lat: clamp(from.lat + dLat, -90, 90),
  };
}
