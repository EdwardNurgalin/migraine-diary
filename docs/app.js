import * as api from './api.js';

const BACKUP_EVERY_MS = 7 * 24 * 3600 * 1000;

// ---------- dictionaries (factors and modules come from /api/config) ----------

const L = {
  location: { left: 'Слева', right: 'Справа', both: 'С двух сторон', forehead: 'Лоб', temples: 'Виски', back: 'Затылок', eye: 'Вокруг глаза' },
  character: { pulsating: 'Пульсирующая', pressing: 'Давящая', squeezing: 'Сжимающая', stabbing: 'Колющая', dull: 'Тупая' },
  symptoms: {
    nausea: ['Тошнота', '🤢'], vomiting: ['Рвота', '🤮'], photo: ['Мешает свет', '🔆'], phono: ['Мешают звуки', '🔊'],
    smell: ['Мешают запахи', '👃'], aura: ['Аура (вспышки, зигзаги, онемение)', '✨'], dizziness: ['Головокружение', '💫'],
    movement: ['Хуже от движения', '🚶'],
  },
  kinds: {
    simple: 'Обезболивающее / НПВС', triptan: 'Триптан', combo: 'Комбинированное', opioid: 'Опиоид',
    ergot: 'Эрготамин', preventive: 'Профилактика', other: 'Другое',
  },
  effects: { full: 'Помогло', partial: 'Частично', none: 'Не помогло' },
  types: { none: 'Без головной боли', headache: 'Головная боль', migraine: 'Похоже на мигрень' },
};
const LEVELS = ['Нет', 'Немного', 'Заметно', 'Сильно'];
const INTENSITY_WORDS = ['', 'слабая', 'слабая', 'слабая', 'умеренная', 'умеренная', 'умеренная', 'сильная', 'сильная', 'очень сильная', 'невыносимая'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// ---------- helpers ----------

const $view = document.getElementById('view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const today = () => iso(new Date());
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = s => { const d = parseISO(s); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; };
const fmtDateFull = s => { const d = parseISO(s); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`; };
const dayWord = s => s === today() ? 'сегодня' : s === addDays(today(), -1) ? 'вчера' : fmtDate(s);
const pct = x => `${Math.round(x * 100)}%`;
const labelsOf = (dict, keys) => keys.map(k => (Array.isArray(dict[k]) ? dict[k][0] : dict[k]) || k).join(', ');

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// Opened from the Home Screen icon (not a Safari tab). On iPhone these two have separate storage.
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let CFG = null, meds = [];
async function loadBase() { [CFG, meds] = await Promise.all([api.config(), api.meds()]); }
const medById = id => meds.find(m => m.id === id);
const enabledModules = () => CFG.modules.filter(m => CFG.enabled.includes(m.key))
  .map(m => ({ ...m, factors: m.factors.filter(f => f.enabled) }));
function factorDef(k) {
  for (const m of CFG.modules) for (const f of m.factors) if (f.key === k) return f;
  return CFG.derived[k] ? { key: k, ...CFG.derived[k] } : { key: k, label: k, icon: '•' };
}
function isExposed(f, v) { return v != null && (f.type === 'bool' ? !!v : v >= f.exposed); }
function factorValueText(f, v) {
  if (f.type === 'bool') return v ? 'Да' : 'Нет';
  if (f.type === 'level') return LEVELS[v || 0];
  return String(v || 0);
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, val) {
  const keys = path.split('.'); const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = val;
}

// ---------- router ----------

const TAB_OF = { diary: 'diary', log: 'diary', attack: 'diary', calendar: 'calendar', data: 'data', report: 'data', settings: 'settings' };

async function route() {
  let [name, a, b] = (location.hash.slice(1) || 'diary').split('/');
  if (name === 'today' || name === 'day') name = 'diary';
  wz = null;
  if (name !== 'attack') attackState = null;
  document.body.classList.toggle('wizard', name === 'log');
  document.body.classList.toggle('attack', name === 'attack');
  applyDim(name === 'attack' ? 0.2 : 0);
  document.querySelectorAll('.tabs a').forEach(el => el.classList.toggle('on', el.dataset.tab === TAB_OF[name]));
  window.scrollTo(0, 0);
  const valid = d => d && /^\d{4}-\d\d-\d\d$/.test(d) && d <= today() ? d : today();
  const views = {
    diary: () => renderDiary(valid(a)),
    log: () => startWizard(valid(a), b === 'yes'),
    attack: async () => renderAttack(),
    calendar: () => renderCalendar(a || today().slice(0, 7)),
    data: () => renderData(Number(a) || 30),
    report: () => renderReport(a, b),
    settings: renderSettings,
  };
  try {
    if (!CFG) await loadBase();
    await (views[name] || views.diary)();
  } catch (e) {
    console.error(e);
    $view.innerHTML = `<div class="card"><h2>Не получилось загрузить</h2><p class="muted">${esc(e.message)}</p><button onclick="route()">Повторить</button></div>`;
  }
}
window.route = route;
window.addEventListener('hashchange', route);

// ---------- theme & brightness ----------

const THEMES = {
  moss: { name: 'Мох', bar: '#171c1a', sw: ['#171c1a', '#7fa88f', '#c3916f', '#94738a'] },
  dusk: { name: 'Сумерки', bar: '#1d1a17', sw: ['#1d1a17', '#8fa88f', '#cf9a7c', '#a08bb8'] },
  paper: { name: 'Бумага', bar: '#ebe6dc', sw: ['#ebe6dc', '#8fb8a0', '#d4a07c', '#a693c4'] },
};
// UI preferences live in localStorage: they only matter on this device and are safe to lose.
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
function applyTheme(t) {
  if (!THEMES[t]) t = 'moss';
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = THEMES[t].bar;
}
// `dim` is 0 (normal) to 0.5 (much darker); attack mode adds a little on top.
function applyDim(extra = 0) {
  document.getElementById('dim').style.opacity = String(Math.min(Number(pref.get('dim', 0)) + extra, 0.7));
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const TYPE_COLOR = { none: 'var(--none)', headache: 'var(--ha)', migraine: 'var(--mi)' };

// ---------- diary home ----------

// Minimal marks: only pain days are filled; pain-free days are plain numbers, unfilled days are faint.
function numClass(p, selected) {
  const cls = ['num'];
  if (p.type === 'headache' || p.type === 'migraine') cls.push(`t-${p.type}`);
  else if (!p.logged) cls.push('unlogged');
  if (p.date === selected) cls.push('sel');
  return cls.join(' ');
}

async function renderDiary(d) {
  const end = [addDays(d, 3), today()].sort()[0], start = addDays(end, -6);
  const [day, s, set] = await Promise.all([api.day(d), api.summary(start, end), api.settings()]);
  const backupDue = s.logged_days > 0 && (!set.last_backup || Date.now() - set.last_backup > BACKUP_EVERY_MS);
  if (backupDue) await prepareBackup();
  const strip = s.series.map(p => {
    const dt = parseISO(p.date);
    return `<a href="#diary/${p.date}" aria-label="${fmtDate(p.date)}${p.type ? ', ' + L.types[p.type] : ', не заполнен'}">
      <span class="dn">${DOW[(dt.getDay() + 6) % 7]}</span><span class="${numClass(p, d)}">${dt.getDate()}${p.meds ? '<i class="medmark"></i>' : ''}</span></a>`;
  }).join('');

  $view.innerHTML = `
    <h1>Дневник</h1>
    ${showInstallHint() ? `<div class="banner warn hint"><button class="ghost" data-hide-hint aria-label="Скрыть подсказку">✕</button>
      <b>Добавьте дневник на экран «Домой»</b>
      <p style="font-size:14px">«Поделиться» → «На экран „Домой“». Дальше открывайте иконку: записи из вкладки Safari в ней не появятся.</p></div>` : ''}
    <div class="weekstrip">${strip}<a class="calbtn" href="#calendar/${d.slice(0, 7)}" aria-label="Календарь">▦</a></div>
    ${day.day ? dayCard(day) : `
      <p class="question">Болела ли голова ${dayWord(d)}?</p>
      <a class="choice no" href="#log/${d}/no"><span class="ic">✓</span><span>Нет, всё спокойно<small>Отметить, как прошёл день</small></span></a>
      <a class="choice yes" href="#log/${d}/yes"><span class="ic">∿</span><span>Да, болела<small>Приступ, лекарства и факторы</small></span></a>`}
    ${d === today() ? '<a class="attackbtn" href="#attack">☾ Болит сейчас — записать в два касания</a>' : ''}
    ${s.overuse.status !== 'ok' ? overuseBanner(s.overuse) : ''}
    ${backupDue ? `<div class="banner ok"><b>Пора сделать резервную копию</b>
      <p style="font-size:14px">Записи хранятся только в этом телефоне. Сохраните копию в «Файлы» или iCloud Drive — раз в неделю достаточно.</p>
      <button class="primary" data-backup style="margin-top:6px">Сохранить копию</button></div>` : ''}`;
  $view.querySelector('[data-backup]')?.addEventListener('click', () => saveBackup().catch(err => toast(err.message)));
  $view.querySelector('[data-hide-hint]')?.addEventListener('click', e => { pref.set('install_hint_hidden', '1'); e.target.closest('.banner').remove(); });
}

// The hint matters only in Safari on iPhone/iPad, where the browser tab and the Home Screen app keep separate data.
const showInstallHint = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone() && pref.get('install_hint_hidden') !== '1';

const dayType = data => !data.day.headache ? 'none' : data.attacks.some(x => x.migraine) ? 'migraine' : 'headache';
const doseText = x => { const m = medById(x.med_id); return `${esc(m ? m.name : '?')}${x.effect ? ' — ' + L.effects[x.effect].toLowerCase() : ''}`; };

function dayCard(data) {
  const day = data.day, a = data.attacks[0], type = dayType(data);
  const exposed = Object.entries(day.factors).map(([k, v]) => [factorDef(k), v]).filter(([f, v]) => f.type && isExposed(f, v));
  const allDoses = [...data.attacks.flatMap(x => x.doses), ...data.doses];
  const w = data.weather;
  const rows = [];
  if (a) {
    rows.push(['Время', a.start_time ? `${a.start_time}${a.end_time ? ' – ' + a.end_time : ' – ещё болит'}` : '—']);
    rows.push(['Сила', `${a.intensity} из 10 · ${INTENSITY_WORDS[a.intensity]}`]);
    if (a.location.length || a.character.length) rows.push(['Боль', esc([labelsOf(L.location, a.location), labelsOf(L.character, a.character)].filter(Boolean).join('; '))]);
    if (a.symptoms.length) rows.push(['Симптомы', esc(labelsOf(L.symptoms, a.symptoms))]);
  }
  if (allDoses.length) rows.push(['Лекарства', allDoses.map(doseText).join('<br>')]);
  if (day.sleep_hours != null) rows.push(['Сон', `${fmtHours(day.sleep_hours)}${day.sleep_start && day.sleep_end ? ` · ${day.sleep_start}–${day.sleep_end}` : ''}`]);
  if (day.period) rows.push(['Цикл', 'Менструация']);
  if (exposed.length) rows.push(['Факторы', `<div class="tags">${exposed.map(([f, v]) => `<span class="tag">${f.icon} ${esc(f.label)}${f.type !== 'bool' ? ': ' + factorValueText(f, v).toLowerCase() : ''}</span>`).join('')}</div>`]);
  if (w) rows.push(['Погода', `${w.pressure ?? '—'} гПа${w.pressure_delta != null ? ` (${w.pressure_delta > 0 ? '+' : ''}${w.pressure_delta})` : ''}, ${w.temp ?? '—'}°C`]);
  if (day.note) rows.push(['Заметка', esc(day.note)]);
  return `
    <div class="daycard">
      <div class="dc-head"><i style="background:${TYPE_COLOR[type]}"></i><b>${L.types[type]}</b><span>${fmtDate(data.date)}</span></div>
      ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')}
    </div>
    <a class="btn wide" href="#log/${data.date}/${day.headache ? 'yes' : 'no'}">Изменить запись</a>
    ${type === 'migraine' ? '<p class="muted center" style="margin-top:12px">«Похоже на мигрень» — по признакам приступа (ICHD-3). Диагноз ставит врач.</p>' : ''}`;
}

// ---------- step-by-step entry ----------

let wz = null;

async function startWizard(d, headache) {
  const data = await api.day(d);
  const day = data.day;
  const a = data.attacks[0];
  const toDose = x => ({ med_id: x.med_id, time: x.time || '', effect: x.effect });
  const draft = {
    headache,
    factors: { ...(day?.factors || {}) },
    period: !!day?.period,
    sleep_hours: day?.sleep_hours ?? data.health?.sleep_hours ?? null,
    sleep_start: day?.sleep_start || '',
    sleep_end: day?.sleep_end || '',
    note: day?.note || '',
    attack: a ? {
      start_time: a.start_time || '', end_time: a.end_time || '', intensity: a.intensity,
      location: a.location, character: a.character, symptoms: a.symptoms, note: a.note, doses: a.doses.map(toDose),
    } : { start_time: d === today() ? nowTime() : '', end_time: '', intensity: 5, location: [], character: [], symptoms: [], note: '', doses: [] },
    doses: data.doses.map(toDose),
  };
  // Old days and in-between edits may hold doses on the "other" side; keep them visible in this flow.
  if (!headache && a) draft.doses = [...draft.doses, ...draft.attack.doses];
  if (headache && !a) { draft.attack.doses = [...draft.attack.doses, ...draft.doses]; draft.doses = []; }

  const modules = enabledModules().map(m => ({ kind: 'module', module: m }));
  const steps = headache
    ? [{ kind: 'attack' }, { kind: 'symptoms' }, { kind: 'meds' }, ...modules, { kind: 'notes' }]
    : [...modules, { kind: 'meds' }, { kind: 'notes' }];
  wz = { date: d, steps, step: 0, draft, dirty: false, existed: !!day, healthSleep: day?.sleep_hours == null && data.health?.sleep_hours != null };
  drawWizard();
}

function factorControl(f, v) {
  if (f.type === 'bool') return `<button class="switch ${v ? 'on' : ''}" data-act="fbool" data-k="${f.key}" role="switch" aria-checked="${!!v}" aria-label="${esc(f.label)}"></button>`;
  if (f.type === 'level') return '';
  return `<div class="stepper">
    <button data-act="fstep" data-k="${f.key}" data-d="-1" aria-label="Меньше">−</button>
    <b>${v || 0}</b>
    <button data-act="fstep" data-k="${f.key}" data-d="1" aria-label="Больше">+</button></div>`;
}

function factorRow(f, v) {
  const levels = f.type === 'level'
    ? `<div class="levels">${LEVELS.map((t, i) => `<button class="${(v || 0) === i ? 'on' : ''}" data-act="flevel" data-k="${f.key}" data-v="${i}">${t}</button>`).join('')}</div>` : '';
  return `<div class="frow"><span class="fic">${f.icon}</span>
    <div class="fbody"><div class="flabel">${esc(f.label)}</div>${f.type === 'level' ? levels : f.type === 'bool' ? `<div class="fval">${factorValueText(f, v)}</div>` : ''}</div>
    ${factorControl(f, v)}</div>`;
}

// Hours and minutes as two lists, so time is always 24-hour whatever the phone's region settings.
function timeField(path, value, label = '') {
  const [h, m] = value ? value.split(':') : ['', ''];
  const mins = [...new Set([...Array.from({ length: 12 }, (_, i) => pad(i * 5)), ...(m ? [m] : [])])].sort();
  const opt = (x, cur) => `<option ${x === cur ? 'selected' : ''}>${x}</option>`;
  return `${label ? `<span class="tlabel">${label}</span>` : ''}<div class="tfield" data-path="${path}">
    <select data-time="h" aria-label="${label || 'Время'}: часы"><option value="">--</option>${Array.from({ length: 24 }, (_, i) => opt(pad(i), h)).join('')}</select>
    <b>:</b>
    <select data-time="m" aria-label="${label || 'Время'}: минуты"><option value="">--</option>${mins.map(x => opt(x, m)).join('')}</select></div>`;
}

const sleepHours = (a, b) => {
  if (!a || !b) return null;
  let m = (+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3));
  if (m <= 0) m += 1440;
  return Math.round(m / 6) / 10;
};
const fmtHours = h => h == null ? '' : `${Math.floor(h)} ч${Math.round(h % 1 * 60) ? ` ${Math.round(h % 1 * 60)} мин` : ''}`;

function pills(path, dict, selected) {
  return `<div class="pills">${Object.entries(dict).map(([k, v]) =>
    `<button class="pill ${selected.includes(k) ? 'on' : ''}" data-act="toggle" data-path="${path}" data-val="${k}">${esc(v)}</button>`).join('')}</div>`;
}

function doseList(path, list) {
  const active = meds.filter(m => m.active);
  if (!meds.length) return `<div class="card"><p>Сначала добавьте свои лекарства в <a href="#settings">Настройках</a>.</p></div>`;
  return `<div class="list">${list.map((x, i) => `
    <div class="dose">
      <div class="row">
        <select data-path="${path}.${i}.med_id" data-type="number" aria-label="Лекарство">
          ${meds.filter(m => m.active || m.id === x.med_id).map(m => `<option value="${m.id}" ${m.id === x.med_id ? 'selected' : ''}>${esc(m.name)} ${esc(m.dose)}</option>`).join('')}
        </select>
        <div class="tcompact">${timeField(`${path}.${i}.time`, x.time)}</div>
        <button class="ghost" data-act="rm-dose" data-path="${path}" data-i="${i}" aria-label="Удалить">✕</button>
      </div>
      <div class="pills" style="margin-top:10px">${Object.entries(L.effects).map(([k, v]) =>
        `<button class="pill teal ${x.effect === k ? 'on' : ''}" data-act="effect" data-path="${path}.${i}.effect" data-val="${k}">${v}</button>`).join('')}</div>
    </div>`).join('')}</div>
    ${active.length ? `<button class="wide" style="margin-top:10px" data-act="add-dose" data-path="${path}">+ Добавить приём</button>` : ''}`;
}

function stepBody(st) {
  const dr = wz.draft, a = dr.attack, when = dayWord(wz.date);
  switch (st.kind) {
    case 'attack': return `
      <h1>Приступ</h1><p class="wiz-sub">${fmtDateFull(wz.date)}</p>
      <div class="card">
        <div class="row" style="flex-wrap:nowrap">
          <div class="field" style="flex:1">${timeField('attack.start_time', a.start_time, 'Началась')}</div>
          <div class="field" style="flex:1">${timeField('attack.end_time', a.end_time, 'Закончилась')}</div>
        </div>
        <p class="muted">Если ещё болит, оставьте «Закончилась» пустым и допишите позже.</p>
      </div>
      <div class="card">
        <h2>Насколько сильно</h2>
        <div class="intensity-big"><b id="intVal">${a.intensity}</b><span id="intWord">${INTENSITY_WORDS[a.intensity]}</span></div>
        <input type="range" min="1" max="10" data-path="attack.intensity" data-type="number" value="${a.intensity}" aria-label="Сила боли от 1 до 10">
        <div class="spread muted" style="margin-top:6px"><span>слабая</span><span>невыносимая</span></div>
      </div>
      <h3>Где болит</h3>${pills('attack.location', L.location, a.location)}
      <h3>Какая боль</h3>${pills('attack.character', L.character, a.character)}`;
    case 'symptoms': return `
      <h1>Симптомы</h1><p class="wiz-sub">Что ещё было во время приступа</p>
      <div class="list">${Object.entries(L.symptoms).map(([k, [label, icon]]) => `
        <div class="frow"><span class="fic pink">${icon}</span><div class="fbody"><div class="flabel">${label}</div></div>
          <button class="switch ${a.symptoms.includes(k) ? 'on' : ''}" data-act="toggle" data-path="attack.symptoms" data-val="${k}" role="switch" aria-label="${esc(label)}"></button></div>`).join('')}
      </div>`;
    case 'meds': return dr.headache
      ? `<h1>Лекарства</h1><p class="wiz-sub">Что принимали от этого приступа и помогло ли</p>${doseList('attack.doses', a.doses)}`
      : `<h1>Лекарства</h1><p class="wiz-sub">Если принимали что-то ${when} — например, профилактику</p>${doseList('doses', dr.doses)}`;
    case 'module': {
      const m = st.module;
      const extra = m.key === 'sleep' ? `
        <div class="frow sleeprow"><span class="fic">🌙</span><div class="fbody">
          <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
            <div style="flex:1">${timeField('sleep_start', dr.sleep_start, 'Заснула')}</div>
            <div style="flex:1">${timeField('sleep_end', dr.sleep_end, 'Проснулась')}</div>
          </div>
          <div class="fval" id="sleepDur">${dr.sleep_hours != null ? `Сон: ${fmtHours(dr.sleep_hours)}${!dr.sleep_start && wz.healthSleep ? ' (из «Здоровья»)' : ''}` : 'Укажите, когда заснули и проснулись'}</div>
        </div></div>`
        : m.key === 'women' ? `
        <div class="frow"><span class="fic">🩸</span><div class="fbody"><div class="flabel">Менструация</div><div class="fval">${dr.period ? 'Да' : 'Нет'}</div></div>
          <button class="switch ${dr.period ? 'on' : ''}" data-act="period" role="switch" aria-label="Менструация"></button></div>` : '';
      return `<h1>${m.icon} ${m.title}</h1><p class="wiz-sub">Что было ${when}</p>
        <div class="list">${extra}${m.factors.map(f => factorRow(f, dr.factors[f.key])).join('')}</div>`;
    }
    case 'notes': return `
      <h1>Заметка</h1><p class="wiz-sub">Всё, что кажется важным: что ели, где были, что помогло</p>
      <textarea data-path="note" placeholder="Необязательно">${esc(dr.note)}</textarea>
      ${wz.existed ? `<button class="ghost danger wide" style="margin-top:18px" data-act="delete">Удалить запись за ${fmtDate(wz.date)}</button>` : ''}`;
  }
}

function drawWizard() {
  const st = wz.steps[wz.step], last = wz.step === wz.steps.length - 1;
  $view.innerHTML = `
    <div class="wiz-top">
      <button class="x" data-act="close" aria-label="Закрыть">✕</button>
      <div class="progress" role="progressbar" aria-valuenow="${wz.step + 1}" aria-valuemax="${wz.steps.length}"><i style="width:${(wz.step + 1) / wz.steps.length * 100}%"></i></div>
      <span class="muted">${wz.step + 1}/${wz.steps.length}</span>
    </div>
    ${stepBody(st)}
    <div class="wiz-bar"><div>
      <button data-act="back" ${wz.step === 0 ? 'disabled' : ''}>Назад</button>
      <button class="primary" data-act="next">${last ? 'Сохранить' : 'Далее'}</button>
    </div></div>`;
}

function redraw() {
  const y = window.scrollY;
  drawWizard();
  window.scrollTo(0, y);
}

function wizardPayload() {
  const dr = wz.draft;
  // Every factor of a shown module counts as answered (unchanged = "нет" / 0), like a paper diary row.
  const factors = { ...dr.factors };
  for (const m of enabledModules()) for (const f of m.factors) if (factors[f.key] == null) factors[f.key] = f.type === 'bool' ? false : 0;
  const clean = list => list.filter(x => x.med_id).map(x => ({ med_id: x.med_id, time: x.time || null, effect: x.effect || null }));
  const a = dr.attack;
  return {
    headache: dr.headache,
    factors,
    period: dr.period,
    sleep_hours: sleepHours(dr.sleep_start, dr.sleep_end) ?? dr.sleep_hours,
    sleep_start: dr.sleep_start || null,
    sleep_end: dr.sleep_end || null,
    note: dr.note,
    attacks: dr.headache ? [{ ...a, start_time: a.start_time || null, end_time: a.end_time || null, doses: clean(a.doses) }] : [],
    doses: clean(dr.doses),
  };
}

async function wizardAction(el) {
  const act = el.dataset.act, dr = wz.draft;
  const f = el.dataset.k && factorDef(el.dataset.k);
  switch (act) {
    case 'close':
      if (wz.dirty && !confirm('Выйти без сохранения?')) return;
      wz.dirty = false;
      location.hash = `#diary/${wz.date}`;
      return;
    case 'back':
      wz.step--; drawWizard(); window.scrollTo(0, 0); return;
    case 'next':
      if (wz.step < wz.steps.length - 1) { wz.step++; drawWizard(); window.scrollTo(0, 0); return; }
      el.disabled = true;
      await api.saveDay(wz.date, wizardPayload());
      wz.dirty = false;
      toast('Записано ✓');
      location.hash = `#diary/${wz.date}`;
      return;
    case 'delete':
      if (!confirm(`Удалить всю запись за ${fmtDate(wz.date)}?`)) return;
      await api.deleteDay(wz.date);
      wz.dirty = false;
      toast('Запись удалена');
      location.hash = `#diary/${wz.date}`;
      return;
    case 'fbool': dr.factors[f.key] = !dr.factors[f.key]; break;
    case 'flevel': dr.factors[f.key] = Number(el.dataset.v); break;
    case 'fstep': {
      const step = f.type === 'hours' ? 0.5 * Number(el.dataset.d) : Number(el.dataset.d);
      dr.factors[f.key] = Math.min(Math.max((dr.factors[f.key] || 0) + step, 0), f.max ?? 24);
      break;
    }
    case 'period': dr.period = !dr.period; break;
    case 'toggle': {
      const arr = getPath(dr, el.dataset.path), v = el.dataset.val;
      arr.includes(v) ? arr.splice(arr.indexOf(v), 1) : arr.push(v);
      break;
    }
    case 'effect': setPath(dr, el.dataset.path, getPath(dr, el.dataset.path) === el.dataset.val ? null : el.dataset.val); break;
    case 'add-dose': {
      const m = meds.find(x => x.active && (dr.headache ? x.kind !== 'preventive' : x.kind === 'preventive')) || meds.find(x => x.active);
      getPath(dr, el.dataset.path).push({ med_id: m.id, time: wz.date === today() ? nowTime() : '', effect: null });
      break;
    }
    case 'rm-dose': getPath(dr, el.dataset.path).splice(Number(el.dataset.i), 1); break;
    default: return;
  }
  wz.dirty = true;
  redraw();
}

$view.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !wz) return;
  wizardAction(el).catch(err => {
    toast(err.message);
    el.disabled = false;
  });
});

