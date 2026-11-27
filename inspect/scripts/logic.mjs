/**
 * 🔥 Осмотр предметов — чистая логика без Foundry.
 * Этот файл грузится и в браузере, и в node (tools/inspect-selftest.mjs),
 * поэтому здесь нет обращений к game, canvas, CONFIG и DOM.
 */

export const MODULE_ID = "burn-cinema";
export const BEHAVIOR_TYPE = `${MODULE_ID}.inspect`;
export const FLAG_SEEN = "inspectSeen";

/** Кому показывать текст. */
export const VISIBILITY = Object.freeze({ SELF: "self", ALL: "all", CHAT: "chat" });
/** Как ведёт себя повторный осмотр. */
export const REPEAT = Object.freeze({ ALWAYS: "always", REMEMBER: "remember", ONCE: "once" });
/** Нужна ли проверка навыка. */
export const CHECK = Object.freeze({ NONE: "none", ROLL: "roll", PASSIVE: "passive" });
/** Итог осмотра. */
export const OUTCOME = Object.freeze({ PLAIN: "plain", SUCCESS: "success", FAIL: "fail" });

/**
 * Значения system по умолчанию — публичная часть зоны, она лежит в регионе
 * и уходит всем клиентам. Тексты сюда не входят (см. SECRET_DEFAULTS).
 * Описано в inspect/FORMAT.md.
 */
export const DEFAULTS = Object.freeze({
  textKey: "",
  title: "",
  checkMode: CHECK.NONE,
  skill: "prc",
  dc: 12,
  visibility: VISIBILITY.SELF,
  range: 0,
  repeat: REPEAT.REMEMBER,
  sound: "",
  duration: 0
});

/** Секретная часть зоны — живёт только в файле хранилища, игрокам не уходит. */
export const SECRET_DEFAULTS = Object.freeze({ text: "", textFail: "", gmNote: "" });
export const SECRET_FIELDS = Object.freeze(Object.keys(SECRET_DEFAULTS));

/** Папка хранилища текстов в источнике «data». Список файлов в ней сервер
 * отдаёт только пользователям с правом FILES_BROWSE. */
export const STORE_DIR = "burn-inspect-secret";
export const STORE_VERSION = 1;

const pickEnum = (v, en, d) => (Object.values(en).includes(v) ? v : d);
const num = (v, d, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, n) : d;
};
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Приводит произвольный объект (выгрузка Картографа, старая версия, ручной
 * JSON) к полному набору публичных полей с допустимыми значениями.
 * Тексты (text, textFail, gmNote) отбрасываются.
 */
export function normalizeSystem(src = {}) {
  const s = src ?? {};
  const key = str(s.textKey).trim();
  return {
    textKey: KEY_RE.test(key) ? key : "",
    title: str(s.title).trim(),
    checkMode: pickEnum(s.checkMode, CHECK, DEFAULTS.checkMode),
    skill: str(s.skill).trim() || DEFAULTS.skill,
    dc: Math.round(num(s.dc, DEFAULTS.dc, 0)),
    visibility: pickEnum(s.visibility, VISIBILITY, DEFAULTS.visibility),
    range: num(s.range, DEFAULTS.range, 0),
    repeat: pickEnum(s.repeat, REPEAT, DEFAULTS.repeat),
    sound: str(s.sound).trim(),
    duration: num(s.duration, DEFAULTS.duration, 0)
  };
}

/** Секретные тексты зоны с допустимыми значениями. */
export function normalizeSecret(src = {}) {
  const s = src ?? {};
  return { text: str(s.text), textFail: str(s.textFail), gmNote: str(s.gmNote) };
}

/** Есть ли в объекте хоть один непустой текст (для перевода зон 1.3.0). */
export function hasSecret(src) {
  return !!src && SECRET_FIELDS.some((f) => typeof src[f] === "string" && src[f].trim());
}

/** Случайная строка из hex-цифр: bytes байт энтропии. */
export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ключ текстов зоны (system.textKey): 16 hex = 64 бита, уникален между мирами. */
export const newTextKey = () => randomHex(8);
export const isTextKey = (k) => typeof k === "string" && KEY_RE.test(k);

/** Имя главного файла мира: префикс по id мира + 128 бит случайности. */
export const worldFilePrefix = (worldId) => `world-${String(worldId).replace(/[^A-Za-z0-9_-]/g, "_")}-`;
export const newWorldFileName = (worldId) => `${worldFilePrefix(worldId)}${randomHex(16)}.json`;

/** Разбирает содержимое файла хранилища; мусор — пустой набор. */
export function parseStoreFile(json) {
  let data = json;
  if (typeof json === "string") {
    try { data = JSON.parse(json); } catch { return {}; }
  }
  const zones = data && typeof data === "object" ? data.zones : null;
  if (!zones || typeof zones !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(zones)) {
    if (!isTextKey(k) || !v || typeof v !== "object") continue;
    out[k] = normalizeSecret(v);
  }
  return out;
}

/**
 * Сводит файлы хранилища в один набор. Файлы мира (по префиксу) главнее
 * остальных (выгрузки Картографа и пр.); среди равных — по имени.
 * @param {{name: string, data: object|string}[]} files
 * @param {string} worldId
 * @returns {{zones: Record<string, object>, mainFile: string|null}}
 */
