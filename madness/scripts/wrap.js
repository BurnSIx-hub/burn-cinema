/**
 * Обёртки над placeable-объектами Foundry v14 — через них цель видит видения.
 *
 * Мы не рисуем ничего своего поверх сцены. Мы отвечаем Foundry на вопросы
 * «виден ли объект?» и «какая у токена картинка и имя?», а рисует он сам:
 * со светом, туманом, высотой, окклюзией и видео.
 *
 *   • Token#isVisible, Tile#_refreshVisibility — призрак виден цели, пропажа нет;
 *   • _refreshState (Token, Tile)   — призрак без прозрачности «скрытого»;
 *   • Token#_refreshMesh            — подмена текстуры (облик);
 *   • Token#_refreshNameplate       — подмена имени над токеном.
 *
 * Ключи объектов — "Token.<id>" / "Tile.<id>" на ТЕКУЩЕЙ сцене (движок
 * наполняет OV только для видений этой сцены).
 */

import { MODULE_ID } from "./constants.js";

/** Активные подмены на клиенте. Наполняет engine.js. */
export const OV = {
  show: new Set(),          // ключи объектов, которые цель видит, хотя они hidden
  hide: new Set(),          // ключи объектов, которых цель не видит
  look: new Map(),          // tokenId -> { tex, label }
  lookByActor: new Map()    // actorId -> { tex, label }
};

/** Оригинальные текстуры подменённых мешей (ключ — меш: перерисовка токена
 *  создаёт новый меш, и устаревший оригинал не вернётся по ошибке). */
const ORIGINAL_TEX = new WeakMap();

export function keyOf(obj) {
  return `${obj?.document?.documentName}.${obj?.document?.id}`;
}

export function lookFor(token) {
  const doc = token?.document;
  if (!doc) return null;
  return OV.look.get(doc.id) ?? (doc.actorId ? OV.lookByActor.get(doc.actorId) : null) ?? null;
}

/* ------------------------------ Обёртки ---------------------------------- */

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

/* TokenDocument#prepareDerivedData у игрока делает скрытому токену
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
  const mesh = this.mesh;
  if (mesh && !mesh.destroyed) {
    const tex = lookFor(this)?.tex ?? null;
    if (tex && mesh.texture !== tex) {
      if (!ORIGINAL_TEX.has(mesh)) ORIGINAL_TEX.set(mesh, mesh.texture);
      mesh.texture = tex;
    } else if (!tex && ORIGINAL_TEX.has(mesh)) {
      const orig = ORIGINAL_TEX.get(mesh);
      ORIGINAL_TEX.delete(mesh);
      mesh.texture = (orig && !orig.destroyed && orig.baseTexture) ? orig : (this.texture ?? orig);
    }
  }
  const r = wrapped(...args); // штатный ресайз уже под новую текстуру
  phantomTokenAlpha(this);    // _refreshMesh тоже ставит mesh.alpha
  return r;
}

function tokenRefreshNameplate(wrapped, ...args) {
  const r = wrapped(...args);
  const label = lookFor(this)?.label;
  if (label && this.nameplate) this.nameplate.text = label;
  return r;
}

/* ------------------------------ Установка -------------------------------- */

let installed = false;

/** Фолбэк без libWrapper: прямая обёртка метода или геттера в прототипе. */
function patch(cls, name, fn, getter) {
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

  const list = [
    ["Token", "isVisible", tokenIsVisible, true],
    ["Tile", "_refreshVisibility", tileRefreshVisibility, false],
    ["Token", "_refreshState", tokenRefreshState, false],
    ["Tile", "_refreshState", tileRefreshState, false],
    ["Token", "_refreshMesh", tokenRefreshMesh, false],
    ["Token", "_refreshNameplate", tokenRefreshNameplate, false]
  ];

  const lw = globalThis.libWrapper;
  for (const [doc, name, fn, getter] of list) {
    const path = `CONFIG.${doc}.objectClass.prototype.${name}`;
    try {
      if (lw) lw.register(MODULE_ID, path, fn, "WRAPPER");
      else if (!patch(CONFIG[doc].objectClass, name, fn, getter)) {
        console.warn(`burn-cinema | безумие: не нашёл ${path} — эта подмена не работает`);
      }
    } catch (err) {
      console.error(`burn-cinema | безумие: обёртка ${path} не встала`, err);
    }
  }
}