$view.addEventListener('input', e => {
  const el = e.target;
  const tf = el.closest('.tfield');
  if (wz && tf) {
    const [hs, ms] = tf.querySelectorAll('select');
    if (hs.value && !ms.value) ms.value = '00';
    setPath(wz.draft, tf.dataset.path, hs.value ? `${hs.value}:${ms.value}` : '');
    wz.dirty = true;
    if (tf.dataset.path.startsWith('sleep_')) {
      const h = sleepHours(wz.draft.sleep_start, wz.draft.sleep_end);
      if (h != null) wz.draft.sleep_hours = h;
      document.getElementById('sleepDur').textContent = h != null ? `Сон: ${fmtHours(h)}` : 'Укажите, когда заснули и проснулись';
    }
    return;
  }
  if (!wz || !el.dataset.path) return;
  const v = el.dataset.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
  setPath(wz.draft, el.dataset.path, v);
  wz.dirty = true;
  if (el.dataset.path === 'attack.intensity') {
    document.getElementById('intVal').textContent = v;
    document.getElementById('intWord').textContent = INTENSITY_WORDS[v];
  }
});

window.addEventListener('beforeunload', e => { if (wz?.dirty) e.preventDefault(); });

// ---------- calendar ----------

const calPrefs = () => ({
  meds: pref.get('cal_meds', '1') === '1',
  cycle: pref.get('cal_cycle', '1') === '1',
  view: pref.get('cal_view', 'month'),
});

