// Page wiring: reads the trip from the form, runs the planner, and draws the comparison.

import { autocomplete, computeRoute, mapsLink, onApiCall } from './google.js';
import { plan } from './planner.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(`routeChooser.${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`routeChooser.${key}`, JSON.stringify(value));
    } catch {
      // Private window or blocked storage: the setting just won't persist.
    }
  },
};

let apiKey = store.get('apiKey', '');
let savedPlaces = store.get('places', []); // [{ name, label, placeId? }]

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

// ---------- place fields (From and To share one design) ----------

const CURRENT_LOCATION = { label: 'Current location', isCurrentLocation: true };

/**
 * A search box with suggestions, a save button, and shortcut chips.
 * With `allowCurrentLocation`, an empty box means "where I am now".
 */
function createPlaceField(root, { title, allowCurrentLocation }) {
  let picked = null; // a suggestion or saved place; null means "use whatever is typed"
  let searchTimer;

  const inputId = `${root.id}-input`;
  const input = el('input', {
    id: inputId,
    type: 'search',
    autocomplete: 'off',
    placeholder: allowCurrentLocation
      ? 'Current location, or search for a place'
      : 'Search for a place or address',
  });
  const suggestions = el('ul', { className: 'suggestions', hidden: true });
  const chips = el('div', { className: 'chips' });
  const saveButton = el('button', { textContent: 'Save', title: 'Save this place as a shortcut' });

  root.className = 'place-field';
  root.append(
    el('label', { htmlFor: inputId, textContent: title }),
    el('div', { className: 'search' }, [input, saveButton, suggestions]),
    chips,
  );

  const value = () => {
    const typed = input.value.trim();
    if (picked) return picked;
    if (typed) return { label: typed };
    return allowCurrentLocation ? CURRENT_LOCATION : null;
  };

  const choose = (place) => {
    picked = place === CURRENT_LOCATION ? null : place;
    input.value = picked ? picked.label : '';
    suggestions.hidden = true;
    renderChips();
  };

  const chip = (text, place) =>
    el('button', { textContent: text, ariaPressed: String(value() === place), onclick: () => choose(place) });

  function renderChips() {
    chips.replaceChildren(
      ...(allowCurrentLocation ? [chip('Current location', CURRENT_LOCATION)] : []),
      ...savedPlaces.map((place) => chip(place.name, place)),
    );
  }

  input.addEventListener('input', () => {
    picked = null;
    renderChips();
    clearTimeout(searchTimer);
    const text = input.value.trim();
    if (!apiKey || text.length < 3) {
      suggestions.hidden = true;
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const found = await autocomplete(apiKey, text);
        suggestions.replaceChildren(
          ...found.map((place) => el('li', { textContent: place.label, onclick: () => choose(place) })),
        );
        suggestions.hidden = found.length === 0;
      } catch {
        suggestions.hidden = true; // Search is optional: the typed text still works as an address.
      }
    }, 250);
  });

  saveButton.onclick = () => {
    const place = value();
    if (!place || place.isCurrentLocation) return setStatus(`Enter a "${title}" place to save first.`, true);
    const name = prompt('Name for this shortcut (for example "Home" or "Newark Airport")');
    if (!name?.trim()) return;
    const saved = { name: name.trim(), label: place.label, placeId: place.placeId };
    savedPlaces.push(saved);
    store.set('places', savedPlaces);
    picked = saved;
    renderPlaces();
  };

  renderChips();
  return { value, renderChips };
}

const fromField = createPlaceField($('from-field'), { title: 'From', allowCurrentLocation: true });
const toField = createPlaceField($('to-field'), { title: 'To', allowCurrentLocation: false });

function renderPlaces() {
  fromField.renderChips();
  toField.renderChips();
  $('saved-places').replaceChildren(
    ...savedPlaces.map((place, i) =>
      el('li', {}, [
        el('span', { textContent: `${place.name}: ${place.label}` }),
        el('button', {
          textContent: 'Remove',
          onclick: () => {
            savedPlaces.splice(i, 1);
            store.set('places', savedPlaces);
            renderPlaces();
          },
        }),
      ]),
    ),
  );
}

/** Turns "Current location" into coordinates; other places pass through unchanged. */
function locate(place) {
  if (!place.isCurrentLocation) return Promise.resolve(place);
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ ...place, latLng: { lat: coords.latitude, lng: coords.longitude } }),
      () => reject(new Error('Could not get your current location. Allow location access or enter a From place.')),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

