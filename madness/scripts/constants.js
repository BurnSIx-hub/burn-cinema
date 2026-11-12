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
    tint: { hue: 0, saturation: 1, brightness: 1 },
    sound: { src: "", volume: 0.8 },
    ...data
  };
}

/** Видение относится к сцене sceneId? */
export function appliesToScene(vision, sceneId) {
  return !vision.sceneId || vision.sceneId === sceneId;
}

/** Целое случайное в [min, max]. */
export function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
