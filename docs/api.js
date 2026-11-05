// The diary's data layer: what used to be the server API, now running on the phone.
import { DEFAULT_MODULES, DERIVED, MED_KINDS, MODULES, validValue } from './config.js';
import * as stats from './stats.js';
import * as store from './store.js';
import * as weather from './weather.js';

const EFFECTS = new Set(['full', 'partial', 'none', null]);
const BACKUP_FORMAT = 'headache-diary-backup';

async function refreshWeather() {
  try { await weather.refresh(); } catch (e) { console.warn('weather refresh failed', e); }
}

const byDate = rows => Object.fromEntries(rows.map(r => [r.date, r]));

function withMigraine(day) {
  return day && { ...day, attacks: day.attacks.map(a => ({ ...a, migraine: stats.isMigraine(a) })) };
}

export async function config() {
  return { modules: MODULES, derived: DERIVED, enabled: await store.getSetting('modules', DEFAULT_MODULES) };
}

export async function day(date) {
  const [d, w, h] = await Promise.all([store.get('days', date), store.get('weather', date), store.get('health', date)]);
  const rec = withMigraine(d);
  return { date, day: rec || null, attacks: rec?.attacks || [], doses: rec?.doses || [], weather: w || null, health: h || null };
}

export async function saveDay(date, body) {
  if (date > stats.today()) throw new Error('Нельзя заполнять будущие дни');
  const known = new Set((await store.getAll('meds')).map(m => m.id));
  const doses = [...body.doses, ...body.attacks.flatMap(a => a.doses)];
  for (const x of doses) {
    if (!known.has(x.med_id)) throw new Error('Неизвестное лекарство');
    if (!EFFECTS.has(x.effect)) throw new Error('Некорректный эффект');
  }
  for (const [k, v] of Object.entries(body.factors)) {
    if (!validValue(k, v)) throw new Error(`Некорректное значение фактора: ${k}`);
  }
  for (const a of body.attacks) {
    if (!(a.intensity >= 1 && a.intensity <= 10)) throw new Error('Сила боли — от 1 до 10');
  }
  await store.put('days', {
    date,
    headache: !!body.headache,
    factors: body.factors,
    period: !!body.period,
    sleep_hours: body.sleep_hours ?? null,
    note: body.note || '',
    attacks: body.headache ? body.attacks : [],
    doses: body.doses,
    updated_at: new Date().toISOString(),
  });
  return day(date);
}

export const deleteDay = date => store.del('days', date);

/**
 * Attack mode: record "it hurts now" in a couple of taps. Adds to today's record without touching
 * anything already filled in; details can be added later in the normal form.
 */
export async function quickAttack(intensity, medIds) {
  const date = stats.today();
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const old = await store.get('days', date);
  const day = old || { date, factors: {}, period: false, sleep_hours: null, note: '', attacks: [], doses: [] };
  const doses = medIds.map(med_id => ({ med_id, time, effect: null }));
  if (day.attacks.length) {
    const a = day.attacks[0];
    a.intensity = Math.max(a.intensity, intensity);
    a.doses = [...a.doses, ...doses];
  } else {
    day.attacks = [{ start_time: time, end_time: null, intensity, location: [], character: [], symptoms: [], note: '', doses }];
  }
  return saveDay(date, { ...day, headache: true });
}

export async function cycle() {
  return stats.cycle(await store.getAll('days'));
}

export async function summary(from, to) {
  await refreshWeather();
  // Overuse looks 30 days back from `to`, so load a bit more than the range itself.
  const loadFrom = [from, stats.addDays(to, -29)].sort()[0];
  const [days, w, h, meds] = await Promise.all([
    store.getAll('days', loadFrom, to), store.getAll('weather', from, to), store.getAll('health', from, to), store.getAll('meds'),
  ]);
  return stats.summary({ from, to, days, weather: byDate(w), health: byDate(h), meds });
}

