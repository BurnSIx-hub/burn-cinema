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

/** Значения system по умолчанию — они же описаны в inspect/FORMAT.md. */
export const DEFAULTS = Object.freeze({
  title: "",
  text: "",
  checkMode: CHECK.NONE,
  skill: "prc",
  dc: 12,
  textFail: "",
  visibility: VISIBILITY.SELF,
  range: 0,
  repeat: REPEAT.REMEMBER,
  gmNote: "",
  sound: "",
  duration: 0
});

const pickEnum = (v, en, d) => (Object.values(en).includes(v) ? v : d);
const num = (v, d, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, n) : d;
};
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * Приводит произвольный объект (выгрузка Картографа, старая версия, ручной
 * JSON) к полному набору полей с допустимыми значениями.
 */
export function normalizeSystem(src = {}) {
  const s = src ?? {};
  return {
    title: str(s.title).trim(),
    text: str(s.text),
    checkMode: pickEnum(s.checkMode, CHECK, DEFAULTS.checkMode),
    skill: str(s.skill).trim() || DEFAULTS.skill,
    dc: Math.round(num(s.dc, DEFAULTS.dc, 0)),
    textFail: str(s.textFail),
    visibility: pickEnum(s.visibility, VISIBILITY, DEFAULTS.visibility),
    range: num(s.range, DEFAULTS.range, 0),
    repeat: pickEnum(s.repeat, REPEAT, DEFAULTS.repeat),
    gmNote: str(s.gmNote),
    sound: str(s.sound).trim(),
    duration: num(s.duration, DEFAULTS.duration, 0)
  };
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

/** Текст под итог. Пустой текст провала заменяется fallbackFail. */
export function textFor(sys, outcome, fallbackFail = "") {
  const s = normalizeSystem(sys);
  if (outcome === OUTCOME.FAIL) return s.textFail.trim() ? s.textFail : fallbackFail;
  return s.text;
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
