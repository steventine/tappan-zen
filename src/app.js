// Page wiring: reads the trip from the form, runs the planner, and draws the comparison.

import { planForks } from './forks.js';
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
let routePlan = store.get('plan', {}); // choice point name -> alternative last navigated

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

/** Remembers the alternatives of a route the driver chose, so later checks compare against it. */
function rememberPlan(route) {
  for (const alt of route.selection ?? []) routePlan[alt.choicePoint] = alt.name;
  store.set('plan', routePlan);
  renderPlanSummary();
}

function renderPlanSummary() {
  const entries = Object.entries(routePlan);
  $('plan-summary').textContent = entries.length
    ? entries.map(([choicePoint, alt]) => `${choicePoint}: ${alt}`).join(' · ')
    : 'Using the defaults (the lowest-penalty road at each choice point). Tapping Navigate on a route makes it the plan.';
}

/** Navigation must start from where the device is, so the origin is left out of the link. */
function navigateLink(route, dest, props, children = []) {
  return el(
    'a',
    {
      href: mapsLink({ origin: null, destination: dest, vias: route.vias ?? [], navigate: true }),
      target: '_blank',
      rel: 'noopener',
      onclick: () => rememberPlan(route),
      ...props,
    },
    children,
  );
}

function routeCard({ title, tags, route, fastestS, penaltyMinutes, className, origin, dest }) {
  const extraMinutes = Math.round((route.durationS - fastestS) / 60);
  const approx = route.estimated ? '≈ ' : '';
  const numbers = [
    el('strong', { textContent: approx + formatDuration(route.durationS) }),
    el('span', { textContent: `arrive ${approx}${formatArrival(route.durationS)}` }),
    el('span', { textContent: extraMinutes <= 0 ? 'fastest' : `+${extraMinutes} min vs fastest` }),
  ];
  if (route.distanceM != null) numbers.push(el('span', { textContent: `${Math.round(route.distanceM / 1609.34)} mi` }));
  if (penaltyMinutes) numbers.push(el('span', { textContent: `penalty ${penaltyMinutes} min` }));

  const previewUrl = mapsLink({ origin, destination: dest, vias: route.vias ?? [], navigate: false });

  return el('article', { className: `route ${className}` }, [
    el('div', { className: 'tags', textContent: tags.join(' · ') }),
    el('h3', { textContent: title }),
    el('div', { className: 'numbers' }, numbers),
    el('div', { className: 'links' }, [
      navigateLink(route, dest, { className: 'button primary', textContent: 'Navigate' }),
      el('a', { className: 'button', href: previewUrl, target: '_blank', rel: 'noopener', textContent: 'Preview in Maps' }),
    ]),
  ]);
}

function renderAll(result, origin, dest) {
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
    const tab = activeTab;
    const result = await VIEWS[tab].run({
      choicePoints: config.choicePoints,
      triggerRadiusM: config.triggerRadiusM,
      maxRoutes: config.maxRoutes,
      plan: { ...routePlan },
      computeRoute: (vias, label) => computeRoute(apiKey, origin, dest, vias, label),
    });
    lastResults[tab] = [result, origin.isCurrentLocation ? null : origin, dest];
    if (tab === activeTab) VIEWS[tab].render(...lastResults[tab]);
    // The trip does not change during a drive: fold it away and leave just the refresh button.
    $('trip-summary').textContent = `${origin.name ?? origin.label} → ${dest.name ?? dest.label}`;
    $('trip').open = false;
    $('compare').textContent = 'Refresh times';
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $('compare').disabled = false;
  }
};

// ---------- next decision view ----------

function routeNotes(result) {
  const notes = [];
  if (result.truncated) notes.push('Route limit reached: some roads were not priced (raise maxRoutes in choice-points.json).');
  for (const failure of result.failed) notes.push(`${failure.name} failed: ${failure.error}`);
  setStatus(notes.join(' '), notes.length > 0);
}

const ICONS = {
  preview:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  navigate:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/></svg>',
};

/** Small Preview and Navigate buttons for a route. Tapping them does not select the card. */
function routeIcons(route, origin, dest) {
  const stop = (event) => event.stopPropagation();
  const preview = el('a', {
    className: 'icon',
    href: mapsLink({ origin, destination: dest, vias: route.vias ?? [], navigate: false }),
    target: '_blank',
    rel: 'noopener',
    title: 'Preview in Maps',
    ariaLabel: `Preview ${route.name ?? "Google's route"} in Maps`,
    innerHTML: ICONS.preview,
  });
  const navigate = navigateLink(route, dest, {
    className: 'icon primary',
    title: 'Navigate',
    ariaLabel: `Navigate ${route.name ?? "Google's route"}`,
    innerHTML: ICONS.navigate,
  });
  preview.addEventListener('click', stop);
  navigate.addEventListener('click', stop);
  // Navigate on the left and Preview on the far right, so a tap can't land on the wrong one.
  return el('div', { className: 'tile-actions' }, [navigate, preview]);
}

