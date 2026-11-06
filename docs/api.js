// The diary's data layer: what used to be the server API, now running on the phone.
import { CUSTOM_TYPES, DEFAULT_MODULES, DERIVED, MED_KINDS, MODULES, buildModules, customFactor, factorMap, validValue } from './config.js';
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

async function modules() {
  const [custom, disabled] = await Promise.all([store.getSetting('custom_factors', []), store.getSetting('disabled_factors', [])]);
  return buildModules(custom, disabled);
}

export async function config() {
  let enabled = await store.getSetting('modules', DEFAULT_MODULES);
  const seen = await store.getSetting('modules_seen', null);
  const fresh = seen ? DEFAULT_MODULES.filter(k => !seen.includes(k)) : [];
  if (fresh.length || !seen) {
    enabled = [...new Set([...enabled, ...fresh])];
    await store.setSetting('modules', enabled);
    await store.setSetting('modules_seen', DEFAULT_MODULES);
  }
  const trackCycle = await store.getSetting('track_cycle', true);
  return { modules: await modules(), derived: DERIVED, enabled, trackCycle };
}

export async function addFactor(label, type, module) {
  if (!label.trim()) throw new Error('Введите название');
  if (!CUSTOM_TYPES[type] || !MODULES.some(m => m.key === module)) throw new Error('Некорректный фактор');
  const custom = await store.getSetting('custom_factors', []);
  await store.setSetting('custom_factors', [...custom, customFactor(label, type, module)]);
}

/** Removes the user's own factor from the form; values already recorded stay in old days. */
export async function removeFactor(key) {
  const custom = await store.getSetting('custom_factors', []);
  await store.setSetting('custom_factors', custom.filter(f => f.key !== key));
}

export async function setFactorEnabled(key, on) {
  const disabled = new Set(await store.getSetting('disabled_factors', []));
  on ? disabled.delete(key) : disabled.add(key);
  await store.setSetting('disabled_factors', [...disabled]);
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
  const defs = factorMap(await modules());
  // Keys of factors that no longer exist (a removed custom factor) are dropped, not rejected.
  const factors = Object.fromEntries(Object.entries(body.factors).filter(([k]) => defs[k]));
  for (const [k, v] of Object.entries(factors)) {
    if (!validValue(defs[k], v)) throw new Error(`Некорректное значение: ${defs[k].label}`);
  }
  for (const a of body.attacks) {
    if (!(a.intensity >= 1 && a.intensity <= 10)) throw new Error('Сила боли — от 1 до 10');
  }
  await store.put('days', {
    date,
    headache: !!body.headache,
    factors,
    period: !!body.period,
    sleep_hours: body.sleep_hours ?? hoursBetween(body.sleep_start, body.sleep_end),
    sleep_start: body.sleep_start || null,
    sleep_end: body.sleep_end || null,
    note: body.note || '',
    attacks: body.headache ? body.attacks : [],
    doses: body.doses,
    updated_at: new Date().toISOString(),
  });
  return day(date);
}

/** Sleep length from "fell asleep" and "woke up" times (across midnight), in hours with one decimal. */
function hoursBetween(a, b) {
  if (!a || !b) return null;
  let m = (+b.slice(0, 2) * 60 + +b.slice(3, 5)) - (+a.slice(0, 2) * 60 + +a.slice(3, 5));
  if (m <= 0) m += 1440;
  return Math.round(m / 6) / 10;
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
  const [days, manual] = await Promise.all([store.getAll('days'), store.getSetting('cycle_len', null)]);
  return stats.cycle(days, manual);
}

export async function summary(from, to) {
  await refreshWeather();
  // Overuse looks 30 days back from `to`, so load a bit more than the range itself.
  const loadFrom = [from, stats.addDays(to, -29)].sort()[0];
  const [days, w, h, meds, mods] = await Promise.all([
    store.getAll('days', loadFrom, to), store.getAll('weather', from, to), store.getAll('health', from, to), store.getAll('meds'), modules(),
  ]);
  return stats.summary({ from, to, days, weather: byDate(w), health: byDate(h), meds, factors: factorMap(mods) });
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
  const date = v => /^\d{4}-\d\d-\d\d$/.test(v || '') ? v : null;
  return {
    name, dose: (m.dose || '').trim().slice(0, 40), kind: m.kind, active: m.active !== false,
    start_date: m.kind === 'preventive' ? date(m.start_date) : null,
    stop_date: m.kind === 'preventive' ? date(m.stop_date) : null,
  };
}