// The one medication limit closest to being reached, as a short phrase for the summary line.
function overuseText(o) {
  const labels = { specific: 'триптаны', simple: 'обезболивающие', any: 'все обезболивающие' };
  const key = Object.keys(labels).sort((a, b) => o[b].days / o[b].limit - o[a].days / o[a].limit)[0];
  const x = o[key];
  if (!x.days) return 'без обезболивающих';
  return `${labels[key]} <b class="${x.status}">${x.days} из ${x.limit}</b> дн.`;
}

async function renderCalendar(ym) {
  const [data, cyc] = await Promise.all([api.month(ym), api.cycle()]);
  const pr = calPrefs();
  const [y, m] = ym.split('-').map(Number);
  const prev = iso(new Date(y, m - 2, 1)).slice(0, 7), next = iso(new Date(y, m, 1)).slice(0, 7);
  const t = today();
  const n = data.headache_days;
  $view.innerHTML = `
    <div class="monthbar"><h1>${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ' ' + y : ''}</h1>
      <div class="nav"><button data-go="${prev}" aria-label="Предыдущий месяц">‹</button><button data-go="${next}" ${next > t.slice(0, 7) ? 'disabled' : ''} aria-label="Следующий месяц">›</button></div></div>
    <p class="sumline"><b>${n}</b> ${plural(n, 'день', 'дня', 'дней')} боли · <b>${data.migraine_days}</b> похоже на мигрень · ${overuseText(data.overuse)}</p>
    <div class="seg" style="margin-bottom:16px">
      <button data-view="month" class="${pr.view === 'month' ? 'on' : ''}">Месяц</button>
      <button data-view="tracks" class="${pr.view === 'tracks' ? 'on' : ''}">Дорожки</button>
    </div>
    ${pr.view === 'tracks' ? tracksView(data, cyc) : monthGrid(data, cyc, pr, ym)}`;

  $view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { location.hash = `#calendar/${b.dataset.go}`; });
  $view.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { pref.set('cal_view', b.dataset.view); renderCalendar(ym); });
  $view.querySelectorAll('[data-cal-toggle]').forEach(b => b.onclick = () => {
    const k = b.dataset.calToggle;
    pref.set(k, pref.get(k, '1') === '1' ? '0' : '1');
    renderCalendar(ym);
  });
  $view.querySelectorAll('[data-day]').forEach(b => b.onclick = () => showPeek(b.dataset.day, cyc).catch(err => toast(err.message)));
}

