/**
 * 🔥 Осмотр предметов — хранилище текстов зон (только у ГМа).
 *
 * Почему файл, а не документ или настройка (проверено по ядру 14.371,
 * resources/app/dist):
 *  - packages/world.mjs, World.#b собирает мир для клиента через
 *    db.JournalEntry.dump(), db.Setting.dump() и т. д. без фильтра по
 *    пользователю: журнал с ownership NONE, флаги и настройки любого
 *    scope уходят каждому игроку;
 *  - ChatMessage рассылается всем, шёпот прячет только клиент;
 *  - компендий: индекс уходит всем, а get из пака (server-backend
 *    modifyDocument → _getDocuments) права не проверяет;
 *  - файлы папки данных раздаются по HTTP (server/express.mjs,
 *    express.static без списка каталога), а список файлов отдаёт только
 *    files.mjs при праве FILES_BROWSE (по умолчанию TRUSTED и выше).
 * Поэтому тексты лежат в JSON-файлах со случайным 128-битным именем в
 * STORE_DIR. Имя файла нигде в мире не записано: ГМ находит его
 * просмотром папки. Подбирать имя бесполезно.
 *
 * Файлы мира: world-<worldId>-<hex>.json (главный, его пишет ГМ). Любые
 * другие *.json в папке (выгрузка Картографа) читаются, но не
 * переписываются; файл мира главнее.
 */

import {
  MODULE_ID, STORE_DIR, BEHAVIOR_TYPE, mergeStore, buildStoreFile, newWorldFileName,
  normalizeSecret, isTextKey
} from "./logic.mjs";

const FP = () => foundry.applications.apps.FilePicker.implementation;

const state = {
  zones: {},          // textKey → {text, textFail, gmNote}
  mainFile: null,     // имя главного файла мира
  loaded: false,
  loading: null,
  saving: null,
  dirty: false
};

async function ensureDir() {
  try {
    await FP().browse("data", STORE_DIR);
  } catch {
    try { await FP().createDirectory("data", STORE_DIR, {}); } catch (e) {
      if (!/exist/i.test(String(e?.message ?? e))) throw e;
    }
  }
}

async function readAll() {
  await ensureDir();
  const res = await FP().browse("data", STORE_DIR, { extensions: [".json"] });
  const files = [];
  for (const path of res.files ?? []) {
    const name = decodeURIComponent(path.split("/").pop());
    try {
      const r = await fetch(`${foundry.utils.getRoute(path)}?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) files.push({ name, data: await r.text() });
    } catch (e) {
      console.warn(`${MODULE_ID} | осмотр: не прочитан ${name}`, e);
    }
  }
  return files;
}

/** Загрузить (или перечитать) хранилище. Только ГМ. */
export async function loadStore({ force = false } = {}) {
  if (!game.user.isGM) return state;
  if (state.loaded && !force) return state;
  state.loading ??= (async () => {
    try {
      const { zones, mainFile } = mergeStore(await readAll(), game.world.id);
      state.zones = zones;
      state.mainFile = mainFile;
      state.loaded = true;
    } finally {
      state.loading = null;
    }
  })();
  await state.loading;
  return state;
}

/** Тексты зоны по ключу (ГМ). */
export function getSecret(key) {
  return normalizeSecret(isTextKey(key) ? state.zones[key] : null);
}

export function hasStoreEntry(key) {
  return isTextKey(key) && !!state.zones[key];
}

export const storeReady = () => state.loaded;

/** Ключи текстов, которые есть в мире (по всем сценам). */
function usedKeys() {
  const keys = new Set();
  for (const scene of game.scenes) {
    for (const region of scene.regions) {
      for (const b of region.behaviors) {
        if (b.type === BEHAVIOR_TYPE && isTextKey(b.system?.textKey)) keys.add(b.system.textKey);
      }
    }
  }
  return keys;
}

async function writeMain(extraKeys = []) {
  const keys = usedKeys();
  for (const k of extraKeys) keys.add(k);
  const body = JSON.stringify(buildStoreFile(state.zones, keys), null, 1);
  state.mainFile ??= newWorldFileName(game.world.id);
  const file = new File([body], state.mainFile, { type: "application/json" });
  await ensureDir();
  const res = await FP().upload("data", STORE_DIR, file, {}, { notify: false });
  if (!res?.path) throw new Error("Осмотр: файл текстов не записан (upload)");
}

/**
 * Записать тексты зоны и сохранить файл мира. Только ГМ.
 * @param {Record<string, object>} entries — textKey → тексты
 */
export async function setSecrets(entries) {
  if (!game.user.isGM) throw new Error("Только ГМ пишет тексты осмотра");
  await loadStore();
  for (const [k, v] of Object.entries(entries)) {
    if (isTextKey(k)) state.zones[k] = normalizeSecret(v);
  }
  // Последовательно: две записи подряд не должны обогнать друг друга.
  const run = async () => writeMain(Object.keys(entries));
  state.saving = (state.saving ?? Promise.resolve()).then(run, run);
  await state.saving;
  // Другие ГМы перечитают хранилище.
  const gms = game.users.filter((u) => u.isGM && u.active && u.id !== game.user.id).map((u) => u.id);
  if (gms.length) game.socket.emit(`module.${MODULE_ID}`, { type: "inspect.storeChanged" }, { recipients: gms });
}

export function storeInfo() {
  return { dir: STORE_DIR, mainFile: state.mainFile, count: Object.keys(state.zones).length };
}