/** "+5 min", "−8 min" or "same time", comparing a route with the selected one. */
function relativeTo(selected, route) {
  const minutes = Math.round((route.durationS - selected.durationS) / 60);
  if (minutes === 0) return { text: 'same time', className: '' };
  return minutes > 0
    ? { text: `+${minutes} min`, className: 'slower' }
    : { text: `−${-minutes} min`, className: 'faster' };
}

/**
 * Works out which route is selected and what each card stands for. The selected route is the
 * driver's pick at every fork; a card is "the selected route with this one fork changed".
 */
function decisionModel(result) {
  const referenceName = {};
  for (const alt of result.reference?.selection ?? []) referenceName[alt.choicePoint] = alt.name;

  const picks = { ...referenceName };
  for (const fork of result.forks) {
    if (fork.tiles.some((tile) => tile.name === routePlan[fork.name])) picks[fork.name] = routePlan[fork.name];
  }
  const isStandalone = (forkName, altName) =>
    result.forks.find((fork) => fork.name === forkName)?.tiles.find((tile) => tile.name === altName)?.standalone;

  const standaloneRoute = (forkName, altName) =>
    result.routes.find(
      ({ selection }) => selection.length === 1 && selection[0].standalone && selection[0].choicePoint === forkName && selection[0].name === altName,
    );
  const combinedRoute = (names) =>
    result.routes.find(({ selection }) => selection.every((alt) => !alt.standalone && names[alt.choicePoint] === alt.name));

  // Picks to use for the combinable part of a route: a standalone pick falls back to the reference.
  const combinablePicks = () =>
    Object.fromEntries(
      Object.entries(picks).map(([forkName, altName]) => [forkName, isStandalone(forkName, altName) ? referenceName[forkName] : altName]),
    );

  const routeForTile = (fork, tile) =>
    tile.standalone ? standaloneRoute(fork.name, tile.name) : combinedRoute({ ...combinablePicks(), [fork.name]: tile.name });

  const standalonePick = result.forks.find((fork) => isStandalone(fork.name, picks[fork.name]));
  const selected = standalonePick ? standaloneRoute(standalonePick.name, picks[standalonePick.name]) : combinedRoute(picks);

  /** Makes an alternative the driver's pick. Picking an ordinary road drops any standalone pick elsewhere. */
  const pick = (fork, tile) => {
    if (!tile.standalone) {
      for (const [forkName, altName] of Object.entries(picks)) {
        if (isStandalone(forkName, altName)) routePlan[forkName] = referenceName[forkName];
      }
    }
    routePlan[fork.name] = tile.name;
    store.set('plan', routePlan);
    renderPlanSummary();
  };

  return { selected: selected ?? result.recommended, routeForTile, pick };
}

function verdict(result, selected) {
  const { recommended } = result;
  if (recommended === selected) {
    return el('div', { className: 'verdict stay' }, [
      el('strong', { textContent: 'Stay on plan' }),
      el('span', { textContent: `${selected.name} · arrive ${formatArrival(selected.durationS)}` }),
    ]);
  }
  // Name the first fork where the suggestion leaves the selected route.
  const changes = recommended.selection.filter((alt) => !selected.selection.includes(alt));
  const change = changes.length === 1 ? changes[0] : recommended;
  const minutes = Math.round((selected.durationS - recommended.durationS) / 60);
  const comparison =
    minutes > 0 ? `${minutes} min faster than` : minutes < 0 ? `${-minutes} min slower but preferred over` : 'same time as';
  return el('div', { className: 'verdict switch' }, [
    el('strong', { textContent: `Suggested: take ${change.name}` }),
    el('span', {
      textContent: `${recommended.name} · arrive ${formatArrival(recommended.durationS)} · ${comparison} ${selected.name}`,
    }),
  ]);
}

function tileContents({ name, route, selected, isSelected, notes, origin, dest }) {
  const approx = route.estimated ? '≈ ' : '';
  const relative = isSelected ? { text: 'selected', className: '' } : relativeTo(selected, route);
  return [
    el('span', { className: 'tile-name', textContent: name }),
    el('strong', { textContent: `${approx}${formatArrival(route.durationS)}` }),
    el('span', { className: `relative ${relative.className}`, textContent: [relative.text, ...notes].join(' · ') }),
    routeIcons(route, origin, dest),
  ];
}

