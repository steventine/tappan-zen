// Small geometry helpers. Points are { lat, lng } in degrees.

const EARTH_RADIUS_M = 6371000;
const rad = (deg) => (deg * Math.PI) / 180;

/** Decodes a Google encoded polyline into an array of { lat, lng }. */
export function decodePolyline(encoded) {
  const path = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const readValue = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += readValue();
    lng += readValue();
    path.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return path;
}

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, 0-360 degrees. */
export function bearing(a, b) {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings, 0-180 degrees. */
export function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** Shortest distance in metres from a point to a path (checks whole segments, not just vertices). */
export function distanceToPath(point, path) {
  if (path.length === 0) return Infinity;
  // Flat-earth projection centred on the point; accurate enough at the few-km scale we care about.
  const kx = EARTH_RADIUS_M * rad(1) * Math.cos(rad(point.lat));
  const ky = EARTH_RADIUS_M * rad(1);
  const project = (p) => ({ x: (p.lng - point.lng) * kx, y: (p.lat - point.lat) * ky });

  let best = Infinity;
  let a = project(path[0]);
  if (path.length === 1) return Math.hypot(a.x, a.y);
  for (let i = 1; i < path.length; i++) {
    const b = project(path[i]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSq));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
    a = b;
  }
  return best;
}
