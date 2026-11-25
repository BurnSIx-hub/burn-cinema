/**
 * Обёртки над placeable-объектами Foundry v14 — через них цель видит видения.
 *
 * Мы не рисуем ничего своего поверх сцены. Мы отвечаем Foundry на вопросы
 * «виден ли объект?» и «как выглядит токен?», а рисует он сам: со светом,
 * туманом, высотой, окклюзией, кольцом dnd5e и видео.
 *
 *   • Token#isVisible, Tile#_refreshVisibility — призрак виден цели, пропажа нет;
 *   • _refreshState (Token, Tile)   — призрак без прозрачности «скрытого»;
 *   • TokenDocument#prepareData     — облик: картинка, масштаб, отражение,
 *     кольцо и его цвета, оттенок, прозрачность. Меняются только данные
 *     документа в памяти этого клиента: в мир ничего не пишется, а окно
 *     настроек токена показывает записанные значения (_source);
 *   • Token#_refreshNameplate       — подмена имени над токеном. Имя самого
 *     документа не трогаем: из него ChatMessage.getSpeaker берёт подпись
 *     сообщений, которые цель отправит в мир. Трекер и чат — в names.js.
 *
 * Ключи объектов — "Token.<id>" / "Tile.<id>" на ТЕКУЩЕЙ сцене (движок
 * наполняет OV только для видений этой сцены).
 */

import { MODULE_ID } from "./constants.js";

/** Активные подмены на клиенте. Наполняет engine.js. */
export const OV = {
  show: new Set(),          // ключи объектов, которые цель видит, хотя они hidden
  hide: new Set(),          // ключи объектов, которых цель не видит
  look: new Map(),          // tokenId -> { img, label, look }
  lookByActor: new Map()    // actorId -> { img, label, look }
};

/**
 * Документы токенов, к данным которых сейчас применён облик, и подпись
 * применённого облика. По ней движок понимает, кого пересчитать и
 * перерисовать, когда облик сменился или снят.
 */
export const LOOKED = new Map(); // TokenDocument -> string

export function keyOf(obj) {
  return `${obj?.document?.documentName}.${obj?.document?.id}`;
}

/** Облик для документа токена (по id токена или по его актёру). */
export function lookForDoc(doc) {
  if (!doc) return null;
  return OV.look.get(doc.id) ?? (doc.actorId ? OV.lookByActor.get(doc.actorId) : null) ?? null;
}

/** Подпись того, что облик меняет в данных токена (имя — отдельно). */
export function lookSig(entry) {
  return entry ? JSON.stringify([entry.img ?? null, entry.look ?? null]) : "";
}

/* ------------------------------ Облик ------------------------------------ */

function colorOf(hex) {
  try { return foundry.utils.Color.from(hex); } catch (_e) { return null; }
}

/** Наложить облик на подготовленные данные токена. */
function applyLook(doc) {
  const entry = lookForDoc(doc);
  if (!entry) { LOOKED.delete(doc); return; }
  const k = entry.look ?? {};
  const tex = doc.texture;
  const ring = doc.ring;

  if (entry.img && tex) tex.src = entry.img;
  if (ring) {
    if (k.ring === "off") ring.enabled = false;
    else if (k.ring === "on") ring.enabled = true;
    if (ring.enabled && ring.subject) {
      // Внутри кольца рисуется subject.texture — туда тоже картинка облика.
      if (entry.img) ring.subject.texture = entry.img;
      else ring.subject.texture ||= doc._inferRingSubjectTexture?.() ?? tex?.src;
    }
    if (ring.enabled && ring.colors) {
      if (k.ringColor) ring.colors.ring = colorOf(k.ringColor) ?? ring.colors.ring;
      if (k.ringBg) ring.colors.background = colorOf(k.ringBg) ?? ring.colors.background;
    }
  }
  if (tex) {
    const scale = k.scale ?? 1;
    // Отражение — относительно того, как токен уже повёрнут.
    tex.scaleX = ((tex.scaleX < 0) !== !!k.mirrorX ? -1 : 1) * Math.abs(tex.scaleX) * scale;
    tex.scaleY = ((tex.scaleY < 0) !== !!k.mirrorY ? -1 : 1) * Math.abs(tex.scaleY) * scale;
    if (k.tint) tex.tint = colorOf(k.tint) ?? tex.tint;
  }
  if ((k.alpha ?? 1) !== 1) doc.alpha = doc.alpha * k.alpha;
  LOOKED.set(doc, lookSig(entry));
}

function tokenDocPrepareData(wrapped, ...args) {
  const r = wrapped(...args);
  try {
    applyLook(this);
  } catch (err) {
    console.warn("burn-cinema | безумие: облик не наложился", err);
  }
  return r;
}

/* ------------------------------ Видимость -------------------------------- */