export function month(ym) {
  const start = stats.parseISO(`${ym}-01`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return summary(stats.iso(start), stats.iso(end));
}

// ---------- medications ----------

export async function meds() {
  const list = await store.getAll('meds');
  return list.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ru'));
}

function checkMed(m) {
  const name = (m.name || '').trim();
  if (!name || name.length > 80) throw new Error('Введите название (до 80 символов)');
  if (!MED_KINDS.includes(m.kind)) throw new Error('Неизвестный тип лекарства');
  return { name, dose: (m.dose || '').trim().slice(0, 40), kind: m.kind, active: m.active !== false };
}

export async function addMed(m) {
  const id = await store.put('meds', checkMed(m));
  return { id, ...checkMed(m) };
}

export const updateMed = (id, m) => store.put('meds', { id, ...checkMed(m) });

// ---------- settings ----------

export async function settings() {
  const [city, reminder_time, modules, last_backup] = await Promise.all([
    store.getSetting('city', null), store.getSetting('reminder_time', '21:00'),
    store.getSetting('modules', DEFAULT_MODULES), store.getSetting('last_backup', null),
  ]);
  return { city, reminder_time, modules, last_backup };
}

export async function saveSettings(s) {
  if (s.modules) {
    const known = new Set(MODULES.map(m => m.key));
    await store.setSetting('modules', s.modules.filter(k => known.has(k)));
  }
  if (s.reminder_time) await store.setSetting('reminder_time', s.reminder_time);
  if (s.city) {
    await store.setSetting('city', s.city);
    await store.clear('weather');
    await store.setSetting('weather_fetched_at', null);
    try { await weather.refresh(true); } catch (e) { console.warn(e); }
  }
}

export const geocode = q => weather.geocode(q);

// ---------- Apple Health (pasted from a Shortcut) ----------

/**
 * Accepts the text a Shortcut puts on the clipboard. Either JSON
 * ({"date":"2026-11-05","sleep_hours":7.2,"resting_hr":61,"hrv":42,"steps":8000})
 * or "key: value" lines with the same keys. Numbers may use a decimal comma.
 */
export async function importHealth(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = Object.fromEntries(text.split(/[\n;]/).map(l => l.split(/[:=]/).map(s => s.trim())).filter(p => p.length === 2));
  }
  const num = v => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const date = /^\d{4}-\d\d-\d\d/.test(data.date || '') ? data.date.slice(0, 10) : stats.today();
  const row = {
    date,
    sleep_hours: num(data.sleep_hours ?? data.sleep),
    resting_hr: num(data.resting_hr ?? data.hr),
    hrv: num(data.hrv),
    steps: num(data.steps),
  };
  // Sleep in Health is often in minutes or seconds; bring it to hours.
  if (row.sleep_hours > 24 * 60) row.sleep_hours /= 3600;
  else if (row.sleep_hours > 24) row.sleep_hours /= 60;
  if (row.sleep_hours != null) row.sleep_hours = Math.round(row.sleep_hours * 10) / 10;
  if (Object.entries(row).every(([k, v]) => k === 'date' || v == null)) throw new Error('Не нашёл данных в скопированном тексте');
  const old = await store.get('health', date);
  await store.put('health', { ...old, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)) });
  return row;
}

// ---------- backup & export ----------

export async function backup() {
  const data = { format: BACKUP_FORMAT, version: 1, created_at: new Date().toISOString() };
  for (const name of store.STORE_NAMES) data[name] = await store.getAll(name);
  return data;
}

export async function markBackedUp() { await store.setSetting('last_backup', Date.now()); }

export async function restore(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Это не файл резервной копии'); }
  if (data.format !== BACKUP_FORMAT || !Array.isArray(data.days)) throw new Error('Это не файл резервной копии дневника');
  await store.replaceAll(data);
  return data.days.length;
}