export async function addMed(m) {
  const id = await store.put('meds', checkMed(m));
  return { id, ...checkMed(m) };
}

export const updateMed = (id, m) => store.put('meds', { id, ...checkMed(m) });

/** Hidden from lists and the form, but kept so old entries still show the medication's name. */
export async function deleteMed(id) {
  const m = await store.get('meds', id);
  if (m) await store.put('meds', { ...m, active: false, deleted: true });
}

// ---------- settings ----------

export async function settings() {
  const keys = { city: null, reminder_time: '21:00', modules: DEFAULT_MODULES, last_backup: null, profile: {},
    track_cycle: true, cycle_len: null, pin: null };
  const vals = await Promise.all(Object.entries(keys).map(([k, d]) => store.getSetting(k, d)));
  const out = Object.fromEntries(Object.keys(keys).map((k, i) => [k, vals[i]]));
  out.has_pin = !!out.pin;
  delete out.pin;
  return out;
}

export async function saveProfile(p) {
  const clean = v => String(v ?? '').trim().slice(0, 80);
  await store.setSetting('profile', { birth_year: clean(p.birth_year), diagnosis: clean(p.diagnosis), since: clean(p.since), doctor: clean(p.doctor) });
}

export async function saveCycleSettings({ track_cycle, cycle_len }) {
  if (track_cycle != null) await store.setSetting('track_cycle', !!track_cycle);
  if (cycle_len !== undefined) {
    const n = Number(cycle_len);
    await store.setSetting('cycle_len', n >= 20 && n <= 45 ? Math.round(n) : null);
  }
}

// ---------- PIN ----------
// Hides the diary from someone picking up the phone. It does not encrypt the data on the device.