// ---------- comparison ----------

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function formatArrival(seconds) {
  return new Date(Date.now() + seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function routeCard({ title, tags, route, fastestS, penaltyMinutes, className, origin, dest }) {
  const extraMinutes = Math.round((route.durationS - fastestS) / 60);
  const numbers = [
    el('strong', { textContent: formatDuration(route.durationS) }),
    el('span', { textContent: `arrive ${formatArrival(route.durationS)}` }),
    el('span', { textContent: extraMinutes <= 0 ? 'fastest' : `+${extraMinutes} min vs fastest` }),
    el('span', { textContent: `${Math.round(route.distanceM / 1609.34)} mi` }),
  ];
  if (penaltyMinutes) numbers.push(el('span', { textContent: `penalty ${penaltyMinutes} min` }));

  const vias = route.vias ?? [];
  // Navigation must start from where the device is, so the origin is left out of that link.
  const navigateUrl = mapsLink({ origin: null, destination: dest, vias, navigate: true });
  const previewUrl = mapsLink({ origin, destination: dest, vias, navigate: false });

  return el('article', { className: `route ${className}` }, [
    el('div', { className: 'tags', textContent: tags.join(' · ') }),
    el('h3', { textContent: title }),
    el('div', { className: 'numbers' }, numbers),
    el('div', { className: 'links' }, [
      el('a', { className: 'button primary', href: navigateUrl, target: '_blank', rel: 'noopener', textContent: 'Navigate' }),
      el('a', { className: 'button', href: previewUrl, target: '_blank', rel: 'noopener', textContent: 'Preview in Maps' }),
    ]),
  ]);
}

function renderResult(result, origin, dest) {
  const cards = result.candidates.map((candidate) => {
    const tags = [];
    if (candidate === result.recommended) tags.push('Recommended');
    if (candidate.matchesBaseline) tags.push("Google's pick");
    return routeCard({
      title: candidate.name,
      tags,
      route: candidate,
      fastestS: result.fastestS,
      penaltyMinutes: candidate.penaltyMinutes,
      className: candidate === result.recommended ? 'recommended' : '',
      origin,
      dest,
    });
  });
  cards.push(
    routeCard({
      title: "Google's own route",
      tags: [result.candidates.length ? 'For reference, not ranked' : 'No choice points on this trip'],
      route: result.baseline,
      fastestS: result.fastestS,
      className: 'reference',
      origin,
      dest,
    }),
  );
  $('results').replaceChildren(...cards);

  const notes = [];
  if (result.choicePointNames.length) notes.push(`Choice points on this trip: ${result.choicePointNames.join(', ')}.`);
  if (result.truncated) notes.push('Too many combinations: only some were priced (raise maxRoutes in choice-points.json).');
  for (const failure of result.failed) notes.push(`${failure.name} failed: ${failure.error}`);
  setStatus(notes.join(' '), result.truncated || result.failed.length > 0);
}

$('compare').onclick = async () => {
  const dest = toField.value();
  if (!apiKey) return setStatus('Add your Google API key under Settings first.', true);
  if (!dest) return setStatus('Enter a destination first.', true);

  $('compare').disabled = true;
  $('results').replaceChildren();
  setStatus('Checking live traffic…');
  usage.startCompare();
  try {
    const [origin, config] = await Promise.all([
      locate(fromField.value()),
      fetch('choice-points.json', { cache: 'no-store' }).then((response) => response.json()),
    ]);
    const result = await plan({
      choicePoints: config.choicePoints,
      triggerRadiusM: config.triggerRadiusM,
      maxRoutes: config.maxRoutes,
      computeRoute: (vias, label) => computeRoute(apiKey, origin, dest, vias, label),
    });
    renderResult(result, origin.isCurrentLocation ? null : origin, dest);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $('compare').disabled = false;
  }
};

// ---------- tech details: API usage and call log ----------

const APIS = {
  routes: { name: 'Routes: computeRoutes (Compute Routes Pro)', freePerMonth: 5000 },
  autocomplete: { name: 'Places: autocomplete (Autocomplete Requests)', freePerMonth: 10000 },
};
const MAX_LOG_ENTRIES = 200;

const usage = {
  compare: {},
  session: {},
  monthKey: `usage.${new Date().toISOString().slice(0, 7)}`,
  startCompare() {
    this.compare = {};
    this.render();
  },
  count(api) {
    this.compare[api] = (this.compare[api] ?? 0) + 1;
    this.session[api] = (this.session[api] ?? 0) + 1;
    const month = store.get(this.monthKey, {});
    month[api] = (month[api] ?? 0) + 1;
    store.set(this.monthKey, month);
    this.render();
  },
  render() {
    const month = store.get(this.monthKey, {});
    $('usage').tBodies[0].replaceChildren(
      ...Object.entries(APIS).map(([api, { name, freePerMonth }]) =>
        el('tr', {}, [
          el('td', { textContent: name }),
          // Search suggestions happen while typing, not during a compare.
          el('td', { textContent: api === 'routes' ? String(this.compare[api] ?? 0) : '' }),
          el('td', { textContent: String(this.session[api] ?? 0) }),
          el('td', { textContent: String(month[api] ?? 0) }),
          el('td', { textContent: freePerMonth.toLocaleString() }),
        ]),
      ),
    );
  },
};

const json = (value) => JSON.stringify(value, null, 2);

onApiCall((record) => {
  usage.count(record.api);
  const time = record.startedAt.toLocaleTimeString([], { hour12: false });
  const outcome = record.status ?? 'failed';
  const entry = el('details', { className: `call ${record.error ? 'failed' : ''}` }, [
    el('summary', { textContent: `${time} · ${record.api} · ${record.label} · ${outcome} · ${record.ms} ms` }),
    el('h3', { textContent: `Request: POST ${record.url}` }),
    // The API key travels in a header and is deliberately not shown here.
    el('pre', { textContent: (record.fieldMask ? `X-Goog-FieldMask: ${record.fieldMask}\n\n` : '') + json(record.request) }),
    el('h3', { textContent: `Response: ${record.error ? record.error : `HTTP ${record.status}`}` }),
    el('pre', { textContent: json(record.response ?? null) }),
  ]);
  $('api-log').prepend(entry);
  while ($('api-log').childElementCount > MAX_LOG_ENTRIES) $('api-log').lastElementChild.remove();
});

// ---------- settings ----------

$('api-key').value = apiKey;
$('api-key').onchange = () => {
  apiKey = $('api-key').value.trim();
  store.set('apiKey', apiKey);
};

renderPlaces();
usage.render();
if (!apiKey) {
  $('settings').open = true;
  setStatus('Add your Google API key under Settings to get started.');
}
