/**
 * 🔥 Осмотр предметов — квестовый осмотр предметов на карте.
 *
 * Зона осмотра — регион с поведением «burn-cinema.inspect». Игрок наводит
 * курсор на зону: курсор становится лупой, контур подсвечивается. По клику
 * над зоной появляется пергаментная плашка с текстом ГМа.
 *
 * Поток клика у игрока:
 *   клиент игрока: хит-тест по форме региона → дистанция → (бросок навыка) →
 *   сокет «inspect.request» → активный ГМ: итог, память зоны, отчёт ГМу →
 *   сокет «inspect.show» адресатам → плашка над зоной.
 * Без ГМа в игре плашка показывается локально и осмотр не запоминается.
 *
 * Формат данных для внешних инструментов (Картограф) — inspect/FORMAT.md.
 */

import {
  MODULE_ID, BEHAVIOR_TYPE, FLAG_SEEN, VISIBILITY, REPEAT, CHECK, OUTCOME, DEFAULTS,
  normalizeSystem, memoryKey, planInspection, resolveOutcome, textFor, targetsFor,
  distToPolygons, pxToUnits, inRange, placePlaque
} from "./logic.mjs";
import { openInspectManager } from "./manager.mjs";

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
        title: new fields.StringField({ required: true, blank: true, initial: DEFAULTS.title }),
        text: new fields.HTMLField({ required: true, blank: true, initial: DEFAULTS.text }),
        checkMode: new fields.StringField({ required: true, initial: DEFAULTS.checkMode, choices: choices(CHECK, "Check") }),
        skill: new fields.StringField({ required: true, initial: DEFAULTS.skill, choices: skillChoices }),
        dc: new fields.NumberField({ required: true, nullable: false, integer: true, min: 0, max: 40, initial: DEFAULTS.dc }),
        textFail: new fields.HTMLField({ required: true, blank: true, initial: DEFAULTS.textFail }),
        visibility: new fields.StringField({ required: true, initial: DEFAULTS.visibility, choices: choices(VISIBILITY, "Visibility") }),
        range: new fields.NumberField({ required: true, nullable: false, min: 0, initial: DEFAULTS.range }),
        repeat: new fields.StringField({ required: true, initial: DEFAULTS.repeat, choices: choices(REPEAT, "Repeat") }),
        gmNote: new fields.HTMLField({ required: true, blank: true, initial: DEFAULTS.gmNote }),
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

function keyFor(token) {
  return memoryKey({ actorId: token?.actor?.id, tokenId: token?.id, userId: game.user.id });
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

/** Зона под курсором. Вложенные зоны: побеждает меньшая. */
function hitTest(point) {
  let best = null;
  for (const z of listZones()) {
    if (!z.region.polygonTree?.testPoint?.(point)) continue;
    if (!game.user.isGM) {
      const tok = pickToken(point);
      const plan = planInspection(z.behavior.system, zoneSeen(z.behavior, keyFor(tok)));
      if (!plan.allowed) continue;
    }
    const area = z.region.area ?? Infinity;
    if (!best || area < best.area) best = { ...z, area };
  }
  if (!best) return null;
  if (!game.user.isGM && canvas.visibility?.tokenVision) {
    const vis = canvas.visibility.testVisibility?.(point, { tolerance: 2 });
    if (vis === false) return null;
  }
  return best;
}

/* ═════════════════════════════ Наведение ══════════════════════════════════ */

const ui_ = { hover: null, gfx: null, pulse: 0, ticker: null, label: null, down: null, plaque: null };

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

function setHover(hit) {
  const view = canvas.app?.view;
  const same = hit && ui_.hover && hit.behavior.id === ui_.hover.behavior.id;
  if (same) return;
  ui_.hover = hit;
  view?.classList.toggle("burn-inspect-cursor", !!hit);
  drawHighlight();
  drawHoverLabel();
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
  if (!z) return;
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
    userId: game.user.id,
    tokenId: token?.id ?? null,
    total
  };

  if (game.users.activeGM) {
    game.socket.emit(SOCKET, req);
    return;
  }
  // ГМа нет: показываем сами, без памяти.
  ui.notifications.warn(L("NoGM"));
  const res = resolveRequest(req, { local: true });
  if (res) displayShow(res.show);
}

/** Пакет для плашки у ГМа: все тексты сразу. */
function gmPreview({ region, behavior }) {
  const sys = normalizeSystem(behavior.system);
  const parts = [];
  if (sys.checkMode !== CHECK.NONE) {
    const how = sys.checkMode === CHECK.PASSIVE ? L("Passive") : L("Roll");
    parts.push({ cls: "bip-gm-check", html: `${skillLabel(sys.skill)} · ${how} · ${L("DC")} ${sys.dc}` });
    parts.push({ cls: "bip-gm-label", html: L("OnSuccess") });
    parts.push({ cls: "bip-text", html: sys.text });
    parts.push({ cls: "bip-gm-label", html: L("OnFail") });
    parts.push({ cls: "bip-text", html: sys.textFail || L("DefaultFail") });
  } else {
    parts.push({ cls: "bip-text", html: sys.text });
  }
  if (sys.gmNote.trim()) {
    parts.push({ cls: "bip-gm-label", html: L("GmOnly") });
    parts.push({ cls: "bip-gm-note", html: sys.gmNote });
  }
  return {
    sceneId: region.parent.id, regionId: region.id, behaviorId: behavior.id,
    title: sys.title, parts, gm: true, duration: 0, sound: ""
  };
}

