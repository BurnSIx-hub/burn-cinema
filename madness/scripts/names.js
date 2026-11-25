/**
 * Имя и картинка облика за пределами холста — только у цели.
 *
 * Облик (wrap.js) меняет токен на холсте и имя над ним. Но имя токена
 * видно и в других местах. Здесь мы подменяем то, что видит цель:
 *
 *   • трекер инициативы — CombatTracker#_prepareTurnContext: имя и картинка;
 *   • отправитель сообщения — геттер ChatMessage#alias (по нему пишут
 *     подпись и Foundry, и шапка dnd5e), аватар dnd5e — после её шапки;
 *   • упоминания имени в тексте сообщений и в трекере («Альбедо бросает
 *     инициативу», цели атаки dnd5e) — заменой текста. Цели атаки dnd5e
 *     достраивает уже после вставки в чат, поэтому за сообщением следит
 *     MutationObserver.
 *
 * Документы не трогаем: ChatMessage.getSpeaker берёт подпись из имени
 * токена, и сообщения, которые цель отправит, уйдут в мир с настоящим именем.
 * Текст заменяем, только если имя однозначно: если на сцене есть токен без
 * облика с тем же именем, упоминание остаётся как есть.
 */

import { MODULE_ID } from "./constants.js";
import { OV, lookForDoc, patch } from "./wrap.js";

const hasLooks = () => OV.look.size > 0 || OV.lookByActor.size > 0;

/** Облик говорящего в сообщении: его токена или актёра. */
export function lookForSpeaker(speaker) {
  if (!speaker || !hasLooks()) return null;
  return (speaker.token ? OV.look.get(speaker.token) : null)
    ?? (speaker.actor ? OV.lookByActor.get(speaker.actor) : null)
    ?? null;
}

function lookForCombatant(c) {
  if (!c || !hasLooks()) return null;
  return lookForDoc(c.token) ?? (c.actorId ? OV.lookByActor.get(c.actorId) : null) ?? null;
}

/* ------------------------------ Замена текста ----------------------------- */

let swapCache;  // undefined — пересчитать; null — замен нет

/**
 * Настоящее имя → имя облика. Подписи обликов в выражение входят тоже и
 * остаются как есть — повторная замена ничего не портит, даже если подпись
 * содержит настоящее имя («Альбедо» → «Тёмный Альбедо»).
 */
function nameSwaps() {
  if (swapCache !== undefined) return swapCache;
  swapCache = null;
  if (!hasLooks()) return null;

  const map = new Map();
  const labels = new Set();
  const bad = new Set();
  const add = (name, label) => {
    name = String(name ?? "").trim();
    if (name.length < 2 || name === label) return;
    if (map.has(name) && map.get(name) !== label) bad.add(name);
    map.set(name, label);
  };

  const tokens = canvas.scene?.tokens ? [...canvas.scene.tokens] : [];
  for (const doc of tokens) {
    const label = lookForDoc(doc)?.label;
    if (!label) continue;
    labels.add(label);
    add(doc.name, label);
  }
  for (const [actorId, entry] of OV.lookByActor) {
    if (!entry.label) continue;
    labels.add(entry.label);
    add(game.actors?.get(actorId)?.name, entry.label);
  }
  // Имя, которое носит и токен без облика, — не наше: его не трогаем.
  for (const doc of tokens) if (!lookForDoc(doc)?.label) bad.add(String(doc.name ?? "").trim());
  for (const name of bad) map.delete(name);
  if (!map.size) return null;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alts = [...new Set([...map.keys(), ...labels])].sort((a, b) => b.length - a.length).map(esc);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  swapCache = { map, labels, re };
  return swapCache;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);
const ATTRS = ["alt", "title", "aria-label", "data-tooltip"];