function monthGrid(data, cyc, pr, ym) {
  const lead = (parseISO(`${ym}-01`).getDay() + 6) % 7;
  const t = today();
  const fc = new Set(cyc.forecast);
  const cells = data.series.map(p => {
    const future = p.date > t;
    const cls = future ? 'num future' : numClass(p, t).replace(' sel', ' today');
    const med = pr.meds && p.meds ? '<i class="medmark"></i>' : '';
    const per = !pr.cycle ? '' : p.period ? '<i class="perline"></i>' : fc.has(p.date) && !p.logged ? '<i class="perline fc"></i>' : '';
    return `<button class="cd" data-day="${p.date}" ${future ? 'disabled' : ''} aria-label="${fmtDate(p.date)}, ${p.type ? L.types[p.type] : 'не заполнен'}${p.meds ? ', лекарства' : ''}${p.period ? ', менструация' : ''}">
      <span class="${cls}">${Number(p.date.slice(8))}${med}</span>${per}</button>`;
  }).join('');
  const next = cyc.forecast[0];
  return `
    <div class="cal">${DOW.map(d => `<div class="dow">${d.toLowerCase()}</div>`).join('')}${'<span></span>'.repeat(lead)}${cells}</div>
    <div class="legend"><span><i style="background:var(--ha)"></i>головная боль</span><span><i style="background:var(--mi)"></i>похоже на мигрень</span></div>
    <div class="toggles">
      <button data-cal-toggle="cal_meds" class="${pr.meds ? 'on' : ''}" aria-pressed="${pr.meds}"><i style="background:var(--med)"></i>Лекарства</button>
      <button data-cal-toggle="cal_cycle" class="${pr.cycle ? 'on' : ''}" aria-pressed="${pr.cycle}"><i style="background:var(--per)"></i>Цикл</button>
    </div>
    <div id="peek"></div>
    ${pr.cycle && next && next >= t ? `<p class="muted" style="margin-top:12px">Следующая менструация ожидается около ${fmtDate(next)} (бледная линия).</p>` : ''}`;
}

async function showPeek(date, cyc) {
  const data = await api.day(date);
  $view.querySelectorAll('.cd .num').forEach(el => el.classList.toggle('sel', el.closest('[data-day]').dataset.day === date));
  const cd = cyc.dayOf(date);
  const el = document.getElementById('peek');
  if (!data.day) {
    el.innerHTML = `<div class="peek"><div class="spread"><b>${fmtDate(date)}</b><a href="#diary/${date}">Заполнить</a></div>
      <p>Нет записи${cd ? ` · ${cd}-й день цикла` : ''}</p></div>`;
    return;
  }
  const type = dayType(data), a = data.attacks[0];
  const doses = [...data.attacks.flatMap(x => x.doses), ...data.doses];
  const parts = [
    a && `сила ${a.intensity}`,
    a?.start_time && `${a.start_time}${a.end_time ? '–' + a.end_time : ''}`,
    doses.length && doses.map(doseText).join(', '),
    data.day.period ? 'менструация' : cd && `${cd}-й день цикла`,
    data.day.sleep_hours != null && `сон ${data.day.sleep_hours} ч`,
  ].filter(Boolean);
  el.innerHTML = `<div class="peek">
    <div class="spread"><b>${fmtDate(date)}</b><span style="color:${TYPE_COLOR[type]}">${L.types[type].toLowerCase()}</span></div>
    ${parts.length ? `<p>${parts.join(' · ')}</p>` : ''}
    <a href="#diary/${date}">Открыть день</a></div>`;
}