/* ═══════════════════════════ Сторона ГМа ══════════════════════════════════ */

/**
 * Разбирает запрос игрока. Возвращает пакет показа, адресатов и обновление
 * памяти. local — разбор у самого игрока без ГМа (память не пишется).
 */
function resolveRequest(req, { local = false } = {}) {
  const behavior = fromUuidSync(req.behaviorUuid);
  if (!behavior || behavior.type !== BEHAVIOR_TYPE || behavior.disabled) return null;
  const region = behavior.parent;
  const scene = region?.parent;
  const sys = normalizeSystem(behavior.system);
  const user = game.users.get(req.userId);
  if (!user) return null;
  const tokenDoc = req.tokenId ? scene?.tokens.get(req.tokenId) : null;
  if (tokenDoc && !tokenDoc.testUserPermission(user, "OWNER")) return null;
  const actor = tokenDoc?.actor ?? user.character ?? null;

  const key = memoryKey({ actorId: actor?.id, tokenId: tokenDoc?.id, userId: user.id });
  const seen = zoneSeen(behavior, key);
  const plan = planInspection(sys, seen);
  if (!plan.allowed) return null;

  const passive = actor?.system?.skills?.[sys.skill]?.passive;
  const outcome = plan.reuse ?? resolveOutcome(sys, { total: req.total, passive });
  const html = textFor(sys, outcome, L("DefaultFail"));

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

  const memory = (!local && sys.repeat !== REPEAT.ALWAYS && !plan.reuse)
    ? { [`flags.${MODULE_ID}.${FLAG_SEEN}.${key}`]: { o: outcome, u: user.id, t: Date.now() } }
    : null;

  return { show, users, chat, memory, behavior, sys, user, tokenDoc, actor, outcome, req, plan };
}

async function handleRequest(req) {
  if (game.users.activeGM?.id !== game.user.id) return;
  const res = resolveRequest(req);
  if (!res) return;
  const { show, users, chat, memory, behavior, sys, user, tokenDoc, actor, outcome } = res;

  game.socket.emit(SOCKET, { type: "inspect.show", users, data: show });
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

  if (game.settings.get(MODULE_ID, "inspectGmReport")) {
    const lines = [
      `<div class="bic-title"><i class="fa-solid fa-magnifying-glass"></i> ${LF("ReportHead", { who: foundry.utils.escapeHTML(who), user: foundry.utils.escapeHTML(user.name), title: foundry.utils.escapeHTML(sys.title || L("Thing")) })}</div>`
    ];
    if (sys.checkMode !== CHECK.NONE) {
      const val = sys.checkMode === CHECK.PASSIVE ? actor?.system?.skills?.[sys.skill]?.passive : req.total;
      const res2 = outcome === OUTCOME.SUCCESS ? L("Success") : L("Failure");
      lines.push(`<div>${skillLabel(sys.skill)}: ${res.plan?.reuse ? L("Remembered") : (val ?? "—")} / ${L("DC")} ${sys.dc} — <b>${res2}</b></div>`);
    }
    if (sys.gmNote.trim()) lines.push(`<div class="bic-note">${await enrich(sys.gmNote)}</div>`);
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
    region.behaviors.get(data.behaviorId)?.sheet?.render(true);
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
  const a = region && anchorsFor(region);
  if (!a) return closePlaque();
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
    title: sys.title, parts: [{ cls: "bip-text", html: sys.text }],
    outcome: OUTCOME.PLAIN, sound: sys.sound, duration: sys.duration
  };
  const users = game.users.filter((u) => u.active && !u.isGM).map((u) => u.id);
  game.socket.emit(SOCKET, { type: "inspect.show", users, data: show });
  ui.notifications.info(LF("ShownAll", { title: sys.title || L("Thing") }));
}

/* ═════════════════════════════ Сокет и хуки ═══════════════════════════════ */

function onSocket(msg) {
  if (!msg?.type?.startsWith?.("inspect.")) return;
  if (msg.type === "inspect.request") return void handleRequest(msg).catch((e) => console.error(`${MODULE_ID} | осмотр (ГМ)`, e));
  if (msg.type === "inspect.show" && (msg.users ?? []).includes(game.user.id)) displayShow(msg.data);
}

/** Сбросить память осмотров зоны (или всех зон сцены). */
export async function resetInspectMemory(behavior) {
  if (!game.user.isGM) return;
  const list = behavior ? [behavior] : listZones().map((z) => z.behavior);
  for (const b of list) await b.update({ [`flags.${MODULE_ID}.-=${FLAG_SEEN}`]: null });
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

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  (game.burnCinema ??= {}).openInspect = () => openInspectManager();
  game.burnCinema.inspect = {
    listZones, resetInspectMemory, BEHAVIOR_TYPE, normalizeSystem,
    _debug: { hitTest, inspect, ui: ui_, showPlaque, closePlaque }
  };
  if (canvas?.ready) attachCanvas();
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
  ui_.hover = null;
});
for (const h of ["updateRegionBehavior", "deleteRegionBehavior", "deleteRegion", "updateRegion"]) {
  Hooks.on(h, () => {
    if (ui_.hover) setHover(null);
  });
}
