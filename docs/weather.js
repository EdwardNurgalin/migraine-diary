// Daily weather from Open-Meteo (free, no key, allows requests straight from the browser).
import * as store from './store.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REFRESH_EVERY_MS = 6 * 3600 * 1000;

async function getJSON(url, params, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}?${new URLSearchParams(params)}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Погода недоступна (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function geocode(query) {
  const data = await getJSON(GEOCODE_URL, { name: query, count: 5, language: 'ru' });
  return (data.results || []).map(x => ({
    name: x.name,
    region: [x.admin1, x.country].filter(Boolean).join(', '),
    lat: x.latitude,
    lon: x.longitude,
    timezone: x.timezone || 'auto',
  }));
}

/** Fetch the last ~3 months of hourly data and store daily means. No-op if fresh, offline or no city set. */
export async function refresh(force = false) {
  const city = await store.getSetting('city');
  if (!city) return;
  const last = await store.getSetting('weather_fetched_at');
  if (!force && last && Date.now() - last < REFRESH_EVERY_MS) return;
  if (!navigator.onLine) return;

  const data = await getJSON(FORECAST_URL, {
    latitude: city.lat,
    longitude: city.lon,
    hourly: 'pressure_msl,temperature_2m,relative_humidity_2m',
    past_days: 92,
    forecast_days: 3, // tomorrow's pressure feeds the risk forecast
    timezone: city.timezone || 'auto',
  }, 20000);
  const h = data.hourly;

  const buckets = {};
  h.time.forEach((ts, i) => {
    const b = (buckets[ts.slice(0, 10)] ??= { p: [], t: [], h: [] });
    if (h.pressure_msl[i] != null) b.p.push(h.pressure_msl[i]);
    if (h.temperature_2m[i] != null) b.t.push(h.temperature_2m[i]);
    if (h.relative_humidity_2m[i] != null) b.h.push(h.relative_humidity_2m[i]);
  });

  const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
  const dates = Object.keys(buckets).sort();
  const before = await store.get('weather', prevDay(dates[0]));
  let prev = before?.pressure ?? null;
  const rows = dates.map(date => {
    const b = buckets[date];
    const pressure = mean(b.p);
    const row = {
      date,
      pressure,
      pressure_delta: pressure != null && prev != null ? Math.round((pressure - prev) * 10) / 10 : null,
      temp: mean(b.t),
      humidity: mean(b.h),
    };
    prev = pressure;
    return row;
  });
  await store.putMany('weather', rows);
  await store.setSetting('weather_fetched_at', Date.now());
}

function prevDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
