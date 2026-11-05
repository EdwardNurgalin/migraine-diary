// Aggregates for "Мои данные", the calendar and the doctor report.
import { FACTORS, isExposed } from './config.js';


// ICHD-3 medication-overuse thresholds: days per month with acute medication.
// Triptans, ergots, opioids and combination analgesics: >=10 days; simple analgesics/NSAIDs: >=15 days;
// any mix of acute classes: >=10 days.
const OVERUSE_LIMITS = { specific: 10, simple: 15, any: 10 };
const SPECIFIC_KINDS = new Set(['triptan', 'ergot', 'opioid', 'combo']);
const ACUTE_KINDS = new Set([...SPECIFIC_KINDS, 'simple']);

// Factor analysis is only shown once there is enough data for it to mean anything.
const MIN_DAYS_FOR_FACTORS = 30;
const MIN_FACTOR_DAYS = 5;
const TRIGGER_RATIO = 1.5;
const PROTECTOR_RATIO = 0.67;

const pad = n => String(n).padStart(2, '0');
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
export const today = () => iso(new Date());

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Rough ICHD-3 migraine features for a single attack (criteria C and D, or aura).
 * It is a hint for the diary and the doctor, not a diagnosis.
 */
export function isMigraine(a) {
  const loc = new Set(a.location), ch = new Set(a.character), sym = new Set(a.symptoms);
  if (sym.has('aura')) return true;
  const c = [
    loc.has('left') || loc.has('right') || loc.has('eye'),
    ch.has('pulsating'),
    a.intensity >= 4,
    sym.has('movement'),
  ].filter(Boolean).length;
  const d = sym.has('nausea') || sym.has('vomiting') || (sym.has('photo') && sym.has('phono'));
  return c >= 2 && d;
}

/** Distinct days with acute medication over the 30 days ending at `end`. */
export function overuse(days, medsById, end) {
  end = [end, today()].sort()[0];
  const start = addDays(end, -29);
  const sets = { specific: new Set(), simple: new Set(), any: new Set() };
  for (const day of days) {
    if (day.date < start || day.date > end) continue;
    for (const x of allDoses(day)) {
      const kind = medsById.get(x.med_id)?.kind;
      if (!ACUTE_KINDS.has(kind)) continue;
      sets.any.add(day.date);
      sets[SPECIFIC_KINDS.has(kind) ? 'specific' : 'simple'].add(day.date);
    }
  }
  const result = { from: start, to: end };
  let worst = 'ok';
  for (const [key, limit] of Object.entries(OVERUSE_LIMITS)) {
    const n = sets[key].size;
    const status = n >= limit ? 'over' : n >= limit - 2 ? 'warn' : 'ok';
    result[key] = { days: n, limit, status };
    if (status === 'over' || (status === 'warn' && worst === 'ok')) worst = status;
  }
  result.status = worst;
  return result;
}

export const allDoses = day => [...day.attacks.flatMap(a => a.doses), ...day.doses];

const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

/**
 * Menstrual cycle from the days marked "менструация": period starts, average cycle and period length,
 * and a forecast of the next period. The forecast needs at least one full cycle of plausible length.
 */
export function cycle(days) {
  const marked = days.filter(d => d.period).map(d => d.date).sort();
  const periods = [];
  for (const date of marked) {
    const last = periods.at(-1);
    // A gap of a day or two inside one period (a forgotten mark) still counts as the same period.
    if (last && daysBetween(last.end, date) <= 3) last.end = date;
    else periods.push({ start: date, end: date });
  }
  const lengths = [];
  for (let i = 1; i < periods.length; i++) {
    const len = daysBetween(periods[i - 1].start, periods[i].start);
    if (len >= 20 && len <= 45) lengths.push(len);
  }
  const avg = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const cycleLen = avg(lengths);
  const periodLen = avg(periods.map(p => daysBetween(p.start, p.end) + 1));
  let forecast = [];
  if (cycleLen && periods.length) {
    let start = addDays(periods.at(-1).start, cycleLen);
    // If the predicted start has already passed without a mark, move on to the next cycle.
    while (start < addDays(today(), -periodLen)) start = addDays(start, cycleLen);
    forecast = Array.from({ length: periodLen }, (_, i) => addDays(start, i));
  }
  return {
    periods, cycleLen, periodLen, forecast,
    /** Day of the cycle (1 = first day of period) or null if unknown. */
    dayOf(date) {
      const p = periods.filter(x => x.start <= date).at(-1);
      if (!p) return null;
      const n = daysBetween(p.start, date) + 1;
      return n <= (cycleLen || 45) + 10 ? n : null;
    },
  };
}

/**
 * @param days     day records in [from, to] (for overuse, the caller also passes the 30 days before `to`)
 * @param weather  {date: row}
 * @param health   {date: row}
 * @param meds     all medication records
 */
