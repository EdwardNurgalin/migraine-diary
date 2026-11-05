// Diary modules and factors: the single source of truth for both the form and the analysis.
//
// Factor types:
//   level - 0 нет, 1 немного, 2 заметно, 3 сильно
//   count - whole number (cups, drinks)
//   hours - hours, step 0.5
//   bool  - yes / no
// `exposed` is the threshold from which a day counts as "the factor was present" in the analysis.

export const MODULES = [
  { key: 'emotions', title: 'Эмоции', icon: '🙂', factors: [
    { key: 'stress', label: 'Стресс', icon: '😣', type: 'level', exposed: 2 },
    { key: 'anxiety', label: 'Тревога', icon: '😟', type: 'level', exposed: 2 },
    { key: 'sadness', label: 'Грусть', icon: '😔', type: 'level', exposed: 2 },
    { key: 'irritation', label: 'Раздражение', icon: '😠', type: 'level', exposed: 2 },
    { key: 'relax', label: 'Расслабилась после стресса', icon: '😌', type: 'bool', exposed: true },
  ] },
  { key: 'sleep', title: 'Сон', icon: '🌙', factors: [
    { key: 'sleep_bad', label: 'Плохое качество сна', icon: '🛌', type: 'level', exposed: 2 },
    { key: 'wakeups', label: 'Просыпалась ночью', icon: '⏰', type: 'count', exposed: 2, max: 10 },
    { key: 'nap', label: 'Спала днём', icon: '💤', type: 'bool', exposed: true },
    { key: 'sleep_late', label: 'Легла позже обычного', icon: '🕐', type: 'bool', exposed: true },
  ] },
  { key: 'diet', title: 'Питание', icon: '🍽', factors: [
    { key: 'meal_skip', label: 'Пропустила приём пищи', icon: '🍽', type: 'bool', exposed: true },
    { key: 'coffee', label: 'Кофе, чашек', icon: '☕', type: 'count', exposed: 3, max: 10 },
    { key: 'caffeine_less', label: 'Меньше кофе, чем обычно', icon: '🫗', type: 'bool', exposed: true },
    { key: 'alcohol', label: 'Алкоголь, порций', icon: '🍷', type: 'count', exposed: 1, max: 10 },
    { key: 'chocolate', label: 'Шоколад', icon: '🍫', type: 'bool', exposed: true },
    { key: 'water_low', label: 'Мало воды', icon: '💧', type: 'bool', exposed: true },
  ] },
  { key: 'lifestyle', title: 'Образ жизни', icon: '🏃', factors: [
    { key: 'exercise', label: 'Физическая нагрузка', icon: '🏃', type: 'level', exposed: 2 },
    { key: 'outside', label: 'Время на улице, часов', icon: '🌳', type: 'hours', exposed: 1, max: 16 },
    { key: 'screen', label: 'За экраном, часов', icon: '💻', type: 'hours', exposed: 6, max: 18 },
    { key: 'overwork', label: 'Много работы', icon: '📋', type: 'bool', exposed: true },
  ] },
  { key: 'environment', title: 'Окружение', icon: '🌆', factors: [
    { key: 'bright_light', label: 'Яркий или мерцающий свет', icon: '💡', type: 'bool', exposed: true },
    { key: 'smell', label: 'Резкие запахи', icon: '👃', type: 'bool', exposed: true },
    { key: 'noise', label: 'Шум', icon: '🔊', type: 'bool', exposed: true },
    { key: 'stuffy', label: 'Духота или жара', icon: '🥵', type: 'bool', exposed: true },
  ] },
  { key: 'travel', title: 'Поездки', icon: '✈', factors: [
    { key: 'travel', label: 'Поездка или перелёт', icon: '✈', type: 'bool', exposed: true },
    { key: 'timezone', label: 'Смена часового пояса', icon: '🌐', type: 'bool', exposed: true },
  ] },
  { key: 'women', title: 'Женское здоровье', icon: '♀', factors: [
    // `period` is stored as its own field of the day; the form shows it here.
    { key: 'pms', label: 'ПМС', icon: '🌸', type: 'bool', exposed: true },
    { key: 'ovulation', label: 'Овуляция', icon: '🌼', type: 'bool', exposed: true },
  ] },
];

export const FACTORS = Object.fromEntries(MODULES.flatMap(m => m.factors.map(f => [f.key, f])));

// Factors derived from other data rather than asked for.
export const DERIVED = {
  period: { label: 'Менструация', icon: '🩸' },
  sleep_short: { label: 'Сон меньше 6 часов', icon: '🌙' },
  pressure_jump: { label: 'Скачок давления ≥5 гПа', icon: '🌦' },
};

export const DEFAULT_MODULES = MODULES.map(m => m.key);

export const MED_KINDS = ['simple', 'triptan', 'combo', 'opioid', 'ergot', 'preventive', 'other'];

export function isExposed(key, value) {
  const f = FACTORS[key];
  if (!f || value == null) return false;
  return f.type === 'bool' ? !!value : Number(value) >= f.exposed;
}

export function validValue(key, value) {
  const f = FACTORS[key];
  if (!f) return false;
  if (f.type === 'bool') return typeof value === 'boolean';
  if (typeof value !== 'number' || Number.isNaN(value)) return false;
  const hi = f.type === 'level' ? 3 : (f.max ?? 24);
  return value >= 0 && value <= hi;
}
