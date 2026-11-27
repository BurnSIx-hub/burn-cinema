/**
 * 🔥 Осмотр предметов — квестовый осмотр предметов на карте.
 *
 * Зона осмотра — регион с поведением «burn-cinema.inspect». Игрок наводит
 * курсор на зону: курсор становится лупой, контур подсвечивается. По клику
 * над зоной появляется пергаментная плашка с текстом ГМа.
 *
 * Тексты зоны (text, textFail, gmNote) в регионе НЕ лежат: они в файле
 * хранилища у ГМа (store.mjs), в регионе только system.textKey. Сервер
 * Foundry отдаёт игрокам весь мир без фильтра, поэтому тексты уходят
 * игроку только в момент осмотра и только адресату.
 *
 * Поток клика у игрока:
 *   клиент игрока: хит-тест по форме региона → дистанция → (бросок навыка) →
 *   сокет «inspect.request» только активному ГМу → ГМ (по id отправителя от
 *   сервера): дистанция, «один раз», итог, память, отчёт → сокет
 *   «inspect.show» с recipients только адресатам → плашка над зоной.
 * Без ГМа в игре осмотр невозможен: игрок видит объяснение.
 *
 * Формат данных для внешних инструментов (Картограф) — inspect/FORMAT.md.
 */

import {
  MODULE_ID, BEHAVIOR_TYPE, FLAG_SEEN, VISIBILITY, REPEAT, CHECK, OUTCOME, DEFAULTS,
  normalizeSystem, memoryKey, planInspection, resolveOutcome, textFor, targetsFor,
  distToPolygons, pxToUnits, inRange, placePlaque
} from "./logic.mjs";
import { openInspectManager } from "./manager.mjs";
import { loadStore, getSecret } from "./store.mjs";
import { openInspectEditor } from "./editor.mjs";
import { migrateLegacyTexts } from "./migrate.mjs";

const SOCKET = `module.${MODULE_ID}`;
const L = (k) => game.i18n.localize(`BURNINSPECT.${k}`);
const LF = (k, d) => game.i18n.format(`BURNINSPECT.${k}`, d);

/* ═════════════════════════ Тип поведения региона ═════════════════════════ */

function skillChoices() {
  const skills = globalThis.CONFIG?.DND5E?.skills;
  if (!skills) return { prc: "Perception", inv: "Investigation" };
  const out = {};
  for (const [k, v] of Object.entries(skills)) out[k] = game.i18n.localize(v.label ?? k);
  return out;
}

function skillLabel(key) {
  const v = globalThis.CONFIG?.DND5E?.skills?.[key];
  return v ? game.i18n.localize(v.label) : key;
}

function defineBehaviorType() {
  const { fields } = foundry.data;
  const choices = (en, prefix) => Object.fromEntries(Object.values(en).map((v) => [v, `BURNINSPECT.${prefix}.${v}`]));

  return class InspectBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
    static LOCALIZATION_PREFIXES = ["BURNINSPECT.Behavior"];

    static defineSchema() {
      return {
        textKey: new fields.StringField({ required: true, blank: true, initial: DEFAULTS.textKey }),
        title: new fields.StringField({ required: true, blank: true, initial: DEFAULTS.title }),
        checkMode: new fields.StringField({ required: true, initial: DEFAULTS.checkMode, choices: choices(CHECK, "Check") }),
        skill: new fields.StringField({ required: true, initial: DEFAULTS.skill, choices: skillChoices }),
        dc: new fields.NumberField({ required: true, nullable: false, integer: true, min: 0, max: 40, initial: DEFAULTS.dc }),
        visibility: new fields.StringField({ required: true, initial: DEFAULTS.visibility, choices: choices(VISIBILITY, "Visibility") }),
        range: new fields.NumberField({ required: true, nullable: false, min: 0, initial: DEFAULTS.range }),
        repeat: new fields.StringField({ required: true, initial: DEFAULTS.repeat, choices: choices(REPEAT, "Repeat") }),
        sound: new fields.FilePathField({ required: false, blank: true, categories: ["AUDIO"], initial: DEFAULTS.sound }),
        duration: new fields.NumberField({ required: true, nullable: false, min: 0, initial: DEFAULTS.duration })
      };
    }

    /** Осмотр не подписан на события региона: клик ловит canvas. */
    async _handleRegionEvent() {}
  };
}

/* ═════════════════════════════ Зоны на сцене ═════════════════════════════ */

