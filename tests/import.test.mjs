import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateOf, timeOf, intensityOf, medKind, effectOf, pick, fromTable, fromJson, recognise } from '../docs/import.js';

test('dates and times in the shapes tables use', () => {
  assert.equal(dateOf('14.03.2025'), '2025-03-14');
  assert.equal(dateOf('2025-3-4'), '2025-03-04');
  assert.equal(dateOf(45730), '2025-03-14'); // Excel serial
  assert.equal(timeOf('9.30'), '09:30');
  assert.equal(timeOf(0.75), '18:00'); // Excel fraction of a day
  assert.equal(timeOf('14.03.2025 21:05'), '21:05');
  assert.equal(timeOf(''), null);
});

test('strength on any scale and in words; medicine types; effects; symptom words', () => {
  assert.equal(intensityOf(7), 7);
  assert.equal(intensityOf('2', 3), 7);
  assert.equal(intensityOf('сильная'), 7);
  assert.equal(medKind('Суматриптан'), 'triptan');
  assert.equal(medKind('Нурофен экспресс'), 'simple');
  assert.equal(medKind('Цитрамон'), 'combo');
  assert.equal(effectOf('не помогло'), 'none');
  assert.equal(effectOf('стало легче'), 'partial');
  assert.deepEqual(pick('тошнота, свет и шум', 'symptoms'), ['nausea', 'photo', 'phono']);
});

test('a table with two attacks on one day and a pain-free day', () => {
  const rows = [
    ['Дата', 'Болела', 'Начало', 'Сила 1-10', 'Где', 'Симптомы', 'Лекарство', 'Время приёма', 'Помогло'],
    ['14.03.2025', 'да', '09:30', '7', 'слева', 'тошнота', 'Суматриптан', '10:00', 'легче'],
    ['14.03.2025', 'да', '19:00', '5', 'виски', '', '', '', ''],
    ['15.03.2025', 'нет', '', '', '', '', '', '', ''],
  ];
  const r = fromTable(rows);
  assert.equal(r.length, 2);
  assert.equal(r[0].attacks.length, 2);
  assert.deepEqual(r[0].attacks[0].doses, [{ name: 'Суматриптан', dose: '', time: '10:00', effect: 'partial' }]);
  assert.deepEqual(r[0].attacks[1].location, ['temples']);
  assert.equal(r[1].headache, false);
});

test('JSON from the AI is checked: unknown symptom words are dropped', () => {
  const r = fromJson({ days: [{ date: '2025-03-14', attacks: [{ start: '9:30', intensity: 6, symptoms: ['nausea', 'banana'], meds: [{ name: 'Ибупрофен', effect: 'full' }] }] }] });
  assert.equal(r[0].headache, true);
  assert.deepEqual(r[0].attacks[0].symptoms, ['nausea']);
  assert.equal(r[0].attacks[0].start_time, '09:30');
  assert.equal(recognise({ json: { format: 'headache-diary-backup' } }).backup, true);
});

test('a 1–3 scale is stretched to 1–10; a bare "Время" column is the start', () => {
  const r = fromTable([['Дата', 'Время', 'Интенсивность'], ['01.04.2026', '9:00', '2'], ['02.04.2026', '18:00', '3']]);
  assert.deepEqual(r.map(x => [x.attacks[0].start_time, x.attacks[0].intensity]), [['09:00', 7], ['18:00', 10]]);
});

test('Migrebot export: survey time is not the pain start; medicines split; yes/no columns become symptoms', () => {
  const head = ['Дата', 'Время', 'Головная боль', 'Признаки мигрени', 'Аура', 'Менструальный цикл', 'Принятые медикаменты', 'Интенсивность боли', 'Локализация', 'Характер', 'Нагрузки', 'Тошнота', 'ФоТофобия', 'ФоНофобия', 'Триггеры', 'Начало боли', 'Окончание боли', 'Комментарии'];
  const rows = [head,
    ['2026-10-05', '19:15', 'Да', 'Да', 'Да', 'Нет', 'Капориза 10 мг и Налгезин 550 мг, Помогло', '3', 'Слева', 'Пульсировала', 'Да', 'Нет', 'Да', 'Да', 'Мало сна', 'Утром', 'Днём', 'легла спать'],
    ['2026-10-06', '20:10', 'Нет', '', 'Нет', 'Да', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const f = recognise({ sheets: [{ name: 'Записи опросов', rows }] });
  assert.equal(f.source, 'Migrebot');
  const [a] = f.records[0].attacks;
  assert.equal(a.start_time, null);
  assert.equal(a.intensity, 3);
  assert.deepEqual(a.symptoms.sort(), ['aura', 'movement', 'phono', 'photo']);
  assert.deepEqual(a.doses.map(x => [x.name, x.dose, x.effect]), [['Капориза', '10 мг', 'full'], ['Налгезин', '550 мг', 'full']]);
  assert.equal(medKind('Капориза'), 'triptan');
  assert.match(f.records[0].note, /мало сна/);
  assert.deepEqual([f.records[1].headache, f.records[1].period], [false, true]);
});
