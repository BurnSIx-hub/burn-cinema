/**
 * 🔥 Осмотр предметов — перевод зон 1.3.0.
 *
 * В 1.3.0 тексты (text, textFail, gmNote) лежали прямо в system поведения
 * и уходили всем клиентам. Сервер хранит system модульного типа как есть,
 * поэтому убрать поля из схемы мало: в базе они остаются и приходят
 * игрокам сырыми. Перевод:
 *   1) читает сцены с сервера сырыми (get по сокету: клиентская модель уже
 *      выбросила неизвестные поля);
 *   2) кладёт тексты в хранилище под новым textKey;
 *   3) заменяет system целиком (ForcedReplacement) только публичными
 *      полями — старые ключи исчезают из базы;
 *   4) вычищает заметку ГМа из шёпот-отчётов 1.3.0 в чате: шёпот хранится
 *      в мире и уходит всем клиентам. Сам отчёт остаётся.
 */

import { MODULE_ID, BEHAVIOR_TYPE, normalizeSystem, normalizeSecret, hasSecret, newTextKey, isTextKey } from "./logic.mjs";
import { setSecrets, hasStoreEntry } from "./store.mjs";

const LEGACY = ["text", "textFail", "gmNote"];

/** Сырые сцены мира с сервера (только ГМ). */
async function rawScenes() {
  const res = await foundry.helpers.SocketInterface.dispatch("modifyDocument", {
    type: "Scene", action: "get", operation: { query: {}, index: false }
  });
  return res?.result ?? [];
}

/** Найти поведения осмотра со старыми полями в сырых данных. */
export function findLegacy(scenes) {
  const out = [];
  for (const sc of scenes ?? []) {
    for (const rg of sc.regions ?? []) {
      for (const bh of rg.behaviors ?? []) {
        if (bh?.type !== BEHAVIOR_TYPE || !bh.system) continue;
        if (LEGACY.some((f) => f in bh.system)) out.push({ sceneId: sc._id, regionId: rg._id, behaviorId: bh._id, system: bh.system });
      }
    }
  }
  return out;
}

/** Убрать блок заметки ГМа из HTML отчёта 1.3.0 (div.bic-note). */
export function stripReportNote(html) {
  if (typeof html !== "string" || !html.includes("bic-note")) return html;
  const d = document.createElement("div");
  d.innerHTML = html;
  d.querySelectorAll(".bic-note").forEach((n) => n.remove());
  return d.innerHTML;
}

async function scrubLegacyReports() {
  const updates = [];
  for (const m of game.messages) {
    const c = m._source?.content;
    if (typeof c !== "string" || !c.includes("burn-inspect-chat") || !c.includes("bic-note")) continue;
    updates.push({ _id: m.id, content: stripReportNote(c) });
  }
  if (updates.length) await ChatMessage.implementation.updateDocuments(updates);
  return updates.length;
}

export async function migrateLegacyTexts() {
  if (!game.user.isGM) return 0;
  const scrubbed = await scrubLegacyReports();
  if (scrubbed) console.log(`${MODULE_ID} | осмотр: из ${scrubbed} старых отчётов убрана заметка ГМа`);
  const found = findLegacy(await rawScenes());
  if (!found.length) return 0;

  const entries = {};
  const updates = [];
  for (const f of found) {
    const sys = normalizeSystem(f.system);
    let key = sys.textKey;
    if (!isTextKey(key)) key = newTextKey();
    // Не затирать уже перенесённое: если ключ есть в хранилище, тексты оттуда главнее.
    if (hasSecret(f.system) && !hasStoreEntry(key)) entries[key] = normalizeSecret(f.system);
    updates.push({ ...f, system: { ...sys, textKey: key } });
  }

  // Сначала тексты на диск, потом вычищаем регион: при сбое записи данные не теряются.
  if (Object.keys(entries).length) await setSecrets(entries);

  const { ForcedReplacement } = foundry.data.operators;
  for (const u of updates) {
    const b = game.scenes.get(u.sceneId)?.regions.get(u.regionId)?.behaviors.get(u.behaviorId);
    if (!b) continue;
    await b.update({ system: ForcedReplacement.create(u.system) });
  }
  console.log(`${MODULE_ID} | осмотр: перенесено зон 1.3.0 — ${updates.length}`);
  ui.notifications.info(game.i18n.format("BURNINSPECT.Migrated", { n: updates.length }));
  return updates.length;
}