function listZones(scene = canvas?.scene) {
  if (!scene) return [];
  const level = canvas?.level?.id;
  const out = [];
  for (const region of scene.regions) {
    if (level && typeof region.includedInLevel === "function" && !region.includedInLevel(level)) continue;
    for (const behavior of region.behaviors) {
      if (behavior.type !== BEHAVIOR_TYPE || behavior.disabled) continue;
      out.push({ region, behavior });
    }
  }
  return out;
}

function zoneSeen(behavior, key) {
  return behavior.getFlag(MODULE_ID, FLAG_SEEN)?.[key] ?? null;
}

/** Токен, которым игрок осматривает: выделенный, иначе свой персонаж, иначе ближайший свой. */
function pickToken(point) {
  const own = (t) => t.document.isOwner && t.actor;
  const controlled = canvas.tokens.controlled.filter(own);
  if (controlled.length) return controlled[0];
  const charTok = game.user.character?.getActiveTokens?.(false, false)?.find((t) => t.scene === canvas.scene || t.document?.parent === canvas.scene);
  if (charTok) return charTok;
  const mine = canvas.tokens.placeables.filter(own);
  if (!mine.length) return null;
  mine.sort((a, b) => Math.hypot(a.center.x - point.x, a.center.y - point.y) - Math.hypot(b.center.x - point.x, b.center.y - point.y));
  return mine[0];
}

/** Ключ памяти — как у ГМа в resolveRequest: актёр токена, иначе персонаж пользователя. */
function keyFor(token) {
  const actorId = token?.actor?.id ?? (token ? null : game.user.character?.id);
  return memoryKey({ actorId, tokenId: token?.id, userId: game.user.id });
}

function regionPolys(region) {
  return (region.polygons ?? []).map((p) => ({ points: p.points, isPositive: p.isPositive }));
}

function distanceUnits(region, point) {
  if (region.polygonTree?.testPoint?.(point)) return 0;
  const px = distToPolygons(point.x, point.y, regionPolys(region));
  const d = canvas.dimensions;
  return pxToUnits(px, d.size, d.distance);
}

/** Центр рамки региона — точка по умолчанию для внешних вызовов. */
function regionCenter(region) {
  const b = region.bounds;
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
}

/** Видит ли игрок точку (туман, зрение). ГМу — всегда. */
function pointVisible(point) {
  if (game.user.isGM || !point || !canvas.visibility?.tokenVision) return true;
  return canvas.visibility.testVisibility?.(point, { tolerance: 2 }) !== false;
}

/** Доступна ли зона этому пользователю сейчас: «один раз» уже не погасил её. */
function zoneOpen(zone, point) {
  if (game.user.isGM) return true;
  const tok = pickToken(point ?? regionCenter(zone.region));
  return planInspection(zone.behavior.system, zoneSeen(zone.behavior, keyFor(tok))).allowed;
}

/** Зона под точкой сцены. Этаж, «один раз», видимость; вложенные — побеждает меньшая. */
function hitTest(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  let best = null;
  for (const z of listZones()) {
    if (!z.region.polygonTree?.testPoint?.(point)) continue;
    if (!zoneOpen(z, point)) continue;
    const area = z.region.area ?? Infinity;
    if (!best || area < best.area) best = { ...z, area };
  }
  if (!best || !pointVisible(point)) return null;
  return best;
}

/**
 * Зона по региону или поведению (документ или объект холста) — для
 * внешних хит-тестов, например луча по модели в 3D. Те же правила, что у
 * hitTest, кроме формы: включена, на текущем этаже, не погашена «один раз»;
 * видимость проверяется, только если дана point.
 */
function zoneOf(target, { point = null } = {}) {
  const doc = target?.document ?? target;
  if (!doc) return null;
  let behavior = null;
  if (doc.documentName === "RegionBehavior") behavior = doc;
  else if (doc.documentName === "Region") behavior = doc.behaviors.find((b) => b.type === BEHAVIOR_TYPE && !b.disabled) ?? null;
  if (!behavior || behavior.type !== BEHAVIOR_TYPE || behavior.disabled) return null;
  const z = listZones().find((x) => x.behavior.id === behavior.id && x.region.id === behavior.parent?.id);
  if (!z || !zoneOpen(z, point)) return null;
  if (point && !pointVisible(point)) return null;
  return { ...z, area: z.region.area ?? Infinity };
}

/* ═════════════════════════════ Наведение ══════════════════════════════════ */

const ui_ = {
  hover: null, gfx: null, pulse: 0, ticker: null, label: null, down: null, plaque: null,
  hoverEl: null,   // элемент, на котором сейчас висит класс курсора-лупы
  anchorFn: null   // внешний расчёт якоря плашки (3D); null — по 2D-холсту
};

