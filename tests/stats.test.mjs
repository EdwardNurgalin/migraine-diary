// Run: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, isMigraine, overuse, summary } from '../docs/stats.js';

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
