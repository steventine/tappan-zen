// Calls to Google: Routes API for traffic-aware ETAs, Places API for destination search,
// and Google Maps links for handing the chosen route to the Maps app.
//
// A "place" is { label, placeId?, latLng? }. With neither placeId nor latLng, the label is
// sent to Google as a free-text address.

import { decodePolyline } from './geo.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const ROUTING_PREFERENCE = 'TRAFFIC_AWARE_OPTIMAL';

function toWaypoint(place) {
  if (place.latLng) {
    return { location: { latLng: { latitude: place.latLng.lat, longitude: place.latLng.lng } } };
  }
  if (place.placeId) return { placeId: place.placeId };
  return { address: place.label };
}

const listeners = [];

/** Registers a callback that receives a record of every Google API call made from this page. */
export function onApiCall(listener) {
  listeners.push(listener);
}

async function post(api, label, url, apiKey, body, fieldMask) {
  const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  const record = { api, label, url, fieldMask, request: body, startedAt: new Date() };
  const started = performance.now();
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    record.status = response.status;
    record.response = data;
    if (!response.ok) {
      throw new Error(data.error?.message ?? `Google returned HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    record.error = error.message;
    throw error;
  } finally {
    record.ms = Math.round(performance.now() - started);
    for (const listener of listeners) listener(record);
  }
}

/** Prices one route through the given pass-through points with live traffic. */
export async function computeRoute(apiKey, origin, destination, vias, label) {
  const data = await post(
    'routes',
    label,
    ROUTES_URL,
    apiKey,
    {
      origin: toWaypoint(origin),
      destination: toWaypoint(destination),
      intermediates: vias.map((via) => ({
        via: true,
        location: { latLng: { latitude: via.lat, longitude: via.lng } },
      })),
      travelMode: 'DRIVE',
      routingPreference: ROUTING_PREFERENCE,
    },
    'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
  );
  const route = data.routes?.[0];
  if (!route) throw new Error('Google found no route');
  return {
    durationS: parseInt(route.duration, 10), // arrives as e.g. "8040s"
    distanceM: route.distanceMeters,
    path: decodePolyline(route.polyline.encodedPolyline),
  };
}

/** Destination search suggestions: [{ label, placeId }]. */
export async function autocomplete(apiKey, input) {
  const data = await post('autocomplete', input, AUTOCOMPLETE_URL, apiKey, { input });
  return (data.suggestions ?? [])
    .filter((suggestion) => suggestion.placePrediction)
    .map(({ placePrediction }) => ({
      label: placePrediction.text.text,
      placeId: placePrediction.placeId,
    }));
}

/**
 * A Google Maps link for the route. Leaving the origin out makes Maps start from the
 * device's current location, which is what turn-by-turn navigation needs.
 */
export function mapsLink({ origin, destination, vias, navigate }) {
  const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
  const setPlace = (name, place) => {
    params.set(name, place.latLng ? `${place.latLng.lat},${place.latLng.lng}` : place.label);
    if (place.placeId) params.set(`${name}_place_id`, place.placeId);
  };
  if (origin) setPlace('origin', origin);
  setPlace('destination', destination);
  if (vias.length > 0) params.set('waypoints', vias.map((via) => `${via.lat},${via.lng}`).join('|'));
  if (navigate) params.set('dir_action', 'navigate');
  return `https://www.google.com/maps/dir/?${params}`;
}
