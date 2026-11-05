// IndexedDB storage. Everything lives on the phone; nothing is sent anywhere.
//
// Stores:
//   days     {date, headache, factors, period, sleep_hours, note, attacks: [{..., doses}], doses, updated_at}
//   meds     {id, name, dose, kind, active}
//   weather  {date, pressure, pressure_delta, temp, humidity}
//   health   {date, sleep_hours, resting_hr, hrv, steps}
//   settings {key, value}

const DB_NAME = 'headache-diary';
const STORES = { days: 'date', meds: 'id', weather: 'date', health: 'date', settings: 'key' };
export const STORE_NAMES = Object.keys(STORES);

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!req.result.objectStoreNames.contains(name)) {
          req.result.createObjectStore(name, { keyPath, autoIncrement: name === 'meds' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(names, mode, fn) {
  const db = await open();
  const t = db.transaction(names, mode);
  fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Транзакция прервана'));
  });
}

export async function get(store, key) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key));
}

/** All records, or only those with keys in [from, to] (inclusive). */
export async function getAll(store, from, to) {
  const db = await open();
  const range = from != null ? IDBKeyRange.bound(from, to) : undefined;
  return done(db.transaction(store).objectStore(store).getAll(range));
}

export async function put(store, value) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  const key = await done(t.objectStore(store).put(value));
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
  return key;
}

export async function putMany(store, values) {
  await tx([store], 'readwrite', t => { for (const v of values) t.objectStore(store).put(v); });
}

export async function del(store, key) {
  await tx([store], 'readwrite', t => t.objectStore(store).delete(key));
}

export async function clear(store) {
  await tx([store], 'readwrite', t => t.objectStore(store).clear());
}

/** Replace the whole database in one transaction (used by backup restore). */
export async function replaceAll(data) {
  await tx(STORE_NAMES, 'readwrite', t => {
    for (const name of STORE_NAMES) {
      const s = t.objectStore(name);
      s.clear();
      for (const v of data[name] || []) s.put(v);
    }
  });
}

export async function getSetting(key, fallback) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  return put('settings', { key, value });
}
