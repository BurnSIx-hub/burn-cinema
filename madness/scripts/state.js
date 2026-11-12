/**
 * Хранилище «Восприятия безумия».
 *
 * Колода (madnessDeck) и состояния целей (madnessTargets) — world-настройки.
 * Пишет только ГМ, читают все: цель берёт своё состояние сама и следит за
 * ним через onChange, так что ГМу не нужно быть онлайн, когда игрок жмёт F5.
 *
 * Стоп — флаг на User игрока: его ставит сам игрок (на себя права есть),
 * снимает ГМ.
 */

import {
  MODULE_ID, SETTING_DECK, SETTING_TARGETS, SETTING_PRESETS, SETTING_MUSIC_PRESETS,
  FLAG_STOP, defaultTarget
} from "./constants.js";

const clone = (v) => foundry.utils.deepClone(v);

/* --------------------------------- Колода -------------------------------- */

/** Все видения (копия — безопасно мутировать). */
export function getDeck() {
  return clone(game.settings.get(MODULE_ID, SETTING_DECK) ?? []);
}

export function getVision(id) {
  return getDeck().find((v) => v.id === id) ?? null;
}

/** Добавить или заменить видение по id. */
export async function saveVision(vision) {
  const deck = getDeck();
  const i = deck.findIndex((v) => v.id === vision.id);
  if (i >= 0) deck[i] = vision; else deck.push(vision);
  await game.settings.set(MODULE_ID, SETTING_DECK, deck);
  return vision;
}

/** Удалить видение из колоды и из наборов всех целей. */
export async function deleteVision(id) {
  await game.settings.set(MODULE_ID, SETTING_DECK, getDeck().filter((v) => v.id !== id));
  const all = getAllTargets();
  let dirty = false;
  for (const t of Object.values(all)) {
    const held = (t.held ?? []).filter((x) => x !== id);
    const ambient = (t.ambient ?? []).filter((x) => x !== id);
    if (held.length !== (t.held ?? []).length || ambient.length !== (t.ambient ?? []).length) {
      t.held = held; t.ambient = ambient; dirty = true;
    }
  }
  if (dirty) await game.settings.set(MODULE_ID, SETTING_TARGETS, all);
}

/* --------------------------------- Цели ---------------------------------- */

export function getAllTargets() {
  return clone(game.settings.get(MODULE_ID, SETTING_TARGETS) ?? {});
}

/** Состояние цели, слитое с дефолтами (никогда не null). */
export function getTarget(userId) {
  const raw = getAllTargets()[userId] ?? {};
  return foundry.utils.mergeObject(defaultTarget(), raw, { inplace: false });
}

/**
 * Обновить состояние цели. Массивы (held, ambient) в patch заменяются
 * целиком, вложенные объекты (music) сливаются.
 */
export async function updateTarget(userId, patch) {
  const all = getAllTargets();
  const cur = foundry.utils.mergeObject(defaultTarget(), all[userId] ?? {}, { inplace: false });
  const next = foundry.utils.mergeObject(cur, patch, { inplace: false });
  for (const k of ["held", "ambient"]) if (Array.isArray(patch[k])) next[k] = [...patch[k]];
  all[userId] = next;
  await game.settings.set(MODULE_ID, SETTING_TARGETS, all);
  return next;
}

/** Цель «что-то видит»: фон, удержание или своя музыка. */
export function isTargetActive(t) {
  return (t.intensity | 0) > 0 || (t.held?.length ?? 0) > 0 || !!t.music?.enabled;
}

/* --------------------------------- Стоп ---------------------------------- */

export function isStopped(user) {
  return !!user?.getFlag(MODULE_ID, FLAG_STOP);
}

/** Игрок жмёт стоп — ставит флаг на себя. */
export async function setStop(user) {
  await user.setFlag(MODULE_ID, FLAG_STOP, Date.now());
}

/** ГМ снимает стоп. */
export async function clearStop(user) {
  await user.unsetFlag(MODULE_ID, FLAG_STOP);
}

/* ----------------------- Библиотека картинок облика ---------------------- */

export function getPresets() {
  return clone(game.settings.get(MODULE_ID, SETTING_PRESETS) ?? []);
}

export async function addPreset(name, src) {
  const list = getPresets();
  if (!list.some((p) => p.src === src)) {
    list.push({ id: foundry.utils.randomID(), name: name || src, src });
    await game.settings.set(MODULE_ID, SETTING_PRESETS, list);
  }
  return list;
}

export async function removePreset(id) {
  await game.settings.set(MODULE_ID, SETTING_PRESETS, getPresets().filter((p) => p.id !== id));
}

/* ------------------------ Библиотека музыки безумия ---------------------- */

export function getMusicPresets() {
  return clone(game.settings.get(MODULE_ID, SETTING_MUSIC_PRESETS) ?? []);
}

export async function addMusicPreset(name, track) {
  const list = getMusicPresets();
  const key = (t) => `${t?.streamUrl ?? ""}|${t?.videoId ?? ""}`;
  if (!list.some((p) => key(p.track) === key(track))) {
    list.push({ id: foundry.utils.randomID(), name: name || "track", track });
    await game.settings.set(MODULE_ID, SETTING_MUSIC_PRESETS, list);
  }
  return list;
}

export async function removeMusicPreset(id) {
  await game.settings.set(MODULE_ID, SETTING_MUSIC_PRESETS, getMusicPresets().filter((p) => p.id !== id));
}
