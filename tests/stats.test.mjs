// Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, cycle, isMigraine, medEfficacy, menstrualWindow, monthly, overuse, preventiveResponse, riskTomorrow, summary, today, typicalAttack } from '../docs/stats.js';
import { FACTORS } from '../docs/config.js';

const attack = over => ({ start_time: '10:00', end_time: '14:00', intensity: 5, location: [], character: [], symptoms: [], note: '', doses: [], ...over });

test('migraine: one-sided pulsating pain with nausea', () => {
  assert.equal(isMigraine(attack({ location: ['left'], character: ['pulsating'], symptoms: ['nausea'] })), true);
});
test('migraine: aura alone is enough', () => {
  assert.equal(isMigraine(attack({ intensity: 2, symptoms: ['aura'] })), true);
});
test('not migraine: pressing pain on both sides without nausea', () => {
  assert.equal(isMigraine(attack({ location: ['both'], character: ['pressing'], intensity: 3 })), false);
});
test('migraine: light AND sound sensitivity replace nausea', () => {
  assert.equal(isMigraine(attack({ intensity: 6, symptoms: ['photo', 'phono', 'movement'] })), true);
  assert.equal(isMigraine(attack({ intensity: 6, symptoms: ['photo', 'movement'] })), false);
});

const meds = [{ id: 1, name: 'Суматриптан', dose: '50', kind: 'triptan' }, { id: 2, name: 'Ибупрофен', dose: '400', kind: 'simple' },
  { id: 3, name: 'Пропранолол', dose: '40', kind: 'preventive' }];
const medsById = new Map(meds.map(m => [m.id, m]));
const day = (date, over = {}) => ({ date, headache: false, factors: {}, period: false, sleep_hours: null, note: '', attacks: [], doses: [], ...over });

test('overuse: 10 triptan days in 30 is "over", preventive does not count', () => {
  const end = '2026-10-30';
  const days = [];
  for (let i = 0; i < 10; i++) days.push(day(addDays(end, -i * 2), { doses: [{ med_id: 1, effect: 'full' }, { med_id: 3, effect: null }] }));
  const o = overuse(days, medsById, end);
  assert.equal(o.specific.days, 10);
  assert.equal(o.specific.status, 'over');
  assert.equal(o.simple.days, 0);
  assert.equal(o.status, 'over');
});
test('overuse: 13 ibuprofen days is "warn" (limit 15) but "over" for any-acute (limit 10)', () => {
  const end = '2026-10-30';
  const days = Array.from({ length: 13 }, (_, i) => day(addDays(end, -i), { doses: [{ med_id: 2, effect: 'partial' }] }));
  const o = overuse(days, medsById, end);
  assert.equal(o.simple.status, 'warn');
  assert.equal(o.any.status, 'over');
});

test('factors: poor sleep shows up as a trigger, outdoor time as a protector', () => {
  const to = '2026-10-30', from = addDays(to, -59);
  const days = [];
  for (let i = 0; i < 60; i++) {
    const date = addDays(from, i);
    const bad = i % 3 === 0, outside = i % 2 === 0;
    // Without time outside the head also hurts on every third-plus-one day, so outdoors halves the risk.
    const headache = bad || (!outside && i % 3 === 1);
    days.push(day(date, {
      headache,
      factors: { sleep_bad: bad ? 3 : 0, outside: outside ? 2 : 0 },
      attacks: headache ? [attack({})] : [],
    }));
  }
  const s = summary({ from, to, days, weather: {}, health: {}, meds });
  const f = Object.fromEntries(s.factors.items.map(x => [x.factor, x]));
  assert.equal(s.factors.ready, true);
  assert.equal(f.sleep_bad.kind, 'trigger');
  assert.equal(f.sleep_bad.p_with, 1);
  assert.equal(f.outside.kind, 'protector');
  assert.equal(s.logged_days, 60);
  assert.equal(s.series.length, 60);
});

test('factors: hidden until 30 days are logged', () => {
  const to = '2026-10-30', from = addDays(to, -9);
  const days = Array.from({ length: 10 }, (_, i) => day(addDays(from, i)));
  const s = summary({ from, to, days, weather: {}, health: {}, meds });
  assert.deepEqual([s.factors.ready, s.factors.have], [false, 10]);
});

test('cycle: 28-day cycle gives cycle day and a forecast after the last period', () => {
  const start = addDays(today(), -60);
  const days = [];
  for (const offset of [0, 28, 56]) for (let i = 0; i < 5; i++) days.push(day(addDays(start, offset + i), { period: true }));
  const c = cycle(days);
  assert.equal(c.periods.length, 3);
  assert.equal(c.cycleLen, 28);
  assert.equal(c.periodLen, 5);
  assert.equal(c.forecast[0], addDays(start, 84));
  assert.equal(c.forecast.length, 5);
  assert.equal(c.dayOf(addDays(start, 30)), 3);
});

test('cycle: a forgotten mark inside a period does not split it; no forecast from one period', () => {
  const s = '2026-10-01';
  const days = [0, 1, 3, 4].map(i => day(addDays(s, i), { period: true }));
  const c = cycle(days);
  assert.equal(c.periods.length, 1);
  assert.deepEqual(c.forecast, []);
});