function tokenIsVisible(wrapped, ...args) {
  const key = keyOf(this);
  if (OV.hide.has(key) && !this.controlled && !this.isPreview) {
    wrapped(...args); // побочный эффект оригинала (сброс detectionFilter)
    return false;
  }
  const r = wrapped(...args);
  if (r || !OV.show.has(key) || this.isPreview) return r;
  // Призрак: ведём себя так, будто токен не скрыт, но зрение уважаем —
  // за стеной цель его не увидит.
  if (!canvas.visibility?.tokenVision) return true;
  return canvas.visibility.testVisibility(this.document.getVisibilityTestPoints(), { tolerance: 0, object: this });
}

/* Тайл: своего isVisible у Tile нет, а обёртка libWrapper над унаследованным
 * геттером PlaceableObject в v14 срабатывает не всегда (проверено в
 * песочнице). Поэтому правим итог собственного Tile#_refreshVisibility. */
function tileRefreshVisibility(wrapped, ...args) {
  const r = wrapped(...args);
  const key = keyOf(this);
  let v = null;
  if (OV.hide.has(key) && !this.controlled && !this.isPreview) v = false;
  else if (!this.visible && OV.show.has(key) && !this.hasPreview && !this.isFilteredOut) v = true;
  if (v !== null) {
    this.visible = v;
    if (this.mesh) this.mesh.visible = v;
  }
  return r;
}

/* TokenDocument#prepareBaseData у игрока делает скрытому токену
 * alpha = 0 (у ГМ — 0.5). Призраку возвращаем исходную прозрачность. */
function phantomTokenAlpha(token) {
  if (!token.mesh || !OV.show.has(keyOf(token))) return;
  token.mesh.alpha = token.alpha * (token.document._source?.alpha ?? 1);
  token.mesh.hidden = false;
}

function tokenRefreshState(wrapped, ...args) {
  const r = wrapped(...args);
  phantomTokenAlpha(this);
  return r;
}

function tileRefreshState(wrapped, ...args) {
  const r = wrapped(...args);
  if (this.mesh && OV.show.has(keyOf(this))) {
    // Штатно скрытый тайл рисуется с alpha × 0.5 — призраку это не нужно.
    this.mesh.alpha = this.alpha;
    this.mesh.hidden = false;
  }
  return r;
}

function tokenRefreshMesh(wrapped, ...args) {
  const r = wrapped(...args);
  phantomTokenAlpha(this); // _refreshMesh тоже ставит mesh.alpha
  return r;
}

function tokenRefreshNameplate(wrapped, ...args) {
  const r = wrapped(...args);
  const label = lookForDoc(this.document)?.label;
  if (label && this.nameplate) this.nameplate.text = label;
  return r;
}

/* ------------------------------ Установка -------------------------------- */

let installed = false;

/** Фолбэк без libWrapper: прямая обёртка метода или геттера в прототипе. */
export function patch(cls, name, fn, getter) {
  let proto = cls.prototype;
  let desc = null;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, name))) proto = Object.getPrototypeOf(proto);
  if (!desc) return false;
  if (getter) {
    const orig = desc.get;
    if (!orig) return false;
    Object.defineProperty(cls.prototype, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return fn.call(this, () => orig.call(this)); },
      set: desc.set
    });
  } else {
    const orig = desc.value;
    if (typeof orig !== "function") return false;
    cls.prototype[name] = function (...args) {
      return fn.call(this, (...a) => orig.apply(this, a), ...args);
    };
  }
  return true;
}

export function installWrappers() {
  if (installed) return;
  installed = true;

  // [документ, класс в CONFIG, метод, обёртка, это геттер]
  const list = [
    ["Token", "objectClass", "isVisible", tokenIsVisible, true],
    ["Tile", "objectClass", "_refreshVisibility", tileRefreshVisibility, false],
    ["Token", "objectClass", "_refreshState", tokenRefreshState, false],
    ["Tile", "objectClass", "_refreshState", tileRefreshState, false],
    ["Token", "objectClass", "_refreshMesh", tokenRefreshMesh, false],
    ["Token", "objectClass", "_refreshNameplate", tokenRefreshNameplate, false],
    ["Token", "documentClass", "prepareData", tokenDocPrepareData, false]
  ];

  const lw = globalThis.libWrapper;
  for (const [doc, cls, name, fn, getter] of list) {
    const path = `CONFIG.${doc}.${cls}.prototype.${name}`;
    try {
      if (lw) lw.register(MODULE_ID, path, fn, "WRAPPER");
      else if (!patch(CONFIG[doc][cls], name, fn, getter)) {
        console.warn(`burn-cinema | безумие: не нашёл ${path} — эта подмена не работает`);
      }
    } catch (err) {
      console.error(`burn-cinema | безумие: обёртка ${path} не встала`, err);
    }
  }
}