async function digest(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`headache-diary:${text}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function setPin(pin) {
  if (pin == null) return store.setSetting('pin', null);
  if (!/^\d{4}$/.test(pin)) throw new Error('Код — 4 цифры');
  await store.setSetting('pin', await digest(pin));
}
export async function hasPin() { return !!(await store.getSetting('pin', null)); }
export async function checkPin(pin) { return (await store.getSetting('pin', null)) === await digest(pin); }

/** Wipes every record and setting on this device. */
export async function deleteAll() {
  await store.replaceAll({});
}

// ---------- questionnaires ----------

export const SURVEYS = {
  hit6: {
    title: 'HIT-6', subtitle: 'Влияние головной боли на жизнь', every: 28,
    options: [['Никогда', 6], ['Редко', 8], ['Иногда', 10], ['Очень часто', 11], ['Всегда', 13]],
    questions: [
      'Когда у вас болит голова, как часто боль бывает сильной?',
      'Как часто головная боль ограничивает обычные дела: дом, работу, учёбу, общение?',
      'Когда у вас болит голова, как часто хочется лечь?',
      'За последние 4 недели как часто вы чувствовали себя слишком уставшей для работы или дел из-за головной боли?',
      'За последние 4 недели как часто головная боль вызывала раздражение или ощущение «сыта по горло»?',
      'За последние 4 недели как часто головная боль мешала сосредоточиться на работе или делах?',
    ],
    grade: s => s >= 60 ? 'тяжёлое влияние' : s >= 56 ? 'значительное влияние' : s >= 50 ? 'заметное влияние' : 'небольшое влияние',
  },
  midas: {
    title: 'MIDAS', subtitle: 'Сколько дней за 3 месяца отняла головная боль', every: 90,
    questions: [
      'Сколько дней за последние 3 месяца вы пропустили работу или учёбу из-за головной боли?',
      'Сколько дней продуктивность на работе или учёбе была снижена вдвое и больше (не считая пропущенных)?',
      'Сколько дней вы не занимались домашними делами из-за головной боли?',
      'Сколько дней продуктивность в домашних делах была снижена вдвое и больше (не считая пропущенных)?',
      'Сколько дней вы пропустили семейные, общественные или досуговые дела?',
    ],
    grade: s => s >= 21 ? 'IV степень — тяжёлая' : s >= 11 ? 'III степень — умеренная' : s >= 6 ? 'II степень — лёгкая' : 'I степень — минимальная',
  },
};

export async function saveSurvey(type, answers) {
  const def = SURVEYS[type];
  if (!def || answers.length !== def.questions.length || answers.some(a => !(a >= 0 && a <= 92))) throw new Error('Ответьте на все вопросы');
  const score = answers.reduce((a, b) => a + b, 0);
  const list = await store.getSetting('surveys', []);
  await store.setSetting('surveys', [...list, { type, date: stats.today(), answers, score, grade: def.grade(score) }]);
  return { score, grade: def.grade(score) };
}

export async function surveys() {
  const list = await store.getSetting('surveys', []);
  const last = t => list.filter(x => x.type === t).at(-1) || null;
  const due = t => !last(t) || stats.addDays(last(t).date, SURVEYS[t].every) <= stats.today();
  return { list, hit6: last('hit6'), midas: last('midas'), due: { hit6: due('hit6'), midas: due('midas') } };
}

// ---------- the two-hour check ----------

/** Doses taken at least two hours ago (today or yesterday) whose effect is not yet marked. */
export async function pendingEffects() {
  const now = new Date();
  const days = await store.getAll('days', stats.addDays(stats.today(), -1), stats.today());
  const meds = new Map((await store.getAll('meds')).map(m => [m.id, m]));
  const out = [];
  for (const d of days) d.attacks.forEach((a, ai) => a.doses.forEach((x, di) => {
    if (x.effect || !x.time) return;
    const [h, m] = x.time.split(':').map(Number);
    const taken = stats.parseISO(d.date); taken.setHours(h, m);
    if (now - taken >= 2 * 3600 * 1000) out.push({ date: d.date, ai, di, time: x.time, name: meds.get(x.med_id)?.name || 'лекарство' });
  }));
  return out;
}

export async function setEffect(date, ai, di, effect) {
  const d = await store.get('days', date);
  if (!d?.attacks[ai]?.doses[di] || !EFFECTS.has(effect)) throw new Error('Не нашёл этот приём');
  d.attacks[ai].doses[di].effect = effect;
  await store.put('days', d);
}

// ---------- analysis for "Мои данные", the report and the AI request ----------

export async function analysis(from, to) {
  const [all, meds, mods, cyc, w, trackCycle] = await Promise.all([
    store.getAll('days'), store.getAll('meds'), modules(), cycle(), store.getAll('weather'), store.getSetting('track_cycle', true),
  ]);
  const medsById = new Map(meds.map(m => [m.id, m]));
  const inRange = all.filter(d => d.date >= from && d.date <= to);
  return {
    monthly: stats.monthly(all, medsById, from, to),
    meds: stats.medEfficacy(inRange, medsById),
    menstrual: trackCycle ? stats.menstrualWindow(inRange, cyc) : null,
    preventive: meds.filter(m => m.kind === 'preventive' && m.start_date && !m.deleted).map(m => stats.preventiveResponse(all, m)),
    risk: stats.riskTomorrow({ days: all, cyc: trackCycle ? cyc : { periods: [], forecast: [] }, weather: byDate(w), defs: factorMap(mods) }),
    surveys: await surveys(),
    profile: await store.getSetting('profile', {}),
  };
}

export async function risk() {
  return (await analysis(stats.addDays(stats.today(), -29), stats.today())).risk;
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

const KIND_RU = {
  simple: 'простое обезболивающее / НПВС', triptan: 'триптан', combo: 'комбинированное обезболивающее', opioid: 'опиоид',
  ergot: 'эрготамин', preventive: 'профилактика', other: 'другое',
};
const LOC_RU = { left: 'слева', right: 'справа', both: 'с двух сторон', forehead: 'лоб', temples: 'виски', back: 'затылок', eye: 'вокруг глаза' };
const CHAR_RU = { pulsating: 'пульсирующая', pressing: 'давящая', squeezing: 'сжимающая', stabbing: 'колющая', dull: 'тупая' };
const SYM_RU = {
  nausea: 'тошнота', vomiting: 'рвота', photo: 'светобоязнь', phono: 'звукобоязнь', smell: 'непереносимость запахов',
  aura: 'аура', dizziness: 'головокружение', movement: 'усиление от движения',
};
const EFF_RU = { full: 'через 2 ч боль прошла', partial: 'через 2 ч стало легче', none: 'через 2 ч не помогло' };
const DIS_RU = ['не мешала', 'немного мешала', 'сильно мешала делам', 'пришлось лечь'];
const ru = (dict, keys) => keys.map(k => dict[k] || k).join(', ');
const minutesBetween = (a, b) => {
  if (!a || !b) return null;
  const m = (+b.slice(0, 2) * 60 + +b.slice(3, 5)) - (+a.slice(0, 2) * 60 + +a.slice(3, 5));
  return m < 0 ? m + 1440 : m;
};

/**
 * A ready-to-paste request for any AI chat (ChatGPT, Claude, Gemini, YandexGPT, GigaChat):
 * instructions written like a brief for a careful headache assistant, then the diary as compact lines.
 */
export async function aiPrompt(from, to) {
  const [s, cyc, mods, an] = await Promise.all([summary(from, to), cycle(), modules(), analysis(from, to)]);
  const [days, meds] = await Promise.all([store.getAll('days', from, to), store.getAll('meds')]);
  const W = byDate(await store.getAll('weather', from, to));
  const defs = factorMap(mods);
  const medsById = new Map(meds.map(m => [m.id, m]));
  const months = s.total_days / 30;
  const per30 = n => Math.round(n / months * 10) / 10;

  const lines = days.sort((a, b) => a.date.localeCompare(b.date)).map(d => {
    const parts = [d.date];
    if (!d.attacks.length) parts.push(d.headache ? 'боль (без подробностей)' : 'без боли');
    for (const a of d.attacks) {
      const dur = minutesBetween(a.start_time, a.end_time);
      parts.push([
        stats.isMigraine(a) ? 'боль, похоже на мигрень' : 'боль',
        `${a.start_time || '?'}–${a.end_time || 'не отмечено'}${dur != null ? ` (${Math.floor(dur / 60)} ч ${dur % 60} мин)` : ''}`,
        `сила ${a.intensity}/10`,
        [ru(LOC_RU, a.location), ru(CHAR_RU, a.character), ru(SYM_RU, a.symptoms)].filter(Boolean).join('; '),
        a.disability != null && `мешала: ${DIS_RU[a.disability]}`,
        a.recurred && 'вернулась в течение суток',
      ].filter(Boolean).join(', '));
    }
    const doses = stats.allDoses(d).map(x => {
      const m = medsById.get(x.med_id);
      const delay = minutesBetween(d.attacks[0]?.start_time, x.time);
      return `${m ? `${m.name} ${m.dose}`.trim() : '?'}${x.time ? ` в ${x.time}` : ''}${delay != null && d.attacks.length ? ` (через ${delay} мин от начала)` : ''} — ${EFF_RU[x.effect] || 'эффект не отмечен'}`;
    });
    if (doses.length) parts.push('лекарства: ' + doses.join('; '));
    const f = Object.entries(d.factors)
      .filter(([k, v]) => defs[k] && v && v !== 0)
      .map(([k, v]) => {
        const def = defs[k];
        if (def.module === 'prodrome') return `ранний сигнал: ${def.label.toLowerCase()}`;
        return def.type === 'bool' ? def.label.toLowerCase() : def.type === 'level' ? `${def.label.toLowerCase()}: ${['нет', 'немного', 'заметно', 'сильно'][v]}` : `${def.label.toLowerCase()}: ${v}`;
      });
    if (f.length) parts.push('факторы: ' + f.join(', '));
    const cd = cyc.dayOf(d.date);
    if (d.period) parts.push('менструация');
    else if (cd) parts.push(`${cd}-й день цикла`);
    if (d.sleep_start && d.sleep_end) parts.push(`сон ${d.sleep_start}–${d.sleep_end} (${d.sleep_hours} ч)`);
    else if (d.sleep_hours != null) parts.push(`сон ${d.sleep_hours} ч`);
    const w = W[d.date];
    if (w?.pressure != null) parts.push(`давление ${Math.round(w.pressure)} гПа${w.pressure_delta != null ? ` (${w.pressure_delta > 0 ? '+' : ''}${w.pressure_delta} за сутки)` : ''}`);
    if (d.note) parts.push(`заметка: ${d.note}`);
    return parts.join(' | ');
  });

  const cycleText = cyc.cycleLen
    ? `средняя длина цикла ${cyc.cycleLen} дн., менструация ${cyc.periodLen} дн., последняя началась ${cyc.periods.at(-1).start}` +
      (cyc.forecast.length ? `, следующая ожидается ${cyc.forecast[0]}` : '')
    : cyc.periods.length ? `отмечено менструаций: ${cyc.periods.length}, для расчёта цикла пока мало данных` : 'цикл не отмечался';
  const o = s.overuse;
  const p = an.profile || {};
  const profile = [p.birth_year && `год рождения ${p.birth_year}`, p.diagnosis && `диагноз: ${p.diagnosis}`, p.since && `головные боли с ${p.since}`].filter(Boolean).join('; ');
  const monthsText = an.monthly.map(m => `${m.month}: заполнено ${m.logged} из ${m.days} дн., с болью ${m.headache} (≈${m.headache_per30 ?? '—'} на 30 дней), похоже на мигрень ${m.migraine}, с обезболивающими ${m.med}`).join('\n');
  const medsText = an.meds.map(m => `${m.name} ${m.dose}`.trim() + `: приёмов ${m.n}, оценено ${m.rated} — прошло ${m.free}, легче ${m.better}, не помогло ${m.none}` +
    (m.median_delay != null ? `; обычно через ${m.median_delay} мин от начала боли` : '') +
    (m.early && m.late ? `; помогло при приёме в первый час ${m.early.helped} из ${m.early.of}, позже — ${m.late.helped} из ${m.late.of}` : '')).join('\n');
  const prevText = an.preventive.map(x => `${x.name} ${x.dose}`.trim() + ` с ${x.start}${x.stop ? ` по ${x.stop}` : ''}: дней с болью на 30 дней до — ${x.before?.per30 ?? 'мало данных'}, после первого месяца — ${x.after?.per30 ?? 'мало данных'}` +
    (x.change != null ? ` (${x.change > 0 ? '+' : ''}${x.change}%)` : '')).join('\n');
  const sv = an.surveys;
  const surveysText = [sv.hit6 && `HIT-6 ${sv.hit6.score} баллов (${sv.hit6.grade}), ${sv.hit6.date}`, sv.midas && `MIDAS ${sv.midas.score} (${sv.midas.grade}), ${sv.midas.date}`].filter(Boolean).join('; ');
  const mw = an.menstrual;
  const mwText = mw && mw.cycles ? `приступ в окне −2…+3 дня от начала менструации — в ${mw.with_attack} из ${mw.cycles} циклов; дней с болью в этом окне ${mw.pain_in_window} из ${mw.pain_days}` : '';

  return `Ты — внимательный помощник по головной боли. Ты хорошо знаешь международную классификацию головных болей ICHD-3 и современные рекомендации по мигрени. Ниже мой дневник головной боли. Разбери его так, чтобы мне было понятно, а неврологу — полезно.

Правила:
— Опирайся только на эти данные. Ничего не додумывай. Если вывод держится на нескольких днях, так и скажи и укажи, сколько наблюдений за ним стоит.
— Не ставь диагноз и не назначай лечение. Пиши «похоже на…», «стоит обсудить с врачом…».
— Отделяй совпадения от причин. По каждому возможному провокатору сравни: как часто болела голова в дни с ним и без него, и проверь сдвиг на сутки (фактор вчера — боль сегодня).
— Пиши по-русски, коротко, по пунктам, без общих советов из интернета. Где можно — с числами.

Что сделать:
0. Тревожные признаки. Если в записях есть то, с чем нужно срочно к врачу (внезапная сильнейшая «громоподобная» боль, впервые возникшая или резко изменившаяся боль, слабость, онемение или нарушения речи, боль с температурой, после травмы, приступы становятся заметно чаще), — начни с этого.
1. Итоги периода: дни с головной болью в пересчёте на месяц, из них похожих на мигрень; средняя и максимальная сила; типичная длительность; динамика по неделям. Эпизодическая или хроническая картина (хроническая — 15 и более дней с болью в месяц дольше 3 месяцев).
2. Характер приступов: какие признаки мигрени по ICHD-3 встречаются (односторонняя, пульсирующая, сила от умеренной, усиление от движения, тошнота или рвота, свето- и звукобоязнь, аура), а какие приступы больше похожи на головную боль напряжения.
3. Лекарства: дни с обезболивающими и отдельно с триптанами в месяц; риск лекарственно-индуцированной головной боли (порог — 10 дней в месяц для триптанов, эрготаминов, опиоидов и комбинированных, 15 — для простых обезболивающих и НПВС). Насколько помогает каждое средство и зависит ли эффект от того, как быстро после начала боли его приняли.
4. Провокаторы и защитные факторы: сон (время отхода ко сну и продолжительность), стресс и расслабление после него, пропуски еды, кофеин и его нехватка, алкоголь, экран, физическая нагрузка, перепады атмосферного давления (±5 гПа за сутки), менструальный цикл (особенно дни от −2 до +3 от начала менструации — так проявляется менструальная мигрень). Для каждого — насколько связь убедительна.
5. Ранние сигналы: что чаще всего бывает накануне приступа и может служить предупреждением.
6. Прогноз: на какие дни ближайших двух недель стоит обратить внимание и что можно сделать заранее.
7. Что обсудить с неврологом: 5–7 конкретных вопросов по моим данным.
8. Как вести дневник точнее: чего не хватает в записях, чтобы выводы стали надёжнее.
9. Выжимка для невролога: полстраницы — главные цифры, характер приступов, лекарства и их эффективность, ответ на профилактику, вероятные провокаторы. У каждого вывода пометка уверенности: высокая, средняя или низкая.
В конце задай мне 2–3 уточняющих вопроса, которые сильнее всего улучшат разбор.

Сводка за период ${from} — ${to}:
— заполнено ${s.logged_days} из ${s.total_days} дней (незаполненные дни — неизвестно, а не «без боли»);
— дней с головной болью ${s.headache_days} (≈${per30(s.headache_days)} в месяц), из них похожих на мигрень ${s.migraine_days}; приступов ${s.attack_count}, средняя сила ${s.avg_intensity ?? '—'} из 10;
— дней с обезболивающими ${s.med_days}; за последние 30 дней: триптаны и подобные — ${o.specific.days}, простые обезболивающие — ${o.simple.days}, всего — ${o.any.days};
— лекарства: ${meds.filter(m => !m.deleted || s.med_effect.some(e => e.name === m.name)).map(m => `${m.name} ${m.dose}`.trim() + ` (${KIND_RU[m.kind]})`).join('; ') || 'не указаны'};
— менструальный цикл: ${cycleText}${mwText ? `; ${mwText}` : ''}.
${profile ? `— обо мне: ${profile}.\n` : ''}${surveysText ? `— опросники: ${surveysText}.\n` : ''}${an.risk ? `— прогноз приложения на завтра: риск ${{ low: 'обычный', medium: 'немного выше обычного', high: 'повышенный' }[an.risk.level]}${an.risk.reasons.length ? ` (${an.risk.reasons.map(r => r.text).join(', ')})` : ''}.\n` : ''}
По месяцам:
${monthsText}
${medsText ? `\nЭффективность лекарств (оценка через 2 часа после приёма):\n${medsText}\n` : ''}${prevText ? `\nПрофилактическое лечение:\n${prevText}\n` : ''}
Дневник по дням (дата | боль: время, длительность, сила, где и какая, симптомы | лекарства | факторы | цикл | сон | давление | заметка):
${lines.join('\n') || '(записей за период нет)'}`;
}