// Same month as rows: pain, medication, cycle, pressure. Shows what coincides with what.
function tracksView(data, cyc) {
  const s = data.series, n = s.length, W = 300, cw = W / n, t = today();
  // Only pain bars: a row of tiny marks for the other days would read as a dotted line (pattern glare).
  const pain = s.map((p, i) => p.headache
    ? `<rect x="${i * cw + 0.6}" y="${40 - p.intensity * 4}" width="${cw - 1.2}" height="${p.intensity * 4}" rx="1.5" fill="${p.type === 'migraine' ? 'var(--mi)' : 'var(--ha)'}"/>`
    : '').join('');
  const medsRow = s.map((p, i) => p.meds ? `<circle cx="${i * cw + cw / 2}" cy="5" r="3" fill="var(--med)"/>` : '').join('');
  const fc = new Set(cyc.forecast);
  const runs = (test) => {
    const out = [];
    s.forEach((p, i) => { if (test(p)) { const last = out.at(-1); if (last && last[1] === i - 1) last[1] = i; else out.push([i, i]); } });
    return out;
  };
  const cycleRow = runs(p => p.period).map(([a, b]) => `<rect x="${a * cw + 1}" y="2" width="${(b - a + 1) * cw - 2}" height="6" rx="3" fill="var(--per)"/>`).join('')
    + runs(p => !p.logged && fc.has(p.date)).map(([a, b]) => `<rect x="${a * cw + 1}" y="2" width="${(b - a + 1) * cw - 2}" height="6" rx="3" fill="var(--per)" opacity=".35"/>`).join('');
  const ps = s.map(p => p.pressure).filter(v => v != null);
  const pmin = Math.min(...ps), pr = Math.max(Math.max(...ps) - pmin, 1);
  const pts = s.map((p, i) => p.pressure == null || p.date > t ? null : `${i * cw + cw / 2},${26 - (p.pressure - pmin) / pr * 22}`).filter(Boolean).join(' ');
  const axis = [1, 10, 20, n].map(d => `<text x="${Math.min((d - 1) * cw + cw / 2, W - 6)}" y="10" font-size="9" text-anchor="middle" fill="var(--faint)">${d}</text>`).join('');

  const painDays = s.filter(p => p.headache);
  const withPeriod = painDays.filter(p => p.period).length;
  const withJump = painDays.filter(p => Math.abs(p.pressure_delta ?? 0) >= 5
    || Math.abs(s[s.indexOf(p) - 1]?.pressure_delta ?? 0) >= 5).length;
  const insight = !painDays.length ? 'В этом месяце дней с болью нет.'
    : `Из ${painDays.length} ${plural(painDays.length, 'дня', 'дней', 'дней')} с болью: ${withPeriod} — во время менструации, ${withJump} — при резкой смене давления (±5 гПа за сутки, в тот же или предыдущий день).`;

  return `<div class="tracks">
      <div class="tr"><span>Боль</span><svg viewBox="0 0 ${W} 40" role="img" aria-label="Сила боли по дням">${pain}</svg></div>
      <div class="tr"><span>Лекарства</span><svg viewBox="0 0 ${W} 10" role="img" aria-label="Дни с лекарствами">${medsRow}</svg></div>
      <div class="tr"><span>Цикл</span><svg viewBox="0 0 ${W} 10" role="img" aria-label="Менструация">${cycleRow}</svg></div>
      <div class="tr"><span>Давление</span>${ps.length > 1 ? `<svg viewBox="0 0 ${W} 28" role="img" aria-label="Атмосферное давление"><polyline points="${pts}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round"/></svg>` : '<span>укажите город в настройках</span>'}</div>
      <div class="tr"><span></span><svg viewBox="0 0 ${W} 12">${axis}</svg></div>
    </div>
    <p class="insight">${insight}</p>`;
}

// ---------- attack mode ----------

const ATTACK_LEVELS = [[4, 'Терпимо', 'можно заниматься делами'], [7, 'Сильно', 'трудно что-то делать'], [9, 'Невыносимо', 'нужно лечь']];
let attackState = null;

function renderAttack() {
  attackState ??= { level: null, meds: new Set() };
  const acute = meds.filter(m => m.active && m.kind !== 'preventive');
  $view.innerHTML = `
    <div class="wiz-top"><button class="x" data-attack="close" aria-label="Закрыть">✕</button></div>
    <div class="attack-head"><b>Болит сейчас</b><span>Подробности можно дописать потом</span></div>
    ${ATTACK_LEVELS.map(([v, t, s]) => `<button class="bigopt ${attackState.level === v ? 'on' : ''}" data-level="${v}">${t}<small>${s}</small></button>`).join('')}
    ${acute.length ? `<h3>Что приняли</h3><div class="pills">${acute.map(m => `<button class="pill ${attackState.meds.has(m.id) ? 'on' : ''}" data-med="${m.id}">${esc(m.name)} ${esc(m.dose)}</button>`).join('')}</div>` : ''}
    <button class="primary wide" data-attack="save" style="margin-top:24px;padding:16px;font-size:18px">Записать</button>`;
}

async function attackAction(el) {
  if (el.dataset.level) attackState.level = Number(el.dataset.level);
  else if (el.dataset.med) {
    const id = Number(el.dataset.med);
    attackState.meds.has(id) ? attackState.meds.delete(id) : attackState.meds.add(id);
  } else if (el.dataset.attack === 'close') {
    location.hash = '#diary';
    return;
  } else if (el.dataset.attack === 'save') {
    if (!attackState.level) return toast('Выберите, насколько сильно болит');
    await api.quickAttack(attackState.level, [...attackState.meds]);
    attackState = null;
    $view.innerHTML = `
      <div class="attack-head" style="margin-top:70px"><b>Записано</b><span>Отдохните. Когда станет легче, можно дописать симптомы и факторы.</span></div>
      <a class="btn wide" href="#log/${today()}/yes">Дописать подробности</a>
      <a class="btn wide" style="margin-top:10px;background:transparent;color:var(--muted)" href="#diary">Закрыть</a>`;
    return;
  } else return;
  renderAttack();
}

$view.addEventListener('click', e => {
  if (!document.body.classList.contains('attack')) return;
  const el = e.target.closest('[data-level],[data-med],[data-attack]');
  if (el) attackAction(el).catch(err => toast(err.message));
});

// ---------- my data ----------

function overuseBanner(o) {
  const head = {
    ok: 'Обезболивающих в пределах нормы',
    warn: 'Приближаетесь к границе злоупотребления обезболивающими',
    over: 'Обезболивающих больше рекомендуемого — обсудите с врачом',
  }[o.status];
  return `<div class="banner ${o.status}"><b>${head}</b>
    <p style="font-size:13px">Дни с приёмом за 30 дней по ${fmtDate(o.to)}. Частый приём дольше 3 месяцев сам может вызывать головную боль.</p>
    <table>
      <tr><td>Триптаны, комбинированные и др.</td><td><b>${o.specific.days}</b> из ${o.specific.limit}</td></tr>
      <tr><td>Простые обезболивающие / НПВС</td><td><b>${o.simple.days}</b> из ${o.simple.limit}</td></tr>
      <tr><td>Любые вместе</td><td><b>${o.any.days}</b> из ${o.any.limit}</td></tr>
    </table></div>`;
}

function chart(series) {
  const W = 600, H = 170, top = 8, bottom = 18, n = series.length;
  const bw = W / n, ph = H - top - bottom;
  const ps = series.map(p => p.pressure).filter(v => v != null);
  const pmin = Math.min(...ps), pmax = Math.max(...ps), pr = Math.max(pmax - pmin, 1);
  const bars = series.map((p, i) => {
    if (!p.headache) return '';
    const h = Math.max(p.intensity, 1) / 10 * ph;
    return `<rect x="${i * bw + bw * 0.15}" y="${top + ph - h}" width="${Math.max(bw * 0.7, 1)}" height="${h}" rx="2" fill="${p.type === 'migraine' ? 'var(--mi)' : 'var(--ha)'}"><title>${fmtDate(p.date)}: ${p.intensity}/10</title></rect>`;
  }).join('');
  const line = ps.length > 1 ? `<polyline fill="none" stroke="var(--muted)" stroke-opacity=".8" stroke-width="1.5" stroke-linejoin="round" points="${series.map((p, i) => p.pressure == null ? null : `${i * bw + bw / 2},${top + ph - (p.pressure - pmin) / pr * ph}`).filter(Boolean).join(' ')}"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Сила боли по дням и атмосферное давление">
    <rect x="0" y="${top + ph}" width="${W}" height="1" fill="var(--line)"/>${bars}${line}</svg>
    <div class="legend"><span><i style="background:var(--ha)"></i>головная боль</span><span><i style="background:var(--mi)"></i>похоже на мигрень</span>
      <span>— давление ${ps.length ? `${Math.round(pmin)}–${Math.round(pmax)} гПа` : '(укажите город)'}</span></div>`;
}

