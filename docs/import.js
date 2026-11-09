// Bringing in records kept elsewhere: Excel/CSV tables, the Leria template, JSON made by an AI from any notes.
// Everything is read on the phone; nothing is uploaded anywhere.

// ---------- reading files ----------

/** Files of a .zip (an .xlsx is one), as {name: Uint8Array}. Stored and deflated entries are supported. */
async function unzip(buf) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Файл повреждён или это не Excel');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {}, dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extra + comment;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out[name] = data;
    else if (method === 8) out[name] = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  return out;
}

const xml = (files, name) => files[name] && new DOMParser().parseFromString(new TextDecoder().decode(files[name]), 'application/xml');
const colIndex = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
// Excel keeps dates as days since 1899-12-30; times as a fraction of a day.
export const excelDate = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));

/** All sheets of an .xlsx as arrays of rows (cell values as text or numbers). */
async function readXlsx(buf) {
  const files = await unzip(buf);
  const shared = [...(xml(files, 'xl/sharedStrings.xml')?.getElementsByTagName('si') || [])]
    .map(si => [...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  const wb = xml(files, 'xl/workbook.xml'), rels = xml(files, 'xl/_rels/workbook.xml.rels');
  const target = {};
  for (const r of rels?.getElementsByTagName('Relationship') || []) target[r.getAttribute('Id')] = r.getAttribute('Target');
  const sheets = [];
  for (const sh of wb?.getElementsByTagName('sheet') || []) {
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const path = 'xl/' + (target[rid] || '').replace(/^\/?xl\//, '').replace(/^\//, '');
    const doc = xml(files, path);
    if (!doc) continue;
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const cells = [];
      for (const c of row.getElementsByTagName('c')) {
        const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent;
        const val = t === 's' ? shared[Number(v)] : t === 'inlineStr' ? c.getElementsByTagName('t')[0]?.textContent
          : t === 'str' || t === 'b' ? v : v != null && v !== '' ? Number(v) : '';
        cells[colIndex(c.getAttribute('r'))] = val ?? '';
      }
      rows.push(Array.from(cells, x => x ?? ''));
    }
    sheets.push({ name: sh.getAttribute('name'), rows });
  }
  return sheets;
}

/** CSV with commas or semicolons (Excel in Russian saves with ";"), quotes allowed. */
function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return [{ name: 'CSV', rows: rows.filter(r => r.some(x => String(x).trim())) }];
}

export async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) return { json: JSON.parse(await file.text()) };
  if (name.endsWith('.csv') || name.endsWith('.txt')) return { sheets: readCsv(await file.text()) };
  if (name.endsWith('.xlsx')) return { sheets: await readXlsx(await file.arrayBuffer()) };
  throw new Error('Подходят файлы .xlsx, .csv или .json');
}

// ---------- understanding words ----------

const has = (s, re) => re.test(String(s || '').toLowerCase());
const WORDS = {
  location: [[/лев|left/, 'left'], [/прав|right/, 'right'], [/обе|двух|both|вся голова|всей/, 'both'], [/лоб|лба|forehead/, 'forehead'],
    [/висок|виск|temple/, 'temples'], [/затыл|back|шея/, 'back'], [/глаз|eye/, 'eye']],
  character: [[/пульс|pulsat|throb/, 'pulsating'], [/давящ|давит|давлен|press/, 'pressing'], [/сжим|squeez|обруч/, 'squeezing'],
    [/кол[юи]|остр|stab/, 'stabbing'], [/туп|dull/, 'dull']],
  symptoms: [[/тошн|nause/, 'nausea'], [/рвот|vomit/, 'vomiting'], [/свет|photo/, 'photo'], [/звук|шум|phono/, 'phono'],
    [/запах|smell|osmo/, 'smell'], [/аур|aura/, 'aura'], [/головокр|dizz/, 'dizziness'], [/движ|нагруз|movement|activity/, 'movement']],
};
export const pick = (text, kind) => [...new Set(WORDS[kind].filter(([re]) => has(text, re)).map(([, k]) => k))];

export function effectOf(text) {
  if (has(text, /не помог|без эффект|не прош|none|no effect|^нет$/)) return 'none';
  if (has(text, /частич|легче|немного|partial|better|помогло частично/)) return 'partial';
  if (has(text, /прош|полност|помог|full|relief|^да$/)) return 'full';
  return null;
}

const MED_KINDS = [
  [/триптан|амигренин|релпакс|имигран|зомиг|нарамиг|максальт|сумамигрен|тригрим|рапимед|triptan/, 'triptan'],
  [/цитрамон|пенталгин|каффетин|солпадеин|спазмалгон|экседрин|аскофен|excedrin/, 'combo'],
  [/кодеин|трамадол|tramadol|codeine/, 'opioid'],
  [/эрготамин|дигидроэрго|ergot/, 'ergot'],
  [/топирамат|топамакс|пропранолол|анаприлин|амитриптилин|кандесартан|ботокс|botox|аймовиг|аджови|эмгалити|вальпро|верапамил|флунаризин|эренумаб|фреманезумаб|галканезумаб/, 'preventive'],
  [/ибупрофен|нурофен|парацетамол|аспирин|кеторол|кетонал|кеторолак|напроксен|налгезин|диклофенак|нимесулид|найз|некст|мовалис|анальгин|панадол|эффералган|ибуклин|миг|ibuprofen|paracetamol|aspirin|naproxen/, 'simple'],
];
export const medKind = name => MED_KINDS.find(([re]) => has(name, re))?.[1] || 'other';