function overlayRoot() {
  let el = document.getElementById("burn-inspect-layer");
  if (!el) {
    el = document.createElement("div");
    el.id = "burn-inspect-layer";
    document.body.appendChild(el);
  }
  return el;
}

function eligible(ev) {
  if (!canvas?.ready || !canvas.scene) return false;
  if (canvas.activeLayer !== canvas.tokens) return false;
  if (ev && ev.buttons && ev.type === "pointermove") return false;
  if (canvas.tokens.hover) return false;
  return true;
}

function setHover(hit, element = canvas.app?.view) {
  const same = hit && ui_.hover && hit.behavior.id === ui_.hover.behavior.id && element === ui_.hoverEl;
  if (same || (!hit && !ui_.hover)) return;
  ui_.hoverEl?.classList.remove("burn-inspect-cursor");
  ui_.hover = hit;
  ui_.hoverEl = hit ? (element ?? null) : null;
  ui_.hoverEl?.classList.add("burn-inspect-cursor");
  drawHighlight();
  drawHoverLabel();
  Hooks.callAll("burnCinema.inspectHover", hit ?? null);
}

function ensureGfx() {
  if (ui_.gfx && !ui_.gfx.destroyed && ui_.gfx.parent) return ui_.gfx;
  const g = new PIXI.Graphics();
  g.eventMode = "none";
  g.zIndex = 1000;
  (canvas.interface ?? canvas.stage).addChild(g);
  ui_.gfx = g;
  return g;
}

function drawHighlight() {
  const g = ensureGfx();
  g.clear();
  const z = ui_.hover;
  // С внешним якорем (3D) 2D-подсветку не рисуем: её не видно, подсвечивает мост.
  if (!z || ui_.anchorFn) return;
  const a = 0.55 + 0.35 * Math.sin(ui_.pulse);
  const w = Math.max(2, 3 / (canvas.stage.scale.x || 1));
  for (const p of z.region.polygons ?? []) {
    // Мягкий ореол + чёткий контур.
    g.lineStyle({ width: w * 4, color: 0xf3c76b, alpha: a * 0.25, join: "round" });
    g.drawPolygon(p.points);
    g.lineStyle({ width: w, color: 0xffe2a0, alpha: a, join: "round" });
    g.beginFill(0xf3c76b, 0.08 * a);
    g.drawPolygon(p.points);
    g.endFill();
  }
}

function drawHoverLabel() {
  ui_.label?.remove();
  ui_.label = null;
  const z = ui_.hover;
  const title = z ? normalizeSystem(z.behavior.system).title : "";
  if (!title) return;
  const el = document.createElement("div");
  el.className = "burn-inspect-hoverlabel";
  el.textContent = title;
  el.hidden = ui_.plaque?.behaviorId === z.behavior.id;
  overlayRoot().appendChild(el);
  ui_.label = el;
  positionLabel();
}