export async function csv() {
  const [days, meds, w, h] = await Promise.all([store.getAll('days'), store.getAll('meds'), store.getAll('weather'), store.getAll('health')]);
  const medsById = new Map(meds.map(m => [m.id, m])), W = byDate(w), H = byDate(h);
  const head = ['date', 'headache', 'migraine_like', 'start_time', 'end_time', 'intensity', 'location', 'character', 'symptoms',
    'meds', 'factors', 'period', 'sleep_hours', 'pressure', 'pressure_delta', 'temp', 'humidity', 'hrv', 'resting_hr', 'note'];
  const rows = [];
  for (const d of days.sort((a, b) => a.date.localeCompare(b.date))) {
    const base = { date: d.date, headache: d.headache ? 1 : 0, factors: JSON.stringify(d.factors), period: d.period ? 1 : 0,
      sleep_hours: d.sleep_hours, ...pick(W[d.date], ['pressure', 'pressure_delta', 'temp', 'humidity']), ...pick(H[d.date], ['hrv', 'resting_hr']), note: d.note };
    const medText = list => list.map(x => { const m = medsById.get(x.med_id); return `${m?.name || '?'} ${m?.dose || ''} [${x.effect || '?'}]`; }).join('; ');
    if (!d.attacks.length) rows.push({ ...base, meds: medText(d.doses) });
    for (const a of d.attacks) {
      rows.push({ ...base, migraine_like: stats.isMigraine(a) ? 1 : 0, start_time: a.start_time, end_time: a.end_time, intensity: a.intensity,
        location: a.location.join(','), character: a.character.join(','), symptoms: a.symptoms.join(','), meds: medText([...a.doses, ...d.doses]) });
    }
  }
  const cell = v => v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
  return '﻿' + [head.join(';'), ...rows.map(r => head.map(k => cell(r[k])).join(';'))].join('\n');
}

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k] ?? null]));

/** Plain-text digest to paste into a chat with Claude for a monthly review. */
export async function claudeDigest(from, to) {
  const s = await summary(from, to);
  const [days, meds] = await Promise.all([store.getAll('days', from, to), store.getAll('meds')]);
  const medsById = new Map(meds.map(m => [m.id, m]));
  const lines = days.sort((a, b) => a.date.localeCompare(b.date)).map(d => {
    const parts = [d.date, d.headache ? 'БОЛЬ' : 'без боли'];
    for (const a of d.attacks) {
      parts.push(`${a.start_time || '?'}–${a.end_time || '?'}, сила ${a.intensity}/10${stats.isMigraine(a) ? ', мигренеподобный' : ''}`,
        [a.location, a.character, a.symptoms].map(x => x.join(',')).filter(Boolean).join('; '));
    }
    const ds = stats.allDoses(d).map(x => `${medsById.get(x.med_id)?.name || '?'} (${x.effect || 'эффект?'})`);
    if (ds.length) parts.push('лекарства: ' + ds.join(', '));
    const f = Object.entries(d.factors).filter(([, v]) => v && v !== 0).map(([k, v]) => v === true ? k : `${k}=${v}`);
    if (f.length) parts.push('факторы: ' + f.join(', '));
    if (d.period) parts.push('менструация');
    if (d.sleep_hours != null) parts.push(`сон ${d.sleep_hours} ч`);
    if (d.note) parts.push(`заметка: ${d.note}`);
    return parts.filter(Boolean).join(' | ');
  });
  return [
    'Ниже мой дневник головной боли. Проанализируй его как внимательный помощник (не ставь диагноз):',
    'частота и динамика приступов, возможные провокаторы и защитные факторы, эффективность лекарств,',
    'риск лекарственно-индуцированной головной боли, что обсудить с неврологом. Ответь по-русски, кратко и по пунктам.',
    '',
    `Период: ${from} — ${to}. Заполнено дней: ${s.logged_days} из ${s.total_days}. Дней с болью: ${s.headache_days}, мигренеподобных: ${s.migraine_days}. ` +
      `Средняя сила: ${s.avg_intensity ?? '—'}. Дней с обезболивающими: ${s.med_days}.`,
    `Лекарства: ${meds.map(m => `${m.name} ${m.dose} (${m.kind})`).join(', ') || 'не указаны'}.`,
    '',
    ...lines,
  ].join('\n');
}