/** Заменить настоящие имена в тексте и подсказках внутри node. */
export function swapNames(node) {
  const s = nameSwaps();
  if (!s || !node) return false;
  const fix = (text) => {
    if (!text) return null;
    s.re.lastIndex = 0;
    if (!s.re.test(text)) return null;
    const out = text.replace(s.re, (m) => (s.labels.has(m) ? m : (s.map.get(m) ?? m)));
    return out === text ? null : out;
  };
  let changed = false;

  if (node.nodeType === Node.TEXT_NODE) {
    if (SKIP_TAGS.has(node.parentElement?.tagName)) return false;
    const out = fix(node.nodeValue);
    if (out !== null) { node.nodeValue = out; changed = true; }
    return changed;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (SKIP_TAGS.has(n.parentElement?.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const out = fix(n.nodeValue);
    if (out !== null) { n.nodeValue = out; changed = true; }
  }
  const sel = ATTRS.map((a) => `[${a}]`).join(",");
  for (const el of [node, ...node.querySelectorAll(sel)]) {
    for (const a of ATTRS) {
      const out = fix(el.getAttribute(a));
      if (out !== null) { el.setAttribute(a, out); changed = true; }
    }
  }
  return changed;
}

/* --------------------------------- Чат ------------------------------------ */

const MARK = "bmMadness"; // data-bm-madness: в сообщении что-то подменено
const WATCHED = new WeakSet();

/** dnd5e достраивает часть сообщения уже в чате (цели атаки) — следим. */
function watchMessage(el) {
  if (WATCHED.has(el)) return;
  WATCHED.add(el);
  new MutationObserver((records) => {
    if (!hasLooks()) return;
    for (const r of records) {
      for (const n of r.addedNodes) if (swapNames(n)) el.dataset[MARK] = "1";
    }
  }).observe(el, { childList: true, subtree: true });
}

function setAvatar(html, src) {
  const av = html.querySelector(".message-header .avatar > img, .message-header .avatar > video");
  if (!av) return false;
  if (av.tagName === "VIDEO") {
    const img = document.createElement("img");
    img.alt = av.getAttribute("alt") ?? "";
    av.replaceWith(img);
    img.src = src;
  } else av.src = src;
  return true;
}

function onRenderMessage(message, html) {
  if (!(html instanceof HTMLElement) || !hasLooks()) return;
  try {
    let touched = false;
    const ic = message.style !== CONST.CHAT_MESSAGE_STYLES.OOC && message.isContentVisible;
    const entry = ic ? lookForSpeaker(message.speaker) : null;
    if (entry?.label) touched = true; // подпись уже из геттера alias
    if (entry?.img && setAvatar(html, entry.img)) touched = true;
    if (swapNames(html)) touched = true;
    if (nameSwaps()) watchMessage(html);
    if (touched) html.dataset[MARK] = "1";
  } catch (err) {
    console.warn("burn-cinema | безумие: не удалось подменить имя в сообщении", err);
  }
}

function chatAlias(wrapped, ...args) {
  const alias = wrapped(...args);
  if (this.style === CONST.CHAT_MESSAGE_STYLES.OOC) return alias;
  return lookForSpeaker(this.speaker)?.label || alias;
}

/* -------------------------------- Трекер ---------------------------------- */

async function combatTurnContext(wrapped, combat, combatant, ...rest) {
  const turn = await wrapped(combat, combatant, ...rest);
  try {
    const entry = lookForCombatant(combatant);
    if (entry?.label) turn.name = entry.label;
    if (entry?.img) turn.img = entry.img;
  } catch (err) {
    console.warn("burn-cinema | безумие: не удалось подменить имя в трекере", err);
  }
  return turn;
}

/* ---------------------------- Перерисовка --------------------------------- */

let lastSig = JSON.stringify([[], []]); // обликов нет — перерисовывать нечего

function namesSig() {
  const pick = (m) => [...m].filter(([, e]) => e.label || e.img).map(([id, e]) => [id, e.label || "", e.img || ""]).sort();
  return JSON.stringify([pick(OV.look), pick(OV.lookByActor)]);
}

/**
 * Облик сменился — перерисовать трекеры и сообщения, где он виден сейчас
 * или был виден раньше. Зовёт движок после каждой пересборки видений.
 */
export function syncNameViews() {
  swapCache = undefined;
  const sig = namesSig();
  if (sig === lastSig) return;
  lastSig = sig;

  const Tracker = foundry.applications?.sidebar?.tabs?.CombatTracker;
  for (const app of foundry.applications?.instances?.values?.() ?? []) {
    if (Tracker && app instanceof Tracker && app.rendered) app.render();
  }

  const log = ui.chat?.element;
  if (!log) return;
  const s = nameSwaps();
  for (const el of log.querySelectorAll(".message[data-message-id]")) {
    const msg = game.messages.get(el.dataset.messageId);
    if (!msg) continue;
    let redo = !!el.dataset[MARK] || !!lookForSpeaker(msg.speaker);
    if (!redo && s) { s.re.lastIndex = 0; redo = s.re.test(el.textContent); }
    if (redo) ui.chat.updateMessage(msg);
  }
}

/* ------------------------------ Установка --------------------------------- */

let installed = false;

export function installNameWrappers() {
  if (installed) return;
  installed = true;

  // [путь для libWrapper, класс для фолбэка, член, обёртка, это геттер]
  const list = [
    ["foundry.documents.ChatMessage.prototype.alias", () => foundry.documents.ChatMessage, "alias", chatAlias, true],
    ["foundry.applications.sidebar.tabs.CombatTracker.prototype._prepareTurnContext",
      () => foundry.applications.sidebar.tabs.CombatTracker, "_prepareTurnContext", combatTurnContext, false]
  ];
  const lw = globalThis.libWrapper;
  for (const [path, cls, name, fn, getter] of list) {
    try {
      if (lw) lw.register(MODULE_ID, path, fn, "WRAPPER");
      else if (!patch(cls(), name, fn, getter)) {
        console.warn(`burn-cinema | безумие: не нашёл ${path} — эта подмена не работает`);
      }
    } catch (err) {
      console.error(`burn-cinema | безумие: обёртка ${path} не встала`, err);
    }
  }

  Hooks.on("renderChatMessageHTML", onRenderMessage);
  // Шапку с аватаром dnd5e строит уже после renderChatMessageHTML.
  Hooks.on("dnd5e.renderChatMessage", onRenderMessage);
  Hooks.on("renderCombatTracker", (_app, html) => {
    if (hasLooks() && html instanceof HTMLElement) swapNames(html);
  });
  // Токен переименовали, добавили или убрали — пересчитать замены.
  for (const hook of ["createToken", "updateToken", "deleteToken"]) {
    Hooks.on(hook, () => { swapCache = undefined; });
  }
}