/** 1–10 from a number on any scale or from words. */
export function intensityOf(v, scaleMax = 10) {
  if (typeof v === 'number' || /^\s*\d+([.,]\d+)?\s*$/.test(String(v))) {
    const n = Number(String(v).replace(',', '.'));
    if (!(n > 0)) return null;
    return Math.min(10, Math.max(1, Math.round(scaleMax === 10 ? n : n / scaleMax * 10)));
  }
  if (has(v, /невынос|очень сильн|extreme|severe\+/)) return 9;
  if (has(v, /сильн|severe|strong/)) return 7;
  if (has(v, /умерен|средн|moderate/)) return 5;
  if (has(v, /слаб|лёгк|легк|mild|light/)) return 3;
  return null;
}

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** A date from an Excel number, "14.03.2025", "2025-03-14" or "14/03/2025". */
export function dateOf(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return iso(excelDate(v));
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}
/** "09:30", "9.30", an Excel fraction of a day, or the time part of "14.03.2025 09:30". */
export function timeOf(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; }
  if (typeof v === 'number' && v > 20000) { const d = excelDate(v); return d.getUTCHours() || d.getUTCMinutes() ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : null; }
  const str = String(v || '');
  // "21:05" anywhere wins; "9.30" only when the cell holds a time alone (in "14.03.2025" the dot is a date).
  const m = str.match(/(\d{1,2}):(\d{2})(?!\d)/) || str.match(/^\s*(\d{1,2})\.(\d{2})\s*$/);
  return m && +m[1] < 24 && +m[2] < 60 ? `${pad(m[1])}:${pad(m[2])}` : null;
}

// ---------- the Leria template (CSV or Excel, one row per attack or per day) ----------

export const TEMPLATE_COLUMNS = ['Дата', 'Болела', 'Начало', 'Конец', 'Сила 1-10', 'Где', 'Какая', 'Симптомы', 'Лекарство', 'Доза', 'Время приёма', 'Помогло', 'Менструация', 'Сон, часов', 'Заметка'];
export const TEMPLATE_EXAMPLE = ['14.03.2025', 'да', '09:30', '13:00', '7', 'слева', 'пульсирующая', 'тошнота, свет', 'Суматриптан', '50 мг', '10:00', 'легче', 'нет', '6.5', 'после недосыпа'];

const yes = v => has(v, /^(да|yes|true|1|\+|был|была|болела)$/);

/** Rows with headers → Leria records, if the headers look like a diary (ours or anything similar). */
export function fromTable(rows) {
  const head = rows[0].map(h => String(h).toLowerCase().trim());
  const col = (...res) => head.findIndex(h => res.some(re => re.test(h)));
  const c = {
    date: col(/дата|date|день|day/), headache: col(/^болел|^боль$|headache|был.? приступ/), start: col(/начал|start|время приступа|начало|^время$|^time$/),
    end: col(/конец|end|закончил|окончан/), intensity: col(/сила|интенс|intensity|severity|оценка боли/), where: col(/^где|локализ|location|место/),
    kind: col(/^какая|характер|character|тип боли/), symptoms: col(/симптом|symptom|сопутств/), med: col(/лекарств|препарат|medic|drug|таблет/),
    dose: col(/^доза|dose/), medTime: col(/время при[её]ма|med.?time|принял[аи]? в/), effect: col(/помогло|эффект|effect|результат/),
    period: col(/менстр|period|цикл/), sleep: col(/^сон|sleep/), note: col(/замет|коммент|note|примеч/),
  };
  if (c.date < 0) return null;
  // The scale is guessed from the largest number in the column: 1–3, 1–5 or 1–10.
  const top = c.intensity < 0 ? 10 : Math.max(0, ...rows.slice(1).map(r => Number(String(r[c.intensity]).replace(',', '.'))).filter(n => n > 0));
  const scaleMax = top <= 3 ? 3 : top <= 5 ? 5 : 10;
  const get = (r, k) => (c[k] >= 0 ? r[c[k]] : '');
  const days = new Map();
  for (const r of rows.slice(1)) {
    const date = dateOf(get(r, 'date'));
    if (!date) continue;
    const d = days.get(date) || { date, headache: false, attacks: [], doses: [], period: false, sleep_hours: null, note: '' };
    days.set(date, d);
    const intensity = intensityOf(get(r, 'intensity'), scaleMax);
    const pain = c.headache >= 0 ? yes(get(r, 'headache')) || !!intensity : !!intensity || !!get(r, 'start');
    if (pain) {
      d.headache = true;
      const start = timeOf(get(r, 'start')) || timeOf(get(r, 'date'));
      let a = d.attacks.find(x => x.start_time === start);
      if (!a) {
        a = { start_time: start, end_time: timeOf(get(r, 'end')), intensity: intensity || 5,
          location: pick(get(r, 'where'), 'location'), character: pick(get(r, 'kind'), 'character'),
          symptoms: pick(`${get(r, 'symptoms')} ${get(r, 'where')}`, 'symptoms'), note: '', doses: [] };
        d.attacks.push(a);
      }
      const med = String(get(r, 'med') || '').trim();
      if (med) a.doses.push({ name: med, dose: String(get(r, 'dose') || '').trim(), time: timeOf(get(r, 'medTime')), effect: effectOf(get(r, 'effect')) });
    }
    if (c.period >= 0 && yes(get(r, 'period'))) d.period = true;
    const sl = Number(String(get(r, 'sleep')).replace(',', '.'));
    if (sl > 0 && sl < 24) d.sleep_hours = sl;
    const note = String(get(r, 'note') || '').trim();
    if (note && !d.note.includes(note)) d.note = [d.note, note].filter(Boolean).join('; ');
  }
  return [...days.values()];
}