// Radial map: the closer to the centre, the stronger the association.
function factorMap(items, kind) {
  const S = 320, c = S / 2;
  const color = kind === 'trigger' ? 'var(--ha)' : 'var(--none)';
  const strength = x => kind === 'trigger' ? (x.ratio == null ? 1 : Math.min((x.ratio - 1) / 2, 1)) : Math.min((1 - x.ratio) / 0.8, 1);
  const rings = [148, 108, 68].map((r, i) => `<circle cx="${c}" cy="${c}" r="${r}" fill="var(--surface-2)" fill-opacity="${0.35 + i * 0.25}"/>`).join('');
  const nodes = items.map((x, i) => {
    const ang = -Math.PI / 2 + i * 2 * Math.PI / items.length;
    const r = 124 - strength(x) * 80;
    const px = c + r * Math.cos(ang), py = c + r * Math.sin(ang);
    const f = factorDef(x.factor);
    return `<g><title>${esc(f.label)}: ${pct(x.p_with)} против ${pct(x.p_without)}</title>
      <circle cx="${px}" cy="${py}" r="21" fill="${color}"/><text x="${px}" y="${py + 7}" text-anchor="middle" font-size="20">${f.icon}</text></g>`;
  }).join('');
  return `<svg class="map" viewBox="0 0 ${S} ${S}" role="img" aria-label="${kind === 'trigger' ? 'Карта провокаторов' : 'Карта защиты'}">${rings}
    <text x="${c}" y="${c - 4}" text-anchor="middle" font-size="12" fill="var(--muted)">Сильная</text>
    <text x="${c}" y="${c + 12}" text-anchor="middle" font-size="12" fill="var(--muted)">связь</text>${nodes}</svg>`;
}

function mapCard(title, items, kind, note) {
  if (!items.length) return '';
  return `<div class="card"><h2>${title}</h2><p class="muted">${note}</p>
    <div class="mapwrap">${factorMap(items, kind)}</div>
    <table>${items.map(x => { const f = factorDef(x.factor); return `<tr><td>${f.icon} ${esc(f.label)} <span class="muted">(${x.days} дн)</span></td>
      <td style="white-space:nowrap">боль в <b>${pct(x.p_with)}</b> дней<br><span class="muted">иначе ${pct(x.p_without)}</span></td></tr>`; }).join('')}</table></div>`;
}

async function renderData(days) {
  const to = today(), from = addDays(to, -(days - 1));
  const s = await api.summary(from, to);
  const fa = s.factors;
  const triggers = fa.items.filter(x => x.kind === 'trigger');
  const protectors = fa.items.filter(x => x.kind === 'protector');
  const neutral = fa.items.filter(x => x.kind === 'neutral');
  $view.innerHTML = `
    <h1>Мои данные</h1>
    <div class="seg" style="margin-bottom:12px">${[30, 90, 180].map(n => `<button class="${n === days ? 'on' : ''}" onclick="location.hash='#data/${n}'">${n} дней</button>`).join('')}</div>
    <div class="card">
      <p class="muted" style="margin-top:0">${fmtDate(from)} — ${fmtDate(to)}</p>
      ${chart(s.series)}
      <div class="section" style="margin-top:12px">
        <span class="sic">📋</span>
        <div class="sbody"><div class="cap">Сводка</div>
          <div class="stat"><i style="background:var(--muted)"></i>Заполнено дней: <b>${s.logged_days}</b></div>
          <div class="stat"><i style="background:var(--faint)"></i>Не заполнено: <b>${s.series.filter(p => !p.logged && p.date <= to).length}</b></div>
          <div class="stat"><i style="background:var(--none)"></i>Дней без боли: <b>${s.pain_free_days}</b></div>
        </div>
      </div>
      <div class="section">
        <span class="sic">∿</span>
        <div class="sbody"><div class="cap">Головная боль и мигрень</div>
          <div class="stat"><i style="background:var(--ha)"></i>Дней с головной болью: <b>${s.headache_days - s.migraine_days}</b></div>
          <div class="stat"><i style="background:var(--mi)"></i>Похоже на мигрень: <b>${s.migraine_days}</b></div>
          <p class="muted" style="margin-top:8px">Приступов: <b>${s.attack_count}</b> · средняя сила <b>${s.avg_intensity ?? '—'}</b> из 10</p>
        </div>
      </div>
      <div class="section">
        <span class="sic">💊</span>
        <div class="sbody"><div class="cap">Лекарства</div>
          <div class="stat">Дней с обезболивающими: <b>${s.med_days}</b></div>
          ${s.med_effect.map(m => `<div style="margin:10px 0 4px"><div class="spread"><span>${esc(m.name)} ${esc(m.dose)}</span><span class="muted">${m.count} раз</span></div>
            <div class="bar"><i style="width:${m.full / m.count * 100}%;background:var(--none)"></i><i style="width:${m.partial / m.count * 100}%;background:var(--i1)"></i><i style="width:${m.none / m.count * 100}%;background:var(--i3)"></i></div>
            <span class="muted">помогло ${m.full} · частично ${m.partial} · нет ${m.none}</span></div>`).join('')}
        </div>
      </div>
    </div>
    ${overuseBanner(s.overuse)}
    ${!fa.ready ? `<div class="card"><h2>Карты факторов</h2>
        <p class="muted">Покажут, что связано с приступами, а что защищает. Появятся после ${fa.need} заполненных дней, надёжнее — после 90.</p>
        <div class="meter"><i style="width:${Math.min(fa.have / fa.need, 1) * 100}%"></i></div><p class="muted">${fa.have} из ${fa.need}</p></div>`
      : `${fa.preliminary ? `<p class="muted center">Карты предварительные: надёжные выводы — примерно после 90 дней записей (сейчас ${fa.have}).</p>` : ''}
        ${mapCard('Карта провокаторов', triggers, 'trigger', 'В такие дни голова болит заметно чаще.')}
        ${mapCard('Карта защиты', protectors, 'protector', 'В такие дни голова болит реже.')}
        ${neutral.length ? `<div class="card"><h2>Без явной связи</h2><div class="tags">${neutral.map(x => { const f = factorDef(x.factor); return `<span class="tag">${f.icon} ${esc(f.label)}</span>`; }).join('')}</div></div>` : ''}
        ${!fa.items.length ? '<div class="card"><p class="muted">Пока ни один фактор не встречался достаточно часто (нужно ≥5 дней с ним и без него).</p></div>' : ''}
        <p class="muted center">Это совпадения в ваших записях, а не доказанные причины. Обсудите их с врачом.</p>`}
    ${s.attack_count ? `<div class="card"><h2>Как обычно проходит приступ</h2>
      <p><b>Где:</b> ${s.locations.map(([k, n]) => `${esc(L.location[k] || k)} (${n})`).join(', ') || '—'}</p>
      <p><b>Какая:</b> ${s.characters.map(([k, n]) => `${esc(L.character[k] || k)} (${n})`).join(', ') || '—'}</p>
      <p><b>Симптомы:</b> ${s.symptoms.map(([k, n]) => `${esc(L.symptoms[k]?.[0] || k)} (${n})`).join(', ') || '—'}</p></div>` : ''}
    <a class="btn primary wide" href="#report/${addDays(to, -89)}/${to}">Отчёт для врача</a>`;
}

// ---------- report ----------