export function mergeStore(files, worldId) {
  const prefix = worldFilePrefix(worldId);
  const list = [...files].sort((a, b) => {
    const am = a.name.startsWith(prefix), bm = b.name.startsWith(prefix);
    if (am !== bm) return am ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const zones = {};
  let mainFile = null;
  for (const f of list) {
    Object.assign(zones, parseStoreFile(f.data));
    if (f.name.startsWith(prefix)) mainFile = f.name;
  }
  return { zones, mainFile };
}

/** Содержимое главного файла мира: только ключи, которые есть в мире. */
export function buildStoreFile(zones, usedKeys) {
  const out = {};
  for (const k of [...usedKeys].sort()) {
    if (zones[k] && isTextKey(k)) out[k] = normalizeSecret(zones[k]);
  }
  return { version: STORE_VERSION, zones: out };
}

/** Ключ памяти осмотра: персонаж, иначе токен, иначе пользователь. */
export function memoryKey({ actorId, tokenId, userId } = {}) {
  if (actorId) return `a_${actorId}`;
  if (tokenId) return `t_${tokenId}`;
  return `u_${userId ?? "x"}`;
}

/**
 * Что делать с кликом с учётом памяти зоны.
 * @returns {{allowed: boolean, reuse: string|null, needRoll: boolean}}
 *   allowed — можно ли осматривать; reuse — запомненный итог (бросать не надо);
 *   needRoll — нужен ли бросок от игрока.
 */
export function planInspection(sys, seen) {
  const s = normalizeSystem(sys);
  const prev = seen?.o ?? null;
  if (prev && s.repeat === REPEAT.ONCE) return { allowed: false, reuse: prev, needRoll: false };
  if (prev && s.repeat === REPEAT.REMEMBER) return { allowed: true, reuse: prev, needRoll: false };
  return { allowed: true, reuse: null, needRoll: s.checkMode === CHECK.ROLL };
}

/**
 * Итог по проверке.
 * @param {object} sys
 * @param {{total?: number, passive?: number}} res — бросок или пассивное значение
 */
export function resolveOutcome(sys, res = {}) {
  const s = normalizeSystem(sys);
  if (s.checkMode === CHECK.NONE) return OUTCOME.PLAIN;
  const value = s.checkMode === CHECK.PASSIVE ? res.passive : res.total;
  if (!Number.isFinite(Number(value))) return OUTCOME.FAIL;
  return Number(value) >= s.dc ? OUTCOME.SUCCESS : OUTCOME.FAIL;
}

/** Текст под итог (по секретной части зоны). Пустой текст заменяется fallback
 * («Ничего примечательного»), чтобы плашка не вышла пустой. */
export function textFor(secret, outcome, fallback = "") {
  const s = normalizeSecret(secret);
  const t = outcome === OUTCOME.FAIL ? s.textFail : s.text;
  return t.trim() ? t : fallback;
}

/**
 * Кому слать плашку.
 * @param {object} sys
 * @param {string} userId  — кто кликнул
 * @param {string[]} allUserIds — активные пользователи
 * @returns {{users: string[], chat: boolean}}
 */
export function targetsFor(sys, userId, allUserIds = []) {
  const s = normalizeSystem(sys);
  if (s.visibility === VISIBILITY.ALL) return { users: [...new Set([userId, ...allUserIds])], chat: false };
  return { users: [userId], chat: s.visibility === VISIBILITY.CHAT };
}

/* ------------------------------ Геометрия -------------------------------- */

/** Расстояние от точки до отрезка, px. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

/** Точка внутри многоугольника (плоский массив [x0,y0,x1,y1,…]). */
export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Расстояние от точки до набора многоугольников, px; 0 — точка внутри.
 * @param {{points: number[], isPositive?: boolean}[]} polys
 */
export function distToPolygons(x, y, polys) {
  let best = Infinity;
  let inside = false;
  for (const p of polys) {
    const pts = p.points;
    if (!pts || pts.length < 6) continue;
    if (pointInPolygon(x, y, pts)) {
      // Дыра (isPositive === false) вырезает точку из зоны.
      if (p.isPositive === false) inside = false;
      else inside = true;
    }
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      best = Math.min(best, distToSegment(x, y, pts[i], pts[i + 1], pts[j], pts[j + 1]));
    }
  }
  return inside ? 0 : best;
}

/** Пиксели в единицы сцены (футы и т. п.). */
export function pxToUnits(px, gridSize, gridDistance) {
  if (!gridSize) return px;
  return (px / gridSize) * gridDistance;
}

/** Дотягивается ли персонаж: range 0 — без ограничения. */
export function inRange(sys, distUnits) {
  const s = normalizeSystem(sys);
  if (!s.range) return true;
  return distUnits <= s.range + 1e-6;
}

/**
 * Куда ставить плашку на экране. Якорь — верхняя середина зоны;
 * если сверху не помещается, плашка уходит под зону.
 * @returns {{left: number, top: number, below: boolean}}
 */
export function placePlaque({ anchorTop, anchorBottom, viewW, viewH, w, h, gap = 14, margin = 8 }) {
  let below = false;
  let top = anchorTop.y - gap - h;
  if (top < margin) {
    below = true;
    top = anchorBottom.y + gap;
  }
  top = Math.max(margin, Math.min(viewH - h - margin, top));
  const left = Math.max(margin, Math.min(viewW - w - margin, anchorTop.x - w / 2));
  return { left, top, below };
}