function anchorsFor(region) {
  if (ui_.anchorFn) {
    try {
      const a = ui_.anchorFn(region);
      if (a?.top && a?.bottom && [a.top.x, a.top.y, a.bottom.x, a.bottom.y].every(Number.isFinite)) {
        // Предмет далеко за кадром (например, точка -10000 за камерой) — как null:
        // спрятать, а не прижимать плашку к краю экрана.
        const w = window.innerWidth, h = window.innerHeight;
        const far = (pt) => pt.x < -w / 2 || pt.x > w * 1.5 || pt.y < -h / 2 || pt.y > h * 1.5;
        return far(a.top) && far(a.bottom) ? null : a;
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | осмотр: внешний якорь упал`, e);
    }
    return null;
  }
  const b = region.bounds;
  if (!b) return null;
  const top = canvas.clientCoordinatesFromCanvas({ x: b.x + b.width / 2, y: b.y });
  const bottom = canvas.clientCoordinatesFromCanvas({ x: b.x + b.width / 2, y: b.y + b.height });
  return { top, bottom };
}

function positionLabel() {
  const el = ui_.label, z = ui_.hover;
  if (!el || !z) return;
  const a = anchorsFor(z.region);
  // Внешний якорь может временно не знать точку (предмет за кадром) — прячем подпись.
  el.style.visibility = a ? "" : "hidden";
  if (!a) return;
  el.style.left = `${a.top.x}px`;
  el.style.top = `${a.top.y - 8}px`;
}

function onTick() {
  if (ui_.hover) {
    ui_.pulse += 0.08;
    drawHighlight();
    positionLabel();
  }
  if (ui_.plaque) positionPlaque();
}

function onPointerMove(ev) {
  if (!eligible(ev)) return setHover(null);
  const p = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
  setHover(hitTest(p));
}

function onPointerDown(ev) {
  if (ev.button !== 0) return;
  ui_.down = { x: ev.clientX, y: ev.clientY, t: performance.now(), hit: ui_.hover };
  // Клик мимо плашки и мимо её зоны закрывает плашку.
  if (ui_.plaque && (!ui_.hover || ui_.hover.behavior.id !== ui_.plaque.behaviorId)) closePlaque();
}

function onPointerUp(ev) {
  const d = ui_.down;
  ui_.down = null;
  if (!d || ev.button !== 0 || !d.hit) return;
  if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6 || performance.now() - d.t > 700) return;
  if (!eligible()) return;
  const p = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
  const hit = hitTest(p);
  if (!hit || hit.behavior.id !== d.hit.behavior.id) return;
  inspect(hit, p, ev).catch((err) => {
    console.error(`${MODULE_ID} | осмотр упал`, err);
    ui.notifications.error(L("Error"));
  });
}

function attachCanvas() {
  const view = canvas.app?.view;
  if (!view || view._burnInspect) return;
  view._burnInspect = true;
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerdown", onPointerDown);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointerleave", () => setHover(null));
  ui_.ticker = onTick;
  canvas.app.ticker.add(onTick);
}

/* ═════════════════════════════ Осмотр ═════════════════════════════════════ */

async function inspect(zone, point, ev) {
  const { region, behavior } = zone;
  const sys = normalizeSystem(behavior.system);

  if (game.user.isGM) return showPlaque(gmPreview(zone));

  const token = pickToken(point);
  if (sys.range) {
    if (!token) return showNotice(zone, L("NeedToken"));
    const dist = distanceUnits(region, token.center);
    if (!inRange(sys, dist)) return showNotice(zone, L("TooFar"));
  }

  if (!game.users.activeGM) return showNotice(zone, L("NoGM"));

  const key = keyFor(token);
  const plan = planInspection(sys, zoneSeen(behavior, key));
  if (!plan.allowed) return;

  let total = null;
  if (plan.needRoll) {
    const actor = token?.actor ?? game.user.character;
    if (!actor?.rollSkill) return showNotice(zone, L("NeedToken"));
    const rolls = await actor.rollSkill(
      { skill: sys.skill, event: ev },
      {},
      { data: { flavor: LF("RollFlavor", { skill: skillLabel(sys.skill), title: sys.title || L("Thing") }) } }
    );
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (!roll) return; // игрок закрыл окно броска
    total = roll.total;
  }

  const req = {
    type: "inspect.request",
    behaviorUuid: behavior.uuid,
    tokenId: token?.id ?? null,
    total
  };

  // ГМа могло не стать, пока игрок кидал кость.
  const gm = game.users.activeGM;
  if (!gm) return showNotice(zone, L("NoGM"));
  game.socket.emit(SOCKET, req, { recipients: [gm.id] });
}

/** Пакет для плашки у ГМа: все тексты сразу. */
function gmPreview({ region, behavior }) {
  const sys = normalizeSystem(behavior.system);
  const sec = getSecret(sys.textKey);
  const parts = [];
  if (sys.checkMode !== CHECK.NONE) {
    const how = sys.checkMode === CHECK.PASSIVE ? L("Passive") : L("Roll");
    parts.push({ cls: "bip-gm-check", html: `${skillLabel(sys.skill)} · ${how} · ${L("DC")} ${sys.dc}` });
    parts.push({ cls: "bip-gm-label", html: L("OnSuccess") });
    parts.push({ cls: "bip-text", html: sec.text || `<em>${L("EmptyText")}</em>` });
    parts.push({ cls: "bip-gm-label", html: L("OnFail") });
    parts.push({ cls: "bip-text", html: sec.textFail || L("DefaultFail") });
  } else {
    parts.push({ cls: "bip-text", html: sec.text || `<em>${L("EmptyText")}</em>` });
  }
  if (sec.gmNote.trim()) {
    parts.push({ cls: "bip-gm-label", html: L("GmOnly") });
    parts.push({ cls: "bip-gm-note", html: sec.gmNote });
  }
  return {
    sceneId: region.parent.id, regionId: region.id, behaviorId: behavior.id,
    title: sys.title, parts, gm: true, duration: 0, sound: ""
  };
}

/* ═══════════════════════════ Сторона ГМа ══════════════════════════════════ */

/**
 * Разбирает запрос игрока на клиенте ГМа. Отправителя называет сервер
 * (третий аргумент сокета), полю из пакета не верим. Дистанцию и «один раз»
 * ГМ проверяет сам. Возвращает пакет показа, адресатов и обновление памяти.
 */
function resolveRequest(req, senderId) {
  const behavior = typeof req?.behaviorUuid === "string" ? fromUuidSync(req.behaviorUuid) : null;
  if (!behavior || behavior.type !== BEHAVIOR_TYPE || behavior.disabled) return null;
  const region = behavior.parent;
  const scene = region?.parent;
  const sys = normalizeSystem(behavior.system);
  const user = game.users.get(senderId);
  if (!user || user.isGM) return null;
  const tokenDoc = req.tokenId ? scene?.tokens.get(req.tokenId) : null;
  if (req.tokenId && !tokenDoc) return null;
  if (tokenDoc && !tokenDoc.testUserPermission(user, "OWNER")) return null;
  const actor = tokenDoc?.actor ?? user.character ?? null;

  if (sys.range) {
    if (!tokenDoc) return { deny: "NeedToken", user, scene, region, behavior };
    const c = tokenDoc.object?.center ?? {
      x: tokenDoc.x + (tokenDoc.width * scene.grid.size) / 2,
      y: tokenDoc.y + (tokenDoc.height * scene.grid.size) / 2
    };
    const px = region.polygonTree?.testPoint?.(c) ? 0 : distToPolygons(c.x, c.y, regionPolys(region));
    if (!inRange(sys, pxToUnits(px, scene.grid.size, scene.grid.distance))) {
      return { deny: "TooFar", user, scene, region, behavior };
    }
  }

  const key = memoryKey({ actorId: actor?.id, tokenId: tokenDoc?.id, userId: user.id });
  const seen = zoneSeen(behavior, key);
  const plan = planInspection(sys, seen);
  if (!plan.allowed) return null;

  const passive = actor?.system?.skills?.[sys.skill]?.passive;
  const total = Number.isFinite(Number(req.total)) ? Number(req.total) : null;
  const outcome = plan.reuse ?? resolveOutcome(sys, { total, passive });
  const secret = getSecret(sys.textKey);
  const html = textFor(secret, outcome, L("DefaultFail"));

  let checkLine = "";
  if (sys.checkMode !== CHECK.NONE) {
    checkLine = `${skillLabel(sys.skill)} · ${outcome === OUTCOME.SUCCESS ? L("Success") : L("Failure")}`;
  }

  const active = game.users.filter((u) => u.active && !u.isGM).map((u) => u.id);
  const { users, chat } = targetsFor(sys, user.id, active);

  const show = {
    sceneId: scene.id, regionId: region.id, behaviorId: behavior.id,
    title: sys.title,
    parts: [{ cls: "bip-text", html }],
    foot: checkLine,
    outcome, sound: sys.sound, duration: sys.duration
  };

  const memory = (sys.repeat !== REPEAT.ALWAYS && !plan.reuse)
    ? { [`flags.${MODULE_ID}.${FLAG_SEEN}.${key}`]: { o: outcome, u: user.id, t: Date.now() } }
    : null;

  return { show, users, chat, memory, behavior, sys, secret, user, tokenDoc, actor, outcome, req, total, plan };
}

async function handleRequest(req, senderId) {
  if (game.users.activeGM?.id !== game.user.id) return;
  await loadStore();
  const res = resolveRequest(req, senderId);
  if (!res) return;
  if (res.deny) {
    // Отказ — только объяснение, без текста зоны.
    const notice = {
      sceneId: res.scene.id, regionId: res.region.id, behaviorId: res.behavior.id,
      title: "", parts: [{ cls: "bip-notice", html: res.deny }], duration: 3, notice: true, i18n: true
    };
    game.socket.emit(SOCKET, { type: "inspect.show", data: notice }, { recipients: [res.user.id] });
    return;
  }
  const { show, users, chat, memory, behavior, sys, secret, user, tokenDoc, actor, outcome } = res;

  // Текст уходит только адресатам: сервер шлёт пакет лишь их сокетам.
  const others = users.filter((id) => id !== game.user.id);
  if (others.length) game.socket.emit(SOCKET, { type: "inspect.show", data: show }, { recipients: others });
  if (users.includes(game.user.id)) displayShow(show);

  if (memory) await behavior.update(memory);

  const who = tokenDoc?.name ?? actor?.name ?? user.name;
  if (chat) {
    const body = await enrich(show.parts[0].html);
    await ChatMessage.create({
      speaker: tokenDoc ? ChatMessage.getSpeaker({ token: tokenDoc }) : { alias: who },
      content: `<div class="burn-inspect-chat"><div class="bic-title"><i class="fa-solid fa-magnifying-glass"></i> ${foundry.utils.escapeHTML(sys.title || L("Thing"))}</div>${body}${show.foot ? `<div class="bic-foot">${show.foot}</div>` : ""}</div>`
    });
  }

  // Заметка ГМа — только локально у ГМа: шёпот в чате хранится в мире и
  // уходит всем клиентам, прячет его лишь интерфейс.
  if (secret.gmNote.trim()) showGmNote(who, sys, secret.gmNote);

  if (game.settings.get(MODULE_ID, "inspectGmReport")) {
    const lines = [
      `<div class="bic-title"><i class="fa-solid fa-magnifying-glass"></i> ${LF("ReportHead", { who: foundry.utils.escapeHTML(who), user: foundry.utils.escapeHTML(user.name), title: foundry.utils.escapeHTML(sys.title || L("Thing")) })}</div>`
    ];
    if (sys.checkMode !== CHECK.NONE) {
      const val = sys.checkMode === CHECK.PASSIVE ? actor?.system?.skills?.[sys.skill]?.passive : res.total;
      const res2 = outcome === OUTCOME.SUCCESS ? L("Success") : L("Failure");
      lines.push(`<div>${skillLabel(sys.skill)}: ${res.plan?.reuse ? L("Remembered") : (val ?? "—")} / ${L("DC")} ${sys.dc} — <b>${res2}</b></div>`);
    }
    await ChatMessage.create({
      whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
      speaker: { alias: "🔥 Осмотр" },
      content: `<div class="burn-inspect-chat gm">${lines.join("")}</div>`
    });
  }
}

/* ═════════════════════════════ Плашка ═════════════════════════════════════ */

async function enrich(html) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  try {
    return await TE.enrichHTML(html ?? "", { secrets: game.user.isGM });
  } catch {
    return html ?? "";
  }
}

function displayShow(data) {
  if (!canvas?.scene || canvas.scene.id !== data.sceneId) return;
  if (data.i18n) {
    data = { ...data, parts: (data.parts ?? []).map((p) => ({ ...p, html: foundry.utils.escapeHTML(L(String(p.html))) })) };
  }
  showPlaque(data);
  if (data.sound) {
    const AH = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    AH?.play({ src: data.sound, volume: 0.8, autoplay: true, loop: false }, false);
  }
}

function closePlaque() {
  const p = ui_.plaque;
  if (!p) return;
  ui_.plaque = null;
  clearTimeout(p.timer);
  if (ui_.label) ui_.label.hidden = false;
  p.el.classList.add("closing");
  setTimeout(() => p.el.remove(), 220);
}

function showNotice(zone, text) {
  return showPlaque({
    sceneId: zone.region.parent.id, regionId: zone.region.id, behaviorId: zone.behavior.id,
    title: "", parts: [{ cls: "bip-notice", html: foundry.utils.escapeHTML(text) }], duration: 3, notice: true
  });
}

async function showPlaque(data) {
  closePlaque();
  const region = canvas.scene?.regions.get(data.regionId);
  if (!region) return;

  const el = document.createElement("div");
  el.className = "burn-inspect-plaque";
  if (data.outcome === OUTCOME.FAIL) el.classList.add("fail");
  if (data.gm) el.classList.add("gm");
  if (data.notice) el.classList.add("notice");

  const body = [];
  if (data.title) body.push(`<div class="bip-title">${foundry.utils.escapeHTML(data.title)}</div>`);
  for (const part of data.parts ?? []) {
    const raw = part.cls === "bip-notice" || part.cls === "bip-gm-check" || part.cls === "bip-gm-label";
    const html = raw ? part.html : await enrich(part.html);
    body.push(`<div class="${part.cls}">${html}</div>`);
  }
  if (data.foot) body.push(`<div class="bip-foot">${foundry.utils.escapeHTML(data.foot)}</div>`);
  if (data.gm) {
    body.push(`<div class="bip-gm-actions">
      <button type="button" data-act="all"><i class="fa-solid fa-users"></i> ${L("ShowAll")}</button>
      <button type="button" data-act="edit"><i class="fa-solid fa-pen"></i> ${L("Edit")}</button>
    </div>`);
  }
  el.innerHTML = `<button type="button" class="bip-close" aria-label="${L("Close")}">×</button>
    <div class="bip-body">${body.join("")}</div><div class="bip-tail"></div>`;

  el.querySelector(".bip-close").addEventListener("click", closePlaque);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.querySelector('[data-act="all"]')?.addEventListener("click", () => gmShowAll(data));
  el.querySelector('[data-act="edit"]')?.addEventListener("click", () => {
    const b = region.behaviors.get(data.behaviorId);
    if (b) openInspectEditor(b);
  });

  overlayRoot().appendChild(el);
  ui_.plaque = { el, regionId: data.regionId, behaviorId: data.behaviorId, timer: null };
  positionPlaque();
  void el.offsetWidth; // принудительная раскладка: переход сработает и без rAF
  el.classList.add("open");
  if (ui_.label && ui_.hover?.behavior.id === data.behaviorId) ui_.label.hidden = true;
  if (data.duration > 0) ui_.plaque.timer = setTimeout(closePlaque, data.duration * 1000);
}

function positionPlaque() {
  const p = ui_.plaque;
  if (!p) return;
  const region = canvas.scene?.regions.get(p.regionId);
  if (!region) return closePlaque();
  const a = anchorsFor(region);
  // В 2D якорь есть всегда; null бывает у внешнего якоря — плашку прячем, а не закрываем.
  p.el.style.visibility = a ? "" : "hidden";
  if (!a) return ui_.anchorFn ? undefined : closePlaque();
  const r = p.el.getBoundingClientRect();
  const { left, top, below } = placePlaque({
    anchorTop: a.top, anchorBottom: a.bottom,
    viewW: window.innerWidth, viewH: window.innerHeight, w: r.width, h: r.height
  });
  p.el.style.left = `${left}px`;
  p.el.style.top = `${top}px`;
  p.el.classList.toggle("below", below);
  const tailX = Math.max(18, Math.min(r.width - 18, a.top.x - left));
  p.el.style.setProperty("--tail-x", `${tailX}px`);
}

/** ГМ показывает текст зоны всем игрокам (как успех/обычный текст). */
function gmShowAll(preview) {
  const region = canvas.scene?.regions.get(preview.regionId);
  const behavior = region?.behaviors.get(preview.behaviorId);
  if (!behavior) return;
  const sys = normalizeSystem(behavior.system);
  const show = {
    sceneId: preview.sceneId, regionId: preview.regionId, behaviorId: preview.behaviorId,
    title: sys.title, parts: [{ cls: "bip-text", html: getSecret(sys.textKey).text }],
    outcome: OUTCOME.PLAIN, sound: sys.sound, duration: sys.duration
  };
  const users = game.users.filter((u) => u.active && !u.isGM).map((u) => u.id);
  if (users.length) game.socket.emit(SOCKET, { type: "inspect.show", data: show }, { recipients: users });
  ui.notifications.info(LF("ShownAll", { title: sys.title || L("Thing") }));
}

/** Заметка ГМа при осмотре — карточка только на экране ГМа, в мир не пишется. */
async function showGmNote(who, sys, note) {
  const root = overlayRoot();
  const el = document.createElement("div");
  el.className = "burn-inspect-gmnote";
  el.innerHTML = `<button type="button" class="bip-close" aria-label="${L("Close")}">×</button>
    <div class="bign-head"><i class="fa-solid fa-user-secret"></i> ${foundry.utils.escapeHTML(LF("NoteHead", { who, title: sys.title || L("Thing") }))}</div>
    <div class="bign-body">${await enrich(note)}</div>`;
  el.querySelector(".bip-close").addEventListener("click", () => el.remove());
  root.appendChild(el);
  setTimeout(() => el.remove(), 30000);
}

/* ═════════════════════════════ Сокет и хуки ═══════════════════════════════ */

/**
 * Сокет модуля. Третий аргумент — id отправителя, его подставляет сервер
 * (handleCustomSocket в dist/server/sockets.mjs), подделать его клиент не может.
 * Пакеты с recipients сервер шлёт только сокетам адресатов.
 */
function onSocket(msg, senderId) {
  if (!msg?.type?.startsWith?.("inspect.")) return;
  if (msg.type === "inspect.request") {
    if (!game.user.isGM) return;
    return void handleRequest(msg, senderId).catch((e) => console.error(`${MODULE_ID} | осмотр (ГМ)`, e));
  }
  if (msg.type === "inspect.show") {
    const from = game.users.get(senderId);
    if (!from?.isGM) return; // показ присылает только ГМ
    return displayShow(msg.data);
  }
  if (msg.type === "inspect.storeChanged" && game.user.isGM) {
    return void loadStore({ force: true }).catch((e) => console.error(`${MODULE_ID} | осмотр: хранилище`, e));
  }
}

/**
 * Открытый API для внешних холстов (мост 3D Canvas из burn-kartograf).
 * Описан в inspect/API.md. Версия интерфейса — apiVersion.
 */
function publicApi() {
  const asZone = (z) => (z?.region && z?.behavior ? z : null);
  return {
    /** Зона под точкой сцены {x, y} или null (правила hitTest). */
    zoneAt: (point) => hitTest(point),
    /** Зона по региону/поведению или null (включена, этаж, «один раз», видимость при point). */
    zoneOf: (target, opts) => zoneOf(target, opts),
    /** То же, что щелчок: предпросмотр ГМа или дальность, бросок, запрос ГМу. */
    inspectZone: async (zone, { point = null, event = null } = {}) => {
      const z = asZone(zone) ? zoneOf(zone.behavior, { point }) : null;
      if (!z) return false;
      await inspect(z, point ?? regionCenter(z.region), event ?? new PointerEvent("pointerup"));
      return true;
    },
    /** Задать зону под курсором снаружи; класс лупы вешается на element. */
    hover: (zone, { element = null } = {}) => setHover(asZone(zone), element),
    /** fn(region) → {top:{x,y}, bottom:{x,y}} в пикселях экрана; null — снова 2D. */
    setAnchor: (fn) => {
      ui_.anchorFn = typeof fn === "function" ? fn : null;
      drawHighlight();
      positionLabel();
      if (ui_.plaque) positionPlaque();
    },
    /** Пересчитать подпись и плашку сейчас (звать каждый кадр внешнего холста). */
    reposition: () => {
      positionLabel();
      if (ui_.plaque) positionPlaque();
    },
    closePlaque: () => closePlaque()
  };
}

/** Сбросить память осмотров зоны (или всех зон сцены). */
export async function resetInspectMemory(behavior) {
  if (!game.user.isGM) return;
  const list = behavior ? [behavior] : listZones().map((z) => z.behavior);
  const del = foundry.data.operators.ForcedDeletion.create();
  for (const b of list) await b.update({ [`flags.${MODULE_ID}.${FLAG_SEEN}`]: del });
}

Hooks.once("init", () => {
  const Type = defineBehaviorType();
  CONFIG.RegionBehavior.dataModels[BEHAVIOR_TYPE] = Type;
  CONFIG.RegionBehavior.typeIcons[BEHAVIOR_TYPE] = "fa-solid fa-magnifying-glass";

  game.settings.register(MODULE_ID, "inspectGmReport", {
    name: "BURNINSPECT.Settings.GmReport.Name",
    hint: "BURNINSPECT.Settings.GmReport.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
});

Hooks.once("ready", async () => {
  game.socket.on(SOCKET, onSocket);
  (game.burnCinema ??= {}).openInspect = () => openInspectManager();
  game.burnCinema.inspect = {
    apiVersion: 1,
    version: game.modules.get(MODULE_ID)?.version ?? null,
    listZones, resetInspectMemory, BEHAVIOR_TYPE, normalizeSystem, openEditor: openInspectEditor,
    ...publicApi(),
    _debug: { hitTest, inspect, ui: ui_, showPlaque, closePlaque }
  };
  if (canvas?.ready) attachCanvas();
  if (!game.user.isGM) return;
  try {
    await loadStore();
    // Перевод зон 1.3.0 делает один ГМ.
    if (game.users.activeGM?.id === game.user.id) await migrateLegacyTexts();
  } catch (e) {
    console.error(`${MODULE_ID} | осмотр: хранилище текстов`, e);
    ui.notifications.error(L("StoreError"));
  }
});

/* В штатном окне поведения: ключ текстов спрятан, вместо текстов — кнопка
 * редактора (тексты живут не в регионе). */
Hooks.on("renderRegionBehaviorConfig", (app, element) => {
  const doc = app.document;
  if (doc?.type !== BEHAVIOR_TYPE || !game.user.isGM) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root || root.querySelector(".burn-inspect-open-editor")) return;
  root.querySelector('[name="system.textKey"]')?.closest(".form-group")?.remove();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "burn-inspect-open-editor";
  btn.innerHTML = `<i class="fa-solid fa-feather"></i> ${L("Editor.Open")}`;
  btn.addEventListener("click", () => { openInspectEditor(doc); app.close(); });
  const where = root.querySelector('[name="system.title"]')?.closest("fieldset") ?? root.querySelector(".window-content") ?? root;
  where.prepend(btn);
});

Hooks.on("canvasReady", () => {
  attachCanvas();
  ui_.hover = null;
  ui_.gfx = null;
  ensureGfx();
});
Hooks.on("canvasTearDown", () => {
  closePlaque();
  ui_.label?.remove();
  ui_.label = null;
  ui_.hoverEl?.classList.remove("burn-inspect-cursor");
  ui_.hoverEl = null;
  if (ui_.hover) {
    ui_.hover = null;
    Hooks.callAll("burnCinema.inspectHover", null);
  }
});
for (const h of ["updateRegionBehavior", "deleteRegionBehavior", "deleteRegion", "updateRegion"]) {
  Hooks.on(h, () => {
    if (ui_.hover) setHover(null);
  });
}
