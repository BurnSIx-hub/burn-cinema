/**
 * 🔥 Cinema · «Восприятие безумия» — общие константы и модель данных.
 *
 * Модель — колода видений. Видение — именованная карточка: ЧТО видит цель
 * (облик, призрак, пропажа, цвет, звук) и к чему это привязано. Кому и как
 * показывать, решается отдельно для каждой цели (TargetState).
 *
 * Все подмены живут только в рендере клиента цели — документы Scene/Token/
 * Actor не меняются (кроме того, что ГМ сам прячет призраков штатным hidden).
 *
 * Модель доверия честная: world-настройки приходят всем клиентам, так что
 * любопытный игрок найдёт их в консоли. Стоп согласован со столом.
 */

export const MODULE_ID = "burn-cinema";

/** World: Vision[] — общая колода видений. */
export const SETTING_DECK = "madnessDeck";

/** World: { [userId]: TargetState } — что и как показывается каждой цели. */
export const SETTING_TARGETS = "madnessTargets";

/** World: [{ id, name, src }] — библиотека картинок для облика. */
export const SETTING_PRESETS = "madnessPresets";

/** World: [{ id, name, track }] — библиотека треков безумия. */
export const SETTING_MUSIC_PRESETS = "madnessMusicPresets";

/** Client: последняя выбранная цель в панели ГМ. */
export const SETTING_LAST_TARGET = "madnessLastTarget";

/** Флаг на User игрока: стоп нажат (значение — Date.now() у игрока).
 *  Ставит сам игрок, снимает ГМ. Держится после F5 и без ГМ онлайн. */
export const FLAG_STOP = "madnessStop";

/** Сокет — общий канал контейнера; наши сообщения помечены scope="madness". */
export const SOCKET = "module.burn-cinema";
export const SCOPE = "madness";

/** Виды видений. */
export const KINDS = ["appearance", "phantom", "vanish", "tint", "sound"];

export const KIND_ICONS = {
  appearance: "fa-masks-theater",
  phantom: "fa-ghost",
  vanish: "fa-eye-slash",
  tint: "fa-palette",
  sound: "fa-ear-listen"
};

/**
 * Сила фона безумия. 0 — фон выключен (удержание и ручные вспышки работают).
 * Интервал и длительность каждый раз случайны внутри диапазона: ровный тик
 * выдал бы механику.
 */
export const INTENSITY = {
  1: { intervalMin: 90000, intervalMax: 240000, durMin: 400,  durMax: 1200 },
  2: { intervalMin: 30000, intervalMax: 90000,  durMin: 1500, durMax: 4000 },
  3: { intervalMin: 8000,  intervalMax: 25000,  durMin: 4000, durMax: 10000 }
};

/** Длительность ручной вспышки по умолчанию, секунды. */
export const FLASH_SECONDS = 3;

/** Состояние одной цели. */
export function defaultTarget() {
  return {
    intensity: 0,   // 0..3 — фон
    held: [],       // id видений, которые держатся постоянно
    ambient: [],    // id видений в фоновом наборе
    music: { enabled: false, isolate: true, track: null }
  };
}

/**
 * Новое видение.
 * sceneId = null — видение не привязано к сцене (облик по актёру, цвет, звук).
 */
export function newVision(kind, data = {}) {
  return {
    id: foundry.utils.randomID(),
    kind,
    name: "",
    sceneId: null,
    tokens: [],     // id токенов на sceneId
    tiles: [],      // id тайлов на sceneId
    actors: [],     // id актёров: облик для любого их токена на любой сцене
    img: "",        // облик: картинка
    label: "",      // облик: имя над токеном ("" — не менять)
    look: { ...DEFAULT_LOOK }, // облик: масштаб, отражение, кольцо, оттенок
    tint: { hue: 0, saturation: 1, brightness: 1 },
    sound: { src: "", volume: 0.8 },
    ...data
  };
}

/**
 * Настройки облика поверх токена цели. Нейтральные значения ничего не меняют:
 * масштаб 1, без отражения, кольцо «как у токена», без своих цветов, полная
 * непрозрачность. Цвета — "#rrggbb" или "" (не менять).
 */
export const DEFAULT_LOOK = Object.freeze({
  scale: 1,
  mirrorX: false,
  mirrorY: false,
  ring: "keep",      // "keep" — как у токена, "off" — снять, "on" — надеть
  ringColor: "",
  ringBg: "",
  tint: "",
  alpha: 1
});

export const RING_MODES = ["keep", "off", "on"];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Привести настройки облика к допустимым (старые видения их не имеют). */
export function normalizeLook(look = {}) {
  const num = (x, lo, hi, d) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const hex = (c) => (typeof c === "string" && HEX_COLOR.test(c)) ? c.toLowerCase() : "";
  const tint = hex(look?.tint);
  return {
    scale: num(look?.scale, 0.1, 5, 1),
    mirrorX: !!look?.mirrorX,
    mirrorY: !!look?.mirrorY,
    ring: RING_MODES.includes(look?.ring) ? look.ring : "keep",
    ringColor: hex(look?.ringColor),
    ringBg: hex(look?.ringBg),
    tint: tint === "#ffffff" ? "" : tint, // белый оттенок — без оттенка
    alpha: num(look?.alpha, 0.05, 1, 1)
  };
}

/** Настройки облика ничего не меняют. */
export function isPlainLook(look) {
  const k = normalizeLook(look);
  return k.scale === 1 && !k.mirrorX && !k.mirrorY && k.ring === "keep"
    && !k.ringColor && !k.ringBg && !k.tint && k.alpha === 1;
}

/** Видение относится к сцене sceneId? */
export function appliesToScene(vision, sceneId) {
  return !vision.sceneId || vision.sceneId === sceneId;
}

/** Целое случайное в [min, max]. */
export function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