function forkCard(fork, isNext, model, result, rerender, origin, dest) {
  const tiles = fork.tiles
    .map((tile) => ({ tile, route: model.routeForTile(fork, tile) }))
    .filter(({ route }) => route)
    .map(({ tile, route }) => {
      const isSelected = model.selected.selection.some((alt) => alt.choicePoint === fork.name && alt.name === tile.name);
      const notes = [];
      if (result.recommended.selection.some((alt) => alt.choicePoint === fork.name && alt.name === tile.name)) notes.push('suggested');
      if (tile.penaltyMinutes) notes.push(`penalty ${tile.penaltyMinutes}`);
      const select = () => {
        model.pick(fork, tile);
        rerender();
      };
      return el(
        'div',
        {
          className: `tile selectable ${isSelected ? 'selected' : ''}`,
          role: 'button',
          tabIndex: 0,
          ariaPressed: String(isSelected),
          onclick: select,
          onkeydown: (event) => {
            if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) select();
          },
        },
        tileContents({ name: tile.name, route, selected: model.selected, isSelected, notes, origin, dest }),
      );
    });
  return el('article', { className: `fork ${isNext ? 'next' : ''}` }, [
    el('h3', { textContent: `${isNext ? 'Next' : 'Then'}: ${fork.name}` }),
    el('div', { className: 'tiles' }, tiles),
  ]);
}

function renderDecision(result, origin, dest) {
  const card = (route, extra) => routeCard({ route, fastestS: result.fastestS, origin, dest, ...extra });
  const baselineCard = card(result.baseline, {
    title: "Google's own route",
    tags: [result.recommended ? 'For reference, not ranked' : 'No choice points on this trip'],
    className: 'reference',
  });
  if (!result.recommended) {
    $('results').replaceChildren(baselineCard);
    return routeNotes(result);
  }

  const model = decisionModel(result);
  const rerender = () => renderDecision(result, origin, dest);
  const googleRow = el('article', { className: 'fork' }, [
    el('h3', { textContent: "Google's own choice (no waypoints)" }),
    el('div', { className: 'tiles' }, [
      el(
        'div',
        { className: 'tile reference' },
        tileContents({
          name: "Google's fastest",
          route: result.baseline,
          selected: model.selected,
          isSelected: false,
          notes: [],
          origin,
          dest,
        }),
      ),
    ]),
  ]);
  const allRoutes = el('details', { className: 'all-routes' }, [
    el('summary', {
      textContent: `All ${result.routes.length} routes (≈ marks times estimated from the per-fork differences)`,
    }),
    ...result.routes.map((route) =>
      card(route, {
        title: route.name,
        tags: [
          ...(route === result.recommended ? ['Recommended'] : []),
          ...(route === model.selected ? ['Selected'] : []),
          ...(route.matchesBaseline ? ["Google's pick"] : []),
        ],
        penaltyMinutes: route.penaltyMinutes,
        className: route === result.recommended ? 'recommended' : '',
      }),
    ),
    baselineCard,
  ]);
  $('results').replaceChildren(
    verdict(result, model.selected),
    ...result.forks
      .filter((fork) => fork.tiles.length > 1)
      .map((fork, i) => forkCard(fork, i === 0, model, result, rerender, origin, dest)),
    googleRow,
    allRoutes,
  );
  routeNotes(result);
}

// ---------- tabs ----------

const VIEWS = {
  decision: { run: planForks, render: renderDecision },
  all: { run: plan, render: renderAll },
};
const lastResults = {};
let activeTab = store.get('tab', 'decision');

function showTab(tab) {
  activeTab = VIEWS[tab] ? tab : 'decision';
  store.set('tab', activeTab);
  for (const button of document.querySelectorAll('.tabs button')) {
    button.ariaSelected = String(button.dataset.tab === activeTab);
    button.onclick = () => showTab(button.dataset.tab);
  }
  if (lastResults[activeTab]) {
    VIEWS[activeTab].render(...lastResults[activeTab]);
  } else {
    $('results').replaceChildren();
    setStatus(apiKey ? 'Press Compare routes to price this view.' : '');
  }
}

$('reset-plan').onclick = () => {
  routePlan = {};
  store.set('plan', routePlan);
  renderPlanSummary();
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
renderPlanSummary();
usage.render();
showTab(activeTab);
if (!apiKey) {
  $('settings').open = true;
  setStatus('Add your Google API key under Settings to get started.');
}
