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

/**
 * Her usual attack: what was noted in at least half of the last 10 described attacks.
 * Offered as one "как обычно" tap in the quick log; null until 3 attacks are described.
 */
export function typicalAttack(days) {
  const recent = days.flatMap(d => d.attacks)
    .filter(a => a.location.length || a.character.length || a.symptoms.length).slice(-10);
  if (recent.length < 3) return null;
  const common = key => {
    const c = new Map();
    for (const a of recent) for (const v of new Set(a[key])) c.set(v, (c.get(v) || 0) + 1);
    return [...c].filter(([, n]) => n / recent.length >= 0.5).sort((a, b) => b[1] - a[1]).map(([v]) => v);
  };
  const t = { location: common('location'), character: common('character'), symptoms: common('symptoms'), of: recent.length };
  return t.location.length || t.character.length || t.symptoms.length ? t : null;
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
export function cycle(days, manualLen = null) {
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
  // A cycle length entered in Settings wins: it allows a forecast from a single marked period.
  const cycleLen = manualLen || avg(lengths);
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
 * Compare how often the head hurts on days with vs. without each factor, on the same day and the day after
 * ("накануне"): many triggers act with a delay. A factor counts only on days where it was answered.
 * For each factor the stronger of the two associations is reported.
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

  const loggedDates = new Set(logged.map(d => d.date));
  const headache = new Set(logged.filter(d => d.headache).map(d => d.date));
  const compare = (withDays, withoutDays) => {
    if (withDays.length < MIN_FACTOR_DAYS || withoutDays.length < MIN_FACTOR_DAYS) return null;
    const pWith = withDays.filter(d => headache.has(d)).length / withDays.length;
    const pWithout = withoutDays.filter(d => headache.has(d)).length / withoutDays.length;
    const ratio = pWithout ? pWith / pWithout : (pWith ? null : 1);
    return { days: withDays.length, pWith, pWithout, ratio };
  };
  const strength = r => r.ratio == null ? Infinity : Math.abs(Math.log(Math.max(r.ratio, 0.01)));

  const items = [];
  for (const [f, base] of Object.entries(answered)) {
    const on = exposed[f];
    const same = compare([...on], [...base].filter(d => !on.has(d)));
    // Factor on day D-1, outcome on day D (both days logged).
    const next = d => addDays(d, 1);
    const lagged = compare(
      [...on].filter(d => loggedDates.has(next(d))).map(next),
      [...base].filter(d => !on.has(d) && loggedDates.has(next(d))).map(next));
    // Same day by default. The day-after link is used only for triggers, and only when it is stronger:
    // delayed effects are typical for triggers (alcohol, short sleep), while choosing the stronger of two
    // lags for everything would turn repeating patterns into false triggers.
    const isTrigger = r => r && (r.ratio == null || r.ratio >= TRIGGER_RATIO);
    const best = isTrigger(lagged) && (!same || (same.ratio != null && same.ratio < TRIGGER_RATIO && same.ratio > PROTECTOR_RATIO) || (isTrigger(same) && strength(lagged) > strength(same)))
      ? { ...lagged, lag: 1 } : same ? { ...same, lag: 0 } : null;
    if (!best) continue;
    items.push({
      factor: f,
      lag: best.lag,
      days: best.days,
      p_with: Math.round(best.pWith * 100) / 100,
      p_without: Math.round(best.pWithout * 100) / 100,
      ratio: best.ratio == null ? null : Math.round(best.ratio * 100) / 100,
      kind: best.ratio == null || best.ratio >= TRIGGER_RATIO ? 'trigger' : best.ratio <= PROTECTOR_RATIO ? 'protector' : 'neutral',
    });
  }
  // No ratio means the head never hurt without the factor: the strongest association, so it goes first.
  const r = x => x.ratio ?? Infinity;
  items.sort((a, b) => r(a) === r(b) ? 0 : r(b) > r(a) ? 1 : -1);
  return { ready: true, have: logged.length, preliminary: logged.length < 90, items };
}

/** Key clinical numbers per calendar month: headache, migraine and acute-medication days, scaled to 30 days. */
export function monthly(days, medsById, from, to) {
  const months = new Map();
  for (const date of dateRange(from, to)) {
    const k = date.slice(0, 7);
    if (!months.has(k)) months.set(k, { month: k, days: 0, logged: 0, headache: 0, migraine: 0, med: 0 });
    months.get(k).days++;
  }
  for (const d of days) {
    const m = months.get(d.date.slice(0, 7));
    if (!m || d.date < from || d.date > to) continue;
    m.logged++;
    if (d.headache) m.headache++;
    if (d.attacks.some(isMigraine)) m.migraine++;
    if (allDoses(d).some(x => ACUTE_KINDS.has(medsById.get(x.med_id)?.kind))) m.med++;
  }
  return [...months.values()].map(m => ({ ...m, headache_per30: m.logged ? Math.round(m.headache / m.logged * 30 * 10) / 10 : null }));
}

/**
 * Menstrually related migraine (ICHD-3 appendix A1.1): attacks starting from day −2 to day +3 of menstruation
 * in at least two of three cycles. Returns how many cycles had an attack in that window.
 */
export function menstrualWindow(days, cyc) {
  const pain = new Set(days.filter(d => d.headache).map(d => d.date));
  const logged = new Set(days.map(d => d.date));
  const cycles = cyc.periods.map(p => {
    const window = Array.from({ length: 6 }, (_, i) => addDays(p.start, i - 2));
    return { start: p.start, observed: window.filter(d => logged.has(d)).length >= 4, attack: window.some(d => pain.has(d)) };
  }).filter(c => c.observed);
  const painDays = [...pain];
  const inWindow = painDays.filter(d => cyc.periods.some(p => d >= addDays(p.start, -2) && d <= addDays(p.start, 3))).length;
  return {
    cycles: cycles.length,
    with_attack: cycles.filter(c => c.attack).length,
    pain_days: painDays.length,
    pain_in_window: inWindow,
    likely: cycles.length >= 3 && cycles.filter(c => c.attack).length / cycles.length >= 2 / 3,
  };
}

const toMin = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * Acute treatment: share of doses after which the pain was gone / better / unchanged two hours later,
 * the typical delay from the start of the attack, and whether taking it early (within an hour) worked better.
 */
export function medEfficacy(days, medsById) {
  const by = new Map();
  for (const d of days) for (const a of d.attacks) for (const x of a.doses) {
    const m = medsById.get(x.med_id);
    if (!m || m.kind === 'preventive') continue;
    if (!by.has(m.id)) by.set(m.id, { name: m.name, dose: m.dose, kind: m.kind, n: 0, rated: 0, free: 0, better: 0, none: 0, delays: [], early: [0, 0], late: [0, 0] });
    const e = by.get(m.id);
    e.n++;
    let delay = toMin(x.time) != null && toMin(a.start_time) != null ? toMin(x.time) - toMin(a.start_time) : null;
    if (delay != null && delay < 0) delay += 1440;
    if (delay != null) e.delays.push(delay);
    if (!x.effect) continue;
    e.rated++;
    e[{ full: 'free', partial: 'better', none: 'none' }[x.effect]]++;
    const helped = x.effect !== 'none' ? 1 : 0;
    if (delay != null) { const g = delay <= 60 ? e.early : e.late; g[0] += helped; g[1]++; }
  }
  return [...by.values()].map(e => ({
    name: e.name, dose: e.dose, kind: e.kind, n: e.n, rated: e.rated, free: e.free, better: e.better, none: e.none,
    median_delay: median(e.delays),
    early: e.early[1] ? { helped: e.early[0], of: e.early[1] } : null,
    late: e.late[1] ? { helped: e.late[0], of: e.late[1] } : null,
  })).sort((a, b) => b.n - a.n);
}

/**
 * Preventive treatment: headache days per 30 logged days in the 90 days before the start
 * versus from day 31 after the start (the first month is usually too early to judge).
 * A drop of at least 50% is the usual definition of a good response.
 */
export function preventiveResponse(days, med) {
  if (!med.start_date) return null;
  const rate = (from, to) => {
    const ds = days.filter(d => d.date >= from && d.date <= to);
    return ds.length >= 20 ? { logged: ds.length, per30: Math.round(ds.filter(d => d.headache).length / ds.length * 30 * 10) / 10 } : null;
  };
  const before = rate(addDays(med.start_date, -90), addDays(med.start_date, -1));
  const after = rate(addDays(med.start_date, 30), med.stop_date || today());
  const change = before && after && before.per30 ? Math.round((after.per30 - before.per30) / before.per30 * 100) : null;
  return { name: med.name, dose: med.dose, start: med.start_date, stop: med.stop_date || null, before, after, change, responder: change != null && change <= -50 };
}

// ---------- risk for tomorrow ----------

const RISK_REASONS = {
  period: ['ожидается менструация', 'Держите лекарство под рукой и примите его при первых признаках боли.'],
  pressure: ['перепад атмосферного давления', 'Пейте воду, не пропускайте еду, планируйте спокойный день.'],
  sleep: ['мало сна', 'Постарайтесь лечь вовремя.'],
  prodrome: ['есть ранние сигналы', 'При первых признаках боли не откладывайте лекарство.'],
  alcohol: ['был алкоголь', 'Пейте больше воды вечером.'],
  stress: ['сильный стресс', 'Запланируйте отдых: после стресса приступ часто начинается в выходной.'],
  pain: ['сегодня болела голова', 'Если боль вернётся, отметьте это — так видно повторные приступы.'],
};

function riskFeatures(day, nextDate, inWindow, weatherNext, defs) {
  const f = day?.factors || {};
  const prodrome = Object.entries(f).filter(([k, v]) => defs[k]?.module === 'prodrome' && v).length;
  return {
    period: inWindow(nextDate) ? 1 : 0,
    pressure: Math.abs(weatherNext?.pressure_delta ?? 0) >= 5 ? 1 : 0,
    sleep: day?.sleep_hours != null && day.sleep_hours < 6 || (f.sleep_bad ?? 0) >= 2 ? 1 : 0,
    prodrome: prodrome >= 2 ? 1 : 0,
    alcohol: (f.alcohol ?? 0) >= 1 ? 1 : 0,
    stress: (f.stress ?? 0) >= 2 ? 1 : 0,
    pain: day?.headache ? 1 : 0,
  };
}

const sigmoid = z => 1 / (1 + Math.exp(-z));

function fitLogistic(X, y, iters = 400, lr = 0.3, l2 = 0.05) {
  const k = X[0].length;
  const w = new Array(k + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(k + 1).fill(0);
    X.forEach((x, i) => {
      const err = sigmoid(w[0] + x.reduce((s, v, j) => s + v * w[j + 1], 0)) - y[i];
      g[0] += err;
      x.forEach((v, j) => { g[j + 1] += err * v; });
    });
    for (let j = 0; j <= k; j++) w[j] -= lr * (g[j] / X.length + (j ? l2 * w[j] : 0));
  }
  return x => sigmoid(w[0] + x.reduce((s, v, j) => s + v * w[j + 1], 0));
}

function auc(scores, y) {
  const pos = scores.filter((_, i) => y[i]), neg = scores.filter((_, i) => !y[i]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return Math.round(wins / (pos.length * neg.length) * 100) / 100;
}

/**
 * Risk of a headache tomorrow. Simple rules at first; with 60+ pairs of consecutive logged days
 * a personal logistic model is trained, checked on the most recent quarter of the data, and used only
 * if it beats chance (AUC ≥ 0.6). The honest accuracy is returned with the result.
 */
export function riskTomorrow({ days, cyc, weather, defs, date = today() }) {
  const byDate = new Map(days.map(d => [d.date, d]));
  const starts = [...cyc.periods.map(p => p.start), ...(cyc.forecast.length ? [cyc.forecast[0]] : [])];
  const inWindow = d => starts.some(s => d >= addDays(s, -2) && d <= addDays(s, 3));
  const keys = Object.keys(RISK_REASONS);
  const tomorrow = addDays(date, 1);
  const feats = riskFeatures(byDate.get(date), tomorrow, inWindow, weather[tomorrow], defs);
  const reasons = keys.filter(k => feats[k]).map(k => ({ key: k, text: RISK_REASONS[k][0], tip: RISK_REASONS[k][1] }));

  const pairs = days.filter(d => byDate.has(addDays(d.date, 1)) && d.date < date).sort((a, b) => a.date.localeCompare(b.date));
  const X = pairs.map(d => keys.map(k => riskFeatures(d, addDays(d.date, 1), inWindow, weather[addDays(d.date, 1)], defs)[k]));
  const y = pairs.map(d => byDate.get(addDays(d.date, 1)).headache ? 1 : 0);
  const positives = y.filter(Boolean).length;
  let model = { ready: false, need: 60, have: pairs.length };
  if (pairs.length >= 60 && positives >= 8 && pairs.length - positives >= 8) {
    const cut = Math.floor(pairs.length * 0.75);
    const test = fitLogistic(X.slice(0, cut), y.slice(0, cut));
    const score = auc(X.slice(cut).map(test), y.slice(cut));
    const predict = fitLogistic(X, y);
    const base = positives / pairs.length;
    model = { ready: score != null && score >= 0.6, auc: score, have: pairs.length, base: Math.round(base * 100) };
    if (model.ready) {
      const p = predict(keys.map(k => feats[k]));
      model.prob = Math.round(p * 100);
      return { model, level: p >= Math.max(base * 1.5, 0.35) ? 'high' : p >= base * 1.15 ? 'medium' : 'low', reasons };
    }
  }
  return { model, level: reasons.length >= 2 ? 'high' : reasons.length === 1 ? 'medium' : 'low', reasons };
}