async function renderReport(from, to) {
  to = to || today(); from = from || addDays(to, -89);
  const s = await api.summary(from, to);
  const dur = a => {
    if (!a.start_time || !a.end_time) return '—';
    let m = (Number(a.end_time.slice(0, 2)) * 60 + Number(a.end_time.slice(3))) - (Number(a.start_time.slice(0, 2)) * 60 + Number(a.start_time.slice(3)));
    if (m < 0) m += 1440;
    return `${Math.floor(m / 60)} ч ${pad(m % 60)} мин`;
  };
  const fl = s.factors.ready ? s.factors.items.filter(x => x.kind !== 'neutral') : [];
  $view.innerHTML = `
    <div class="noprint" style="margin-bottom:12px">
      <div class="spread"><button onclick="history.back()">‹ Назад</button><button class="primary" onclick="window.print()">Печать / PDF</button></div>
      <div class="row" style="margin-top:8px; flex-wrap:nowrap">
        <input type="date" id="rf" value="${from}" max="${to}" aria-label="С какой даты" style="flex:1;min-width:0"> —
        <input type="date" id="rt" value="${to}" max="${today()}" aria-label="По какую дату" style="flex:1;min-width:0">
      </div>
    </div>
    <div class="report">
      <h1>Дневник головной боли</h1>
      <p>Период: ${fmtDateFull(from)} — ${fmtDateFull(to)} (${s.total_days} дн, заполнено ${s.logged_days})</p>
      <div class="card"><h2>Сводка</h2><table>
        <tr><td>Дней с головной болью</td><td><b>${s.headache_days}</b> (${pct(s.headache_days / s.total_days)} периода), из них похожих на мигрень: <b>${s.migraine_days}</b></td></tr>
        <tr><td>Дней без боли (заполненных)</td><td><b>${s.pain_free_days}</b></td></tr>
        <tr><td>Приступов</td><td><b>${s.attack_count}</b>, средняя сила <b>${s.avg_intensity ?? '—'}</b> из 10</td></tr>
        <tr><td>Дней с обезболивающими</td><td><b>${s.med_days}</b></td></tr>
        <tr><td>Где болит</td><td>${s.locations.map(([k, n]) => `${L.location[k] || k} ${n}`).join(', ') || '—'}</td></tr>
        <tr><td>Характер</td><td>${s.characters.map(([k, n]) => `${L.character[k] || k} ${n}`).join(', ') || '—'}</td></tr>
        <tr><td>Сопутствующие симптомы</td><td>${s.symptoms.map(([k, n]) => `${L.symptoms[k]?.[0] || k} ${n}`).join(', ') || '—'}</td></tr>
      </table></div>
      ${overuseBanner(s.overuse)}
      <div class="card"><h2>Календарь</h2>
        <div class="strip">${s.series.map(p => `<i class="${p.type ? 't-' + p.type : ''}" title="${fmtDate(p.date)}"></i>`).join('')}</div>
        <div class="legend"><span><i style="background:var(--none)"></i>без боли</span><span><i style="background:var(--ha)"></i>головная боль</span><span><i style="background:var(--mi)"></i>похоже на мигрень</span><span><i style="background:var(--surface-2)"></i>нет записи</span></div>
      </div>
      ${s.med_effect.length ? `<div class="card"><h2>Препараты</h2><table>
        <tr><th>Препарат</th><th>Приёмов</th><th>Помогло</th><th>Частично</th><th>Нет</th></tr>
        ${s.med_effect.map(m => `<tr><td>${esc(m.name)} ${esc(m.dose)}</td><td>${m.count}</td><td>${m.full}</td><td>${m.partial}</td><td>${m.none}</td></tr>`).join('')}
      </table></div>` : ''}
      ${fl.length ? `<div class="card"><h2>Возможные провокаторы и защитные факторы</h2><table>
        <tr><th>Фактор</th><th>Дней</th><th>Боль в такие дни</th><th>В остальные</th></tr>
        ${fl.map(x => `<tr><td>${x.kind === 'trigger' ? '↑' : '↓'} ${esc(factorDef(x.factor).label)}</td><td>${x.days}</td><td>${pct(x.p_with)}</td><td>${pct(x.p_without)}</td></tr>`).join('')}
      </table></div>` : ''}
      <div class="card"><h2>Приступы</h2>
      ${s.attacks.length ? `<table>
        <tr><th>Дата</th><th>Время</th><th>Длит.</th><th>Сила</th><th>Описание</th><th>Лекарства</th></tr>
        ${s.attacks.map(a => `<tr>
          <td>${fmtDate(a.date)}${a.migraine ? '<br><i>мигренеподобный</i>' : ''}</td><td>${a.start_time || '—'}${a.end_time ? '–' + a.end_time : ''}</td><td>${dur(a)}</td><td>${a.intensity}</td>
          <td>${esc([labelsOf(L.location, a.location), labelsOf(L.character, a.character), labelsOf(L.symptoms, a.symptoms)].filter(Boolean).join('; '))}${a.note ? `<br><i>${esc(a.note)}</i>` : ''}</td>
          <td>${a.doses.map(x => { const m = medById(x.med_id); return `${esc(m ? m.name + ' ' + m.dose : '?')}${x.time ? ' в ' + x.time : ''} — ${L.effects[x.effect] || 'эффект не отмечен'}`; }).join('<br>') || '—'}</td>
        </tr>`).join('')}
      </table>` : '<p class="muted">Приступов за период нет.</p>'}</div>
      <p class="muted">Сформировано ${fmtDateFull(today())}. Данные заполнены пациентом. «Мигренеподобный» — по признакам приступа (ICHD-3), связи с факторами — статистические совпадения; это не диагноз.</p>
    </div>`;
  const go = () => { const f = document.getElementById('rf').value, t = document.getElementById('rt').value; if (f && t && f <= t) location.hash = `#report/${f}/${t}`; };
  document.getElementById('rf').onchange = go;
  document.getElementById('rt').onchange = go;
}

// ---------- files: backup, CSV, sharing ----------

// iPhone shows the share sheet ("Сохранить в Файлы", AirDrop, Claude...); elsewhere fall back to a download.
async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Safari only allows sharing right after a tap, so the backup is prepared before the button is pressed.
let preparedBackup = null;
async function prepareBackup() { preparedBackup = JSON.stringify(await api.backup()); }

async function saveBackup() {
  if (!preparedBackup) await prepareBackup();
  if (await shareFile(`дневник-копия-${today()}.json`, preparedBackup, 'application/json')) {
    await api.markBackedUp();
    toast('Копия сохранена');
    route();
  }
}

// ---------- settings ----------