// ---------- JSON (our own format, also what the AI is asked to produce) ----------

/** {days:[...]} in the format the AI prompt describes → Leria records. */
export function fromJson(j) {
  const list = Array.isArray(j) ? j : j.days;
  if (!Array.isArray(list)) return null;
  return list.map(x => ({
    date: dateOf(x.date),
    headache: !!(x.headache ?? x.attacks?.length),
    period: !!x.period,
    sleep_hours: x.sleep_hours > 0 && x.sleep_hours < 24 ? Number(x.sleep_hours) : null,
    note: String(x.note || ''),
    doses: [],
    attacks: (x.attacks || []).map(a => ({
      start_time: timeOf(a.start), end_time: timeOf(a.end), intensity: intensityOf(a.intensity) || 5,
      location: (a.location || []).filter(k => WORDS.location.some(([, v]) => v === k)),
      character: (a.character || []).filter(k => WORDS.character.some(([, v]) => v === k)),
      symptoms: (a.symptoms || []).filter(k => WORDS.symptoms.some(([, v]) => v === k)),
      note: String(a.note || ''),
      doses: (a.meds || []).filter(m => m.name).map(m => ({ name: String(m.name), dose: String(m.dose || ''), time: timeOf(m.time), effect: ['full', 'partial', 'none'].includes(m.effect) ? m.effect : null })),
    })),
  })).filter(x => x.date);
}

/** The request for any AI: turn notes, photos of a paper diary or another app's report into our JSON. */
export const AI_IMPORT_PROMPT = `Ты помогаешь перенести записи о головной боли в приложение-дневник. Я приложу свои старые записи: текст, таблицу, фото бумажного дневника или отчёт из другого приложения (Migraine Buddy, N1-Headache, Migrebot и др.).

Преобразуй ВСЕ записи в JSON строго такого вида и пришли ТОЛЬКО JSON, без пояснений:
{"days":[{"date":"2025-03-14","headache":true,"period":false,"sleep_hours":6.5,"note":"","attacks":[{"start":"09:30","end":"13:00","intensity":7,"location":["left"],"character":["pulsating"],"symptoms":["nausea","photo"],"note":"","meds":[{"name":"Суматриптан","dose":"50 мг","time":"10:00","effect":"partial"}]}]}]}

Правила:
- date — ГГГГ-ММ-ДД. Дни без головной боли тоже включай, если они явно отмечены ("headache":false, "attacks":[]).
- start, end, time — ЧЧ:ММ в 24-часовом формате; если неизвестно — null.
- intensity — от 1 до 10. Если в записях другая шкала, пересчитай (например, 2 из 3 → 7). Слова: слабая 3, умеренная 5, сильная 7, очень сильная 9.
- location — только из: left, right, both, forehead, temples, back, eye.
- character — только из: pulsating, pressing, squeezing, stabbing, dull.
- symptoms — только из: nausea, vomiting, photo (мешает свет), phono (мешают звуки), smell, aura, dizziness, movement (хуже от движения).
- effect — full (прошло), partial (стало легче), none (не помогло) или null.
- Если в один день было несколько отдельных приступов — несколько объектов в attacks.
- Ничего не придумывай: чего нет в записях — ставь null или пустой список. Всё неясное, но важное, пиши в note.`;

/** Recognise the file and turn it into records; `source` names what it was for the summary. */
export function recognise(read) {
  if (read.json) {
    if (read.json.format === 'headache-diary-backup') return { backup: true };
    const recs = fromJson(read.json);
    if (recs) return { source: 'JSON', records: recs };
    throw new Error('В этом JSON нет списка дней');
  }
  for (const sh of read.sheets) {
    // The header row may not be the first one (titles above the table): take the first row that has a date column.
    const at = sh.rows.findIndex(r => r.some(x => /дата|date/i.test(String(x))));
    if (at < 0) continue;
    const recs = fromTable(sh.rows.slice(at));
    if (recs?.length) return { source: sh.name, records: recs };
  }
  throw new Error('Не нашёл в файле таблицу с датами. Попробуйте шаблон или перенос через ИИ.');
}