test('factors: a factor that acts the next day is found with lag 1', () => {
  const to = '2026-10-30', from = addDays(to, -59);
  const days = [];
  for (let i = 0; i < 60; i++) {
    const date = addDays(from, i);
    const alcohol = i % 4 === 0;                     // alcohol every 4th day
    const headache = i % 4 === 1 || i % 8 === 0;     // always the day after, sometimes the same day
    days.push(day(date, { headache, factors: { alcohol: alcohol ? 2 : 0 }, attacks: headache ? [attack({})] : [] }));
  }
  const s = summary({ from, to, days, weather: {}, health: {}, meds });
  const a = s.factors.items.find(x => x.factor === 'alcohol');
  assert.equal(a.lag, 1);
  assert.equal(a.kind, 'trigger');
  assert.equal(a.p_with, 1);
});

test('monthly: headache, migraine and acute-medication days per month', () => {
  const days = [
    day('2026-09-10', { headache: true, attacks: [attack({ location: ['left'], character: ['pulsating'], symptoms: ['nausea'], doses: [{ med_id: 1, effect: 'full' }] })] }),
    day('2026-09-11'),
    day('2026-10-02', { headache: true, attacks: [attack({ doses: [{ med_id: 3, effect: null }] })] }),
  ];
  const m = monthly(days, medsById, '2026-09-01', '2026-10-31');
  assert.deepEqual(m.map(x => [x.month, x.logged, x.headache, x.migraine, x.med]), [['2026-09', 2, 1, 1, 1], ['2026-10', 1, 1, 0, 0]]);
});

test('menstrual window: attacks in days −2..+3 in 2 of 3 cycles → likely menstrual migraine', () => {
  const starts = ['2026-07-01', '2026-07-29', '2026-08-26'];
  const days = [];
  for (let d = '2026-06-26'; d <= '2026-09-05'; d = addDays(d, 1)) days.push(day(d, { period: starts.some(s => d >= s && d <= addDays(s, 4)) }));
  for (const d of ['2026-06-30', '2026-07-30']) Object.assign(days.find(x => x.date === d), { headache: true });
  const w = menstrualWindow(days, cycle(days));
  assert.equal(w.cycles, 3);
  assert.equal(w.with_attack, 2);
  assert.equal(w.likely, true);
});

test('medication efficacy: two-hour relief and early vs late intake', () => {
  const days = [
    day('2026-10-01', { headache: true, attacks: [attack({ start_time: '10:00', doses: [{ med_id: 1, time: '10:30', effect: 'full' }] })] }),
    day('2026-10-05', { headache: true, attacks: [attack({ start_time: '10:00', doses: [{ med_id: 1, time: '13:00', effect: 'none' }] })] }),
    day('2026-10-09', { headache: true, attacks: [attack({ start_time: '23:30', doses: [{ med_id: 1, time: '00:10', effect: 'partial' }] })] }),
  ];
  const [m] = medEfficacy(days, medsById);
  assert.deepEqual([m.n, m.free, m.better, m.none], [3, 1, 1, 1]);
  assert.deepEqual(m.early, { helped: 2, of: 2 });
  assert.deepEqual(m.late, { helped: 0, of: 1 });
  assert.equal(m.median_delay, 40);
});

test('preventive response: headache days per 30 before vs after the first month', () => {
  const start = '2026-06-01';
  const days = [];
  for (let i = -90; i < 120; i++) {
    const date = addDays(start, i);
    const headache = i < 0 ? i % 3 === 0 : i % 9 === 0;   // ~10 per 30 before, ~3.3 after
    days.push(day(date, { headache }));
  }
  const r = preventiveResponse(days, { name: 'Пропранолол', dose: '40', start_date: start, stop_date: addDays(start, 119) });
  assert.equal(r.before.per30, 10);
  assert.ok(r.after.per30 < 4);
  assert.equal(r.responder, true);
});

test('risk: rules first, then a personal model that is checked before use', () => {
  const t = '2026-10-30';
  const rules = riskTomorrow({
    days: [day(t, { factors: { stress: 3, alcohol: 2 }, sleep_hours: 5 })],
    cyc: { periods: [], forecast: [] }, weather: { [addDays(t, 1)]: { pressure_delta: -7 } }, defs: FACTORS, date: t,
  });
  assert.equal(rules.level, 'high');
  assert.ok(rules.reasons.some(r => r.key === 'pressure'));
  assert.equal(rules.model.ready, false);

  // 120 days where short sleep the night before reliably precedes pain.
  const days = [];
  for (let i = 0; i < 120; i++) {
    const date = addDays(t, -120 + i);
    const short = i % 3 === 0;
    const prevShort = (i - 1) % 3 === 0;
    days.push(day(date, { sleep_hours: short ? 5 : 8, headache: prevShort, attacks: prevShort ? [attack({})] : [] }));
  }
  const learned = riskTomorrow({ days, cyc: { periods: [], forecast: [] }, weather: {}, defs: FACTORS, date: days.at(-1).date });
  assert.equal(learned.model.ready, true);
  assert.ok(learned.model.auc >= 0.9);
});

test('typical attack: what at least half of the recent described attacks had', () => {
  const att = (location, character, symptoms) => ({ intensity: 6, location, character, symptoms, doses: [] });
  const days = [
    { date: '2026-01-01', attacks: [att(['left'], ['pulsating'], ['nausea', 'photo'])] },
    { date: '2026-01-05', attacks: [att(['left'], ['pulsating'], ['photo'])] },
    { date: '2026-01-09', attacks: [att([], [], [])] }, // not described: ignored
    { date: '2026-01-12', attacks: [att(['right'], ['pressing'], ['nausea', 'photo'])] },
  ];
  assert.equal(typicalAttack(days.slice(0, 2)), null); // fewer than 3 described attacks
  assert.deepEqual(typicalAttack(days), { location: ['left'], character: ['pulsating'], symptoms: ['photo', 'nausea'], of: 3 });
});