async function renderSettings() {
  const [s, list] = await Promise.all([api.settings(), api.meds(), prepareBackup()]);
  CFG = await api.config();
  const aiDays = Number(pref.get('ai_days', 90));
  let prompt = await api.aiPrompt(addDays(today(), -(aiDays - 1)), today());
  meds = list;
  const csv = await api.csv();
  $view.innerHTML = `
    <h1>Настройки</h1>
    <h3>Оформление</h3>
    <div class="card">
      <div class="themes">${Object.entries(THEMES).map(([k, th]) => `<button data-theme-pick="${k}" class="${(document.documentElement.dataset.theme || 'moss') === k ? 'on' : ''}">
        <div class="sw">${th.sw.map(c => `<i style="background:${c};box-shadow:0 0 0 1px var(--line)"></i>`).join('')}</div>${th.name}</button>`).join('')}</div>
      <label class="field" style="margin-bottom:0"><span>Яркость приложения</span>
        <input type="range" class="plain" id="bright" min="0.5" max="1" step="0.05" value="${1 - Number(pref.get('dim', 0))}" aria-label="Яркость приложения"></label>
      <p class="muted">Если свет раздражает, сдвиньте влево. Тёмные темы удобнее вечером и во время приступа.</p>
    </div>
    <h3>Разделы дневника</h3>
    <div class="list">${CFG.modules.map(m => `
      <details class="mod">
        <summary class="frow"><span class="fic">${m.icon}</span><div class="fbody"><div class="flabel">${m.title}</div>
          <div class="fval">${m.factors.filter(f => f.enabled).length} из ${m.factors.length} · настроить</div></div>
          <button class="switch ${s.modules.includes(m.key) ? 'on' : ''}" data-module="${m.key}" role="switch" aria-label="${esc(m.title)}"></button></summary>
        <div class="modbody">
          ${m.factors.map(f => `<label class="chk"><input type="checkbox" data-factor="${f.key}" ${f.enabled ? 'checked' : ''}>
            <span>${f.icon} ${esc(f.label)}</span>${f.custom ? `<button class="ghost danger" data-rm-factor="${f.key}" aria-label="Удалить «${esc(f.label)}»">Удалить</button>` : ''}</label>`).join('')}
          <div class="addf">
            <input placeholder="Свой фактор, например «Йога»" maxlength="40" data-new-label="${m.key}">
            <div class="row" style="flex-wrap:nowrap;margin-top:8px">
              <select data-new-type="${m.key}" style="flex:1;min-width:0">${Object.entries({ bool: 'Да / нет', level: 'Нет … сильно', count: 'Число' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
              <button data-add-factor="${m.key}">Добавить</button>
            </div>
          </div>
        </div>
      </details>`).join('')}
    </div>
    <p class="muted">Переключатель включает раздел целиком. Нажмите на раздел, чтобы убрать отдельные пункты или добавить свои.</p>

    <h3>Мои лекарства</h3>
    <div class="list">${meds.filter(m => !m.deleted).map(m => `
      <div class="frow"><span class="fic">💊</span><div class="fbody"><div class="flabel">${esc(m.name)} ${esc(m.dose)}</div><div class="fval">${L.kinds[m.kind]}</div></div>
        <button class="ghost danger" data-med-del="${m.id}">Удалить</button></div>`).join('') || '<div class="frow muted">Пока пусто</div>'}
    </div>
    <div class="card" style="margin-top:10px">
      <input id="mName" placeholder="Название, например «Суматриптан»" maxlength="80">
      <div class="row" style="margin-top:8px; flex-wrap:nowrap">
        <input id="mDose" placeholder="Доза, 50 мг" maxlength="40" style="flex:1;min-width:0">
        <select id="mKind" style="flex:1;min-width:0">${Object.entries(L.kinds).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </div>
      <p class="muted">Тип нужен, чтобы считать риск злоупотребления обезболивающими.</p>
      <button class="primary wide" id="mAdd">Добавить лекарство</button>
    </div>

    <h3>Погода</h3>
    <div class="card">
      <p class="muted" style="margin-top:0">${s.city ? `Город: <b style="color:var(--text)">${esc(s.city.name)}</b>, ${esc(s.city.region)}` : 'Город не выбран — давление и температура не подтягиваются.'}</p>
      <div class="row" style="flex-wrap:nowrap"><input id="cityQ" placeholder="Найти город" style="flex:1;min-width:0"><button id="citySearch">Найти</button></div>
      <div id="cityResults" class="pills" style="margin-top:8px"></div>
    </div>

    <h3>Резервная копия</h3>
    <div class="card">
      <p class="muted" style="margin-top:0">Все записи хранятся только в этом телефоне. ${s.last_backup ? `Последняя копия: ${fmtDateFull(iso(new Date(s.last_backup)))}.` : 'Копий ещё не было.'}</p>
      <button class="primary wide" id="backup">Сохранить копию в «Файлы»</button>
      <button class="wide" id="restoreBtn" style="margin-top:8px">Восстановить из копии</button>
      <input type="file" id="restoreFile" accept="application/json,.json" hidden>
    </div>

    <h3>Анализ дневника с помощью ИИ</h3>
    <div class="card">
      <p class="muted" style="margin-top:0">Готовый запрос с вашими записями и подробной инструкцией для ИИ: итоги, характер приступов, лекарства, провокаторы, прогноз и вопросы к врачу. Вставьте его в любой чат с ИИ — ChatGPT, Claude, Gemini, YandexGPT, GigaChat.</p>
      <label class="field"><span>За какой период</span>
        <select id="aiDays">${[30, 90, 180].map(n => `<option value="${n}" ${n === aiDays ? 'selected' : ''}>${n} дней</option>`).join('')}</select></label>
      <button class="primary wide" id="aiCopy">Скопировать запрос</button>
    </div>

    <h3>Данные из «Здоровья»</h3>
    <div class="card">
      <p class="muted" style="margin-top:0">Команда на iPhone копирует сон, пульс и ВСР, а здесь вы их вставляете. Как сделать команду — в инструкции на GitHub.</p>
      <button class="wide" id="healthPaste">Вставить данные из «Здоровья»</button>
      <textarea id="healthText" placeholder="Или вставьте текст сюда вручную" style="min-height:70px;margin-top:8px"></textarea>
      <button class="wide" id="healthSave" style="margin-top:8px">Сохранить</button>
    </div>

    <h3>Напоминание</h3>
    <div class="card">
      <p style="margin-top:0">Без сервера дневник не может сам присылать уведомления. Проще всего:</p>
      <p>«Напоминания» → новое напоминание «Заполнить дневник» → дата и время 21:00 → повтор «Ежедневно».</p>
    </div>

    <h3>Экспорт</h3>
    <div class="card">
      <button id="exportCsv" class="wide">Скачать всё в CSV (Excel)</button>
    </div>`;

  const $ = id => document.getElementById(id);
  $view.querySelectorAll('[data-theme-pick]').forEach(b => b.onclick = () => {
    pref.set('theme', b.dataset.themePick);
    applyTheme(b.dataset.themePick);
    $view.querySelectorAll('[data-theme-pick]').forEach(x => x.classList.toggle('on', x === b));
  });
  $('bright').oninput = e => { pref.set('dim', String(Math.round((1 - Number(e.target.value)) * 100) / 100)); applyDim(); };
  $view.querySelectorAll('[data-module]').forEach(b => b.onclick = async () => {
    const key = b.dataset.module;
    const next = s.modules.includes(key) ? s.modules.filter(k => k !== key) : [...s.modules, key];
    await api.saveSettings({ modules: next });
    s.modules = next;
    CFG.enabled = CFG.modules.map(m => m.key).filter(k => next.includes(k));
    b.classList.toggle('on');
  });
  $('citySearch').onclick = async () => {
    const q = $('cityQ').value.trim();
    if (q.length < 2) return;
    try {
      const found = await api.geocode(q);
      $('cityResults').innerHTML = found.length ? found.map((c, i) => `<button class="pill" data-city="${i}">${esc(c.name)}, ${esc(c.region)}</button>`).join('') : '<p class="muted">Ничего не нашлось</p>';
      $('cityResults').onclick = async e => {
        const b = e.target.closest('[data-city]');
        if (!b) return;
        await api.saveSettings({ city: found[Number(b.dataset.city)] });
        toast('Город сохранён, погода загружена');
        renderSettings();
      };
    } catch (err) { toast(navigator.onLine ? err.message : 'Нужен интернет'); }
  };
  $('cityQ').onkeydown = e => { if (e.key === 'Enter') $('citySearch').click(); };
  $('mAdd').onclick = async () => {
    try {
      await api.addMed({ name: $('mName').value, dose: $('mDose').value, kind: $('mKind').value });
      meds = await api.meds();
      toast('Добавлено'); renderSettings();
    } catch (err) { toast(err.message); }
  };
  $view.querySelectorAll('[data-med-del]').forEach(b => b.onclick = async () => {
    const m = medById(Number(b.dataset.medDel));
    if (!confirm(`Удалить «${m.name}»? В старых записях оно останется.`)) return;
    await api.deleteMed(m.id);
    meds = await api.meds();
    renderSettings();
  });
  // Tapping the switch toggles the module without opening its factor list.
  $view.querySelectorAll('.mod summary .switch').forEach(b => b.addEventListener('click', e => e.preventDefault()));
  $view.querySelectorAll('[data-factor]').forEach(c => c.onchange = async () => {
    await api.setFactorEnabled(c.dataset.factor, c.checked);
    CFG = await api.config();
  });
  $view.querySelectorAll('[data-rm-factor]').forEach(b => b.onclick = async e => {
    e.preventDefault();
    if (!confirm('Удалить этот фактор? Уже сделанные записи сохранятся.')) return;
    await api.removeFactor(b.dataset.rmFactor);
    renderSettings();
  });
  $view.querySelectorAll('[data-add-factor]').forEach(b => b.onclick = async () => {
    const mod = b.dataset.addFactor;
    try {
      await api.addFactor($view.querySelector(`[data-new-label="${mod}"]`).value, $view.querySelector(`[data-new-type="${mod}"]`).value, mod);
      toast('Добавлено');
      await renderSettings();
      $view.querySelector(`[data-add-factor="${mod}"]`).closest('details').open = true;
    } catch (err) { toast(err.message); }
  });
  $('aiDays').onchange = async () => {
    pref.set('ai_days', $('aiDays').value);
    const n = Number($('aiDays').value);
    prompt = await api.aiPrompt(addDays(today(), -(n - 1)), today());
  };
  $('aiCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(prompt); toast('Скопировано — вставьте в чат с ИИ'); } catch { toast('Не удалось скопировать'); }
  };
  $('backup').onclick = () => saveBackup().catch(err => toast(err.message));
  $('restoreBtn').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = async e => {
    const file = e.target.files[0];
    if (!file || !confirm('Заменить все записи на этом телефоне данными из копии?')) return;
    try {
      const n = await api.restore(await file.text());
      CFG = null;
      toast(`Восстановлено дней: ${n}`);
      location.hash = '#diary';
    } catch (err) { toast(err.message); }
  };
  const saveHealth = async text => {
    try {
      const row = await api.importHealth(text);
      toast(`Сохранено за ${fmtDate(row.date)}`);
      $('healthText').value = '';
    } catch (err) { toast(err.message); }
  };
  $('healthPaste').onclick = async () => {
    try { await saveHealth(await navigator.clipboard.readText()); } catch { toast('Не получилось прочитать буфер — вставьте текст в поле'); }
  };
  $('healthSave').onclick = () => saveHealth($('healthText').value);
  $('exportCsv').onclick = () => shareFile(`дневник-${today()}.csv`, csv, 'text/csv').catch(err => toast(err.message));
}

// ---------- boot ----------

applyTheme(pref.get('theme', 'moss'));
applyDim();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
// Ask the browser not to evict the diary's storage when space runs low.
navigator.storage?.persist?.().catch(() => { });
route();