export function summary({ from, to, days, weather, health, meds, factors = FACTORS }) {
  const medsById = new Map(meds.map(m => [m.id, m]));
  const inRange = days.filter(d => d.date >= from && d.date <= to);
  const byDate = new Map(inRange.map(d => [d.date, d]));

  const attacks = inRange.flatMap(d => d.attacks.map(a => ({ ...a, date: d.date, migraine: isMigraine(a) })))
    .sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
  const maxIntensity = {}, migraineDays = new Set();
  for (const a of attacks) {
    maxIntensity[a.date] = Math.max(maxIntensity[a.date] || 0, a.intensity);
    if (a.migraine) migraineDays.add(a.date);
  }
  const medDays = new Set();
  const eff = new Map();
  for (const d of inRange) {
    for (const x of allDoses(d)) {
      const m = medsById.get(x.med_id);
      if (!m) continue;
      if (ACUTE_KINDS.has(m.kind)) medDays.add(d.date);
      const k = `${m.name}\u0000${m.dose}`;
      if (!eff.has(k)) eff.set(k, { name: m.name, dose: m.dose, count: 0, full: 0, partial: 0, none: 0, unknown: 0 });
      const e = eff.get(k);
      e.count++;
      e[x.effect || 'unknown']++;
    }
  }
  const headacheDays = new Set(inRange.filter(d => d.headache).map(d => d.date));

  const series = dateRange(from, to).map(date => {
    const day = byDate.get(date), w = weather[date] || {}, h = health[date] || {};
    return {
      date,
      logged: !!day,
      headache: headacheDays.has(date),
      type: !day ? null : migraineDays.has(date) ? 'migraine' : headacheDays.has(date) ? 'headache' : 'none',
      intensity: maxIntensity[date] || 0,
      meds: medDays.has(date),
      period: !!day?.period,
      pressure: w.pressure ?? null,
      pressure_delta: w.pressure_delta ?? null,
      temp: w.temp ?? null,
      sleep: day?.sleep_hours ?? h.sleep_hours ?? null,
      hrv: h.hrv ?? null,
    };
  });

  const count = key => {
    const c = new Map();
    for (const a of attacks) for (const v of a[key]) c.set(v, (c.get(v) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  };

  return {
    from, to,
    logged_days: inRange.length,
    total_days: series.length,
    headache_days: headacheDays.size,
    migraine_days: migraineDays.size,
    pain_free_days: inRange.length - headacheDays.size,
    attack_count: attacks.length,
    avg_intensity: attacks.length ? Math.round(attacks.reduce((s, a) => s + a.intensity, 0) / attacks.length * 10) / 10 : null,
    med_days: medDays.size,
    series,
    med_effect: [...eff.values()].sort((a, b) => b.count - a.count),
    symptoms: count('symptoms'),
    locations: count('location'),
    characters: count('character'),
    factors: factorAnalysis(inRange, series, factors),
    attacks,
    overuse: overuse(days, medsById, to),
  };
}

/**
 * Compare how often the head hurts on days with vs. without each factor.
 * A factor counts only on days where it was answered (missing key = unknown, not "no").
 */
function factorAnalysis(logged, series, defs) {
  if (logged.length < MIN_DAYS_FOR_FACTORS) {
    return { ready: false, need: MIN_DAYS_FOR_FACTORS, have: logged.length, items: [] };
  }
  const answered = {}, exposed = {};
  const mark = (k, date, isOn) => {
    (answered[k] ??= new Set()).add(date);
    exposed[k] ??= new Set();
    if (isOn) exposed[k].add(date);
  };
  for (const d of logged) {
    for (const [k, v] of Object.entries(d.factors || {})) if (defs[k]) mark(k, d.date, isExposed(defs[k], v));
    mark('period', d.date, d.period);
  }
  for (const p of series) {
    if (!p.logged) continue;
    if (p.pressure_delta != null) mark('pressure_jump', p.date, Math.abs(p.pressure_delta) >= 5);
    if (p.sleep != null) mark('sleep_short', p.date, p.sleep < 6);
  }

  const headache = new Set(logged.filter(d => d.headache).map(d => d.date));
  const items = [];
  for (const [f, base] of Object.entries(answered)) {
    const withF = exposed[f];
    const withoutF = [...base].filter(d => !withF.has(d));
    if (withF.size < MIN_FACTOR_DAYS || withoutF.length < MIN_FACTOR_DAYS) continue;
    const pWith = [...withF].filter(d => headache.has(d)).length / withF.size;
    const pWithout = withoutF.filter(d => headache.has(d)).length / withoutF.length;
    const ratio = pWithout ? pWith / pWithout : (pWith ? null : 1);
    items.push({
      factor: f,
      days: withF.size,
      p_with: Math.round(pWith * 100) / 100,
      p_without: Math.round(pWithout * 100) / 100,
      ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
      kind: ratio == null || ratio >= TRIGGER_RATIO ? 'trigger' : ratio <= PROTECTOR_RATIO ? 'protector' : 'neutral',
    });
  }
  // No ratio means the head never hurt without the factor: the strongest association, so it goes first.
  const r = x => x.ratio ?? Infinity;
  items.sort((a, b) => r(a) === r(b) ? 0 : r(b) > r(a) ? 1 : -1);
  return { ready: true, have: logged.length, preliminary: logged.length < 90, items };
}
