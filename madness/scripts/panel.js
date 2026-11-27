/**
 * ПАНЕЛЬ ГМ — «Восприятие безумия» (ApplicationV2 + Handlebars).
 *
 * Сверху — игроки фишками: на фишке видно, у кого что-то держится и кто
 * нажал стоп. Ниже две вкладки:
 *   • «Игра» — что видит цель, сила фона, карточки видений текущей сцены
 *     (вспышка, держать, в фон) и своя музыка;
 *   • «Мастерская» — редактор видения по шагам и список всех видений.
 * Объекты для облика, призрака и пропажи берутся из выделенного на сцене —
 * ГМ ставит и двигает их штатными инструментами Foundry. Выделенное
 * показывается в редакторе сразу, без перерисовки панели.
 *
 * Недописанное в форме хранится в #draft и переживает перерисовку панели
 * (перерисовка приходит от любой записи настроек).
 */

import {
  MODULE_ID, SETTING_LAST_TARGET, SETTING_TARGETS, KINDS, KIND_ICONS, FLASH_SECONDS,
  defaultTarget, newVision, appliesToScene, normalizeLook, isPlainLook, RING_MODES
} from "./constants.js";
import {
  getDeck, getVision, saveVision, deleteVision,
  getAllTargets, getTarget, updateTarget, isTargetActive,
  isStopped, clearStop,
  getPresets, addPreset, removePreset,
  getMusicPresets, addMusicPreset, removeMusicPreset
} from "./state.js";
import { dispatch } from "./net.js";
import { currentLazyMusicTrack, parseTrackInput } from "./music.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Последняя телеметрия от целей: userId -> payload. */
export const statusCache = new Map();

const L = (k) => game.i18n.localize(`burncinema.Madness.${k}`);
const F = (k, data) => game.i18n.format(`burncinema.Madness.${k}`, data);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const VIDEO_RE = /\.(webm|mp4|m4v|ogv)$/i;

function basename(p) {
  return String(p ?? "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
}

function openFilePicker(type, current, onPick) {
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  new FP({ type, current: current || "", callback: onPick }).render(true);
}

function emptyDraft(prev = {}) {
  return {
    editingId: null,
    kind: prev.kind ?? "appearance",
    name: "",
    img: "",
    label: "",
    byActor: false,
    ...lookDraft(),
    autoHide: true,
    hue: 0,
    saturation: 1,
    brightness: 1,
    soundSrc: "",
    soundVolume: 0.8,
    // Не относятся к видению — переживают создание:
    flashSec: prev.flashSec ?? FLASH_SECONDS,
    musicSrc: prev.musicSrc ?? ""
  };
}

/** Поля черновика для настроек облика (из сохранённого облика или нейтральные). */
function lookDraft(look) {
  const k = normalizeLook(look);
  return {
    lookScale: k.scale,
    lookMirrorX: k.mirrorX,
    lookMirrorY: k.mirrorY,
    lookRing: k.ring,
    lookRingColorOn: !!k.ringColor,
    lookRingColor: k.ringColor || "#ffffff",
    lookRingBgOn: !!k.ringBg,
    lookRingBg: k.ringBg || "#000000",
    lookTint: k.tint || "#ffffff",
    lookAlpha: k.alpha
  };
}

/** Настройки облика из черновика. */
function lookFromDraft(d) {
  return normalizeLook({
    scale: d.lookScale,
    mirrorX: d.lookMirrorX,
    mirrorY: d.lookMirrorY,
    ring: d.lookRing,
    ringColor: d.lookRingColorOn ? d.lookRingColor : "",
    ringBg: d.lookRingBgOn ? d.lookRingBg : "",
    tint: d.lookTint,
    alpha: d.lookAlpha
  });
}

/** Коротко о настройках облика — для карточки и свёрнутой тонкой настройки. */
function lookSummary(look) {
  const k = normalizeLook(look);
  const parts = [];
  if (k.scale !== 1) parts.push(`×${k.scale}`);
  if (k.mirrorX) parts.push("↔");
  if (k.mirrorY) parts.push("↕");
  if (k.ring === "off") parts.push(L("LookNoRing"));
  if (k.ring === "on") parts.push(L("LookWithRing"));
  if (k.ringColor || k.ringBg) parts.push(L("LookRingColors"));
  if (k.tint) parts.push(L("LookTinted"));
  if (k.alpha !== 1) parts.push(`${Math.round(k.alpha * 100)}%`);
  return parts.join(", ");
}

/** Имя объекта сцены по id (сцена может быть не текущей). */
function objectName(sceneId, collection, id) {
  const scene = game.scenes.get(sceneId);
  const doc = scene?.[collection]?.get(id);
  if (!doc) return null;
  if (collection === "tokens") return doc.name;
  return basename(doc.texture?.src) || `Tile ${id}`;
}

function selection() {
  return {
    tokens: canvas.tokens?.controlled ?? [],
    tiles: canvas.tiles?.controlled ?? []
  };
}

/** Цвет пользователя для фишки. */
function userColor(u) {
  const c = u.color;
  return c?.css ?? (c ? String(c) : "#666666");
}

export class MadnessPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  #userId = null;
  #draft = emptyDraft();
  #allScenes = false;
  #tab = "play";
  #fineOpen = false;
  #musicOpen = false;

  static DEFAULT_OPTIONS = {
    id: "burn-cinema-madness",
    classes: ["burn-madness"],
    window: { title: "burncinema.Madness.Title", icon: "fa-solid fa-brain", resizable: true },
    position: { width: 660, height: "auto" },
    actions: {
      pickTarget: MadnessPanel.#onPickTarget,
      setTab: MadnessPanel.#onSetTab,
      setIntensity: MadnessPanel.#onSetIntensity,
      resume: MadnessPanel.#onResume,
      clearTarget: MadnessPanel.#onClearTarget,
      stopAll: MadnessPanel.#onStopAll,
      flash: MadnessPanel.#onFlash,
      toggleHeld: MadnessPanel.#onToggleHeld,
      toggleAmbient: MadnessPanel.#onToggleAmbient,
      editVision: MadnessPanel.#onEditVision,
      deleteVision: MadnessPanel.#onDeleteVision,
      setKind: MadnessPanel.#onSetKind,
      toggleFine: MadnessPanel.#onToggleFine,
      pickImg: MadnessPanel.#onPickImg,
      savePreset: MadnessPanel.#onSavePreset,
      usePreset: MadnessPanel.#onUsePreset,
      removePreset: MadnessPanel.#onRemovePreset,
      pickSound: MadnessPanel.#onPickSound,
      submitVision: MadnessPanel.#onSubmitVision,
      submitAndHold: MadnessPanel.#onSubmitAndHold,
      cancelEdit: MadnessPanel.#onCancelEdit,
      toggleMusic: MadnessPanel.#onToggleMusic,
      musicPick: MadnessPanel.#onMusicPick,
      musicFromLM: MadnessPanel.#onMusicFromLM,
      musicSavePreset: MadnessPanel.#onMusicSavePreset,
      musicUsePreset: MadnessPanel.#onMusicUsePreset,
      musicRemovePreset: MadnessPanel.#onMusicRemovePreset,
      musicStart: MadnessPanel.#onMusicStart,
      musicStop: MadnessPanel.#onMusicStop
    }
  };

  static PARTS = {
    main: { template: "modules/burn-cinema/madness/templates/madness-panel.hbs", scrollable: [""] }
  };

  static open() {
    this.#instance ??= new MadnessPanel();
    this.#instance.render({ force: true });
    dispatch("ping", null); // пусть цели пришлют свежий статус
    return this.#instance;
  }

  static refresh() {
    if (this.#instance?.rendered) this.#instance.render();
  }

  /** Обновить только строку статуса — без перерисовки всей панели. */
  static updateStatus() {
    if (this.#instance?.rendered) this.#instance.#paintStatus();
  }

  /** Обновить выделенное на сцене в редакторе. */
  static updateSelection() {
    if (this.#instance?.rendered) this.#instance.#paintSelection();
  }

  /* ----------------------------- Слушатели -------------------------------- */

  /** Один раз на корень окна: он переживает перерисовки, части — нет. */
  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    const root = this.element;

    root.addEventListener("input", (ev) => {
      const el = ev.target;
      if (!el?.dataset?.draft) return;
      this.#readDraftField(el);
      if (el.type === "range") {
        const out = el.parentElement?.querySelector("output");
        if (out) out.textContent = el.value;
      }
      if (["hue", "saturation", "brightness"].includes(el.dataset.draft)) this.#paintSwatch();
    });

    root.addEventListener("change", async (ev) => {
      const el = ev.target;
      if (el?.dataset?.draft) this.#readDraftField(el);
      switch (el?.name) {
        case "allScenes":
          this.#allScenes = el.checked;
          this.render();
          return;
        case "byActor":
          this.#draft.byActor = el.value === "1";
          return;
      }
      // Цвета кольца не нужны, когда кольцо снимаем.
      if (el?.dataset?.draft === "lookRing") this.render();
    });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#paintStatus();
    this.#paintSelection();
    this.#paintSwatch();
  }

  #readDraftField(el) {
    const key = el.dataset.draft;
    if (el.type === "checkbox") this.#draft[key] = el.checked;
    else if (el.type === "number" || el.type === "range") {
      const v = parseFloat(el.value);
      this.#draft[key] = Number.isFinite(v) ? v : this.#draft[key];
    } else this.#draft[key] = el.value;
  }

  /* ------------------------------ Контекст -------------------------------- */

  #players() {
    // ГМ тоже в списке — чтобы проверить видения на себе.
    return [...game.users.contents].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  }

  #currentUserId() {
    if (this.#userId && game.users.get(this.#userId)) return this.#userId;
    const saved = game.settings.get(MODULE_ID, SETTING_LAST_TARGET);
    if (saved && game.users.get(saved)) return (this.#userId = saved);
    const first = this.#players().find((u) => u.active && !u.isGM) ?? this.#players()[0];
    return (this.#userId = first?.id ?? null);
  }

  /** Объекты видения словами: «Жрец, Гоблин и ещё 2» или «все токены: …». */
  #objectsText(v) {
    if (v.kind === "appearance" && v.actors?.length) {
      return F("AllTokensOf", { names: v.actors.map((id) => game.actors.get(id)?.name ?? "?").join(", ") });
    }
    const all = [
      ...(v.tokens ?? []).map((id) => objectName(v.sceneId, "tokens", id) ?? "?"),
      ...(v.tiles ?? []).map((id) => objectName(v.sceneId, "tiles", id) ?? "?")
    ];
    if (!all.length) return L("NoObjects");
    const shown = all.slice(0, 3).join(", ");
    return all.length > 3 ? `${shown} ${F("AndMore", { n: all.length - 3 })}` : shown;
  }

  #describe(v) {
    switch (v.kind) {
      case "appearance": {
        const who = this.#objectsText(v);
        const extra = lookSummary(v.look);
        const base = v.label ? `${who} → «${v.label}»` : who;
        return extra ? `${base} · ${extra}` : base;
      }
      case "phantom":
      case "vanish":
        return this.#objectsText(v);
      case "tint":
        return F("TintDesc", { hue: v.tint?.hue ?? 0, sat: v.tint?.saturation ?? 1, bri: v.tint?.brightness ?? 1 });
      case "sound":
        return basename(v.sound?.src) || "—";
    }
    return "";
  }

  #autoName(v) {
    const d = this.#describe(v);
    switch (v.kind) {
      case "appearance": return v.label || basename(v.img) || d;
      case "phantom": return F("AutoPhantom", { what: d });
      case "vanish": return F("AutoVanish", { what: d });
      case "tint": return F("AutoTint", { hue: v.tint?.hue ?? 0 });
      case "sound": return d;
    }
    return L("Vision");
  }

  async _prepareContext() {
    const userId = this.#currentUserId();
    const user = userId ? game.users.get(userId) : null;
    const target = userId ? getTarget(userId) : null;
    const sceneId = canvas.scene?.id ?? null;
    const deck = getDeck();
    const held = new Set(target?.held ?? []);
    const ambient = new Set(target?.ambient ?? []);
    const d = this.#draft;

    const here = deck.filter((v) => appliesToScene(v, sceneId));
    const shownDeck = this.#allScenes ? deck : here;
    const card = (v) => ({
      id: v.id,
      name: v.name || this.#autoName(v),
      kind: v.kind,
      icon: KIND_ICONS[v.kind] ?? "fa-question",
      kindLabel: L(`Kind.${v.kind}`),
      desc: this.#describe(v),
      img: v.kind === "appearance" && v.img && !VIDEO_RE.test(v.img) ? v.img : null,
      held: held.has(v.id),
      ambient: ambient.has(v.id),
      elsewhere: !appliesToScene(v, sceneId),
      sceneName: v.sceneId ? (game.scenes.get(v.sceneId)?.name ?? "?") : null,
      editing: d.editingId === v.id
    });

    const targets = getAllTargets();
    const full = (t) => foundry.utils.mergeObject(defaultTarget(), t ?? {}, { inplace: false });
    const activeCount = Object.values(targets).filter((t) => isTargetActive(full(t))).length;
    const music = target?.music ?? defaultTarget().music;
    const needsSelection = ["appearance", "phantom", "vanish"].includes(d.kind);

    return {
      users: this.#players().map((u) => {
        const t = full(targets[u.id]);
        const stopped = isStopped(u);
        const tips = [u.name];
        if (!u.active) tips.push(L("Offline"));
        if (stopped) tips.push(L("StatusStopped"));
        return {
          id: u.id,
          name: u.name,
          initial: (u.name || "?").slice(0, 1).toUpperCase(),
          color: userColor(u),
          online: u.active,
          stopped,
          live: isTargetActive(t),
          heldCount: t.held.length,
          selected: u.id === userId,
          tooltip: tips.join(" · ")
        };
      }),
      hasTarget: !!userId,
      stopped: isStopped(user),
      activeCount,
      isPlay: this.#tab === "play",

      intensities: [0, 1, 2, 3].map((i) => ({ value: i, label: L(`Intensity${i}`), on: (target?.intensity ?? 0) === i })),
      visions: shownDeck.map(card),
      hasVisions: shownDeck.length > 0,
      elsewhereCount: deck.length - here.length,
      allScenes: this.#allScenes,
      music,
      musicOpen: this.#musicOpen,
      musicPresets: getMusicPresets(),
      musicTrackName: music.track?.displayTitle || music.track?.title || "",
      hasLazyMusic: !!game.modules.get("lazy-music")?.active,

      draft: d,
      editing: !!d.editingId,
      kinds: KINDS.map((k) => ({ key: k, icon: KIND_ICONS[k], label: L(`Kind.${k}`), active: d.kind === k })),
      kindHint: L(`KindHint.${d.kind}`),
      isAppearance: d.kind === "appearance",
      isPhantom: d.kind === "phantom",
      isTint: d.kind === "tint",
      isSound: d.kind === "sound",
      needsSelection,
      nameStep: d.kind === "appearance" ? 4 : 3,
      presets: getPresets().map((p) => ({ ...p, on: p.src === d.img })),
      fineOpen: this.#fineOpen,
      lookSummary: d.kind === "appearance" ? lookSummary(lookFromDraft(d)) : "",
      ringModes: RING_MODES.map((m) => ({ value: m, label: L(`LookRingMode.${m}`), selected: d.lookRing === m })),
      lookRingOff: d.lookRing === "off",
      createHoldLabel: F("CreateAndHold", { name: user?.name ?? "" }),
      allVisions: deck.map(card)
    };
  }

  /* --------------------------- Живые строки ------------------------------- */

  #paintStatus() {
    const el = this.element?.querySelector("[data-status]");
    if (!el) return;
    const userId = this.#currentUserId();
    const s = userId ? statusCache.get(userId) : null;
    const dot = el.querySelector(".bm-dot");
    const text = el.querySelector(".bm-status-text");
    if (!s) {
      dot?.classList.remove("live");
      if (text) text.textContent = L("StatusNone");
      return;
    }
    const deck = new Map(getDeck().map((v) => [v.id, v]));
    const names = (s.shown ?? []).map((id) => {
      const v = deck.get(id);
      return v ? (v.name || this.#autoName(v)) : "?";
    });
    const parts = [];
    if (s.stopped) parts.push(L("StatusStopped"));
    else parts.push(`${L("StatusSees")}: ${names.length ? names.join(", ") : L("StatusNothing")}`);
    if (s.sceneId && s.sceneId !== canvas.scene?.id) {
      parts.push(F("StatusOtherScene", { name: game.scenes.get(s.sceneId)?.name ?? "?" }));
    }
    if (s.music) parts.push(L("StatusMusic"));
    for (const p of s.problems ?? []) {
      const v = deck.get(p.id);
      const name = v ? (v.name || this.#autoName(v)) : "?";
      parts.push(`⚠ ${F(p.why === "img" ? "ProblemImg" : "ProblemTokens", { name })}`);
    }
    dot?.classList.toggle("live", !s.stopped && names.length > 0);
    dot?.classList.toggle("stop", !!s.stopped);
    if (text) text.textContent = parts.join(" · ");
  }

  /** Что выделено на сцене — в шаге «На кого» редактора. */
  #paintSelection() {
    const el = this.element?.querySelector("[data-selection]");
    if (!el) return;
    const d = this.#draft;
    const { tokens, tiles } = selection();
    const items = [
      ...tokens.map((t) => ({ name: t.document.name, img: t.document.texture?.src })),
      ...(d.kind === "appearance" ? [] : tiles.map((t) => ({
        name: basename(t.document.texture?.src) || "Tile", img: t.document.texture?.src
      })))
    ];
    const chip = (x) => `<span class="bm-tokchip">${x.img && !VIDEO_RE.test(x.img) ? `<img src="${esc(x.img)}">` : ""}${esc(x.name)}</span>`;
    const base = d.editingId ? getVision(d.editingId) : null;
    if (items.length) {
      el.innerHTML = `<div class="bm-selected">${items.map(chip).join("")}</div>`
        + (base ? `<p class="bm-hint">${esc(L("SelectionReplaces"))}</p>` : "");
    } else if (base) {
      el.innerHTML = `<div class="bm-dropzone">${esc(F("SelectionKeeps", { what: this.#objectsText(base) }))}</div>`;
    } else {
      el.innerHTML = `<div class="bm-dropzone bm-want"><i class="fa-solid fa-arrow-pointer"></i> ${esc(L(d.kind === "appearance" ? "SelectTokens" : "SelectObjects"))}</div>`;
    }
  }

  /** Примерный вид сдвига цвета — на полосе-образце. */
  #paintSwatch() {
    const el = this.element?.querySelector("[data-swatch]");
    if (!el) return;
    const d = this.#draft;
    el.style.filter = `hue-rotate(${Number(d.hue) || 0}deg) saturate(${Number(d.saturation) ?? 1}) brightness(${Number(d.brightness) ?? 1})`;
  }

  /* ------------------------------ Цель ------------------------------------ */

  static async #onPickTarget(_ev, el) {
    const id = el.dataset.userId;
    if (!id || id === this.#userId) return;
    this.#userId = id;
    this.render();
    dispatch("ping", null);
    await game.settings.set(MODULE_ID, SETTING_LAST_TARGET, id);
  }

  static #onSetTab(_ev, el) {
    this.#tab = el.dataset.tab === "work" ? "work" : "play";
    this.render();
  }

  static async #onSetIntensity(_ev, el) {
    const userId = this.#currentUserId();
    if (userId) await updateTarget(userId, { intensity: Math.max(0, Math.min(3, Number(el.dataset.value) | 0)) });
  }

  static async #onResume() {
    const user = game.users.get(this.#currentUserId());
    if (user) await clearStop(user);
  }

  /** Снять всё у цели: фон 0, ничего не держится, своя музыка выключена.
   *  Фоновый набор остаётся — это настройка, а не показ. */
  static async #onClearTarget() {
    const userId = this.#currentUserId();
    if (userId) await updateTarget(userId, { intensity: 0, held: [], music: { enabled: false } });
  }

  static async #onStopAll() {
    const all = getAllTargets();
    for (const t of Object.values(all)) {
      t.intensity = 0;
      t.held = [];
      if (t.music) t.music.enabled = false;
    }
    await game.settings.set(MODULE_ID, SETTING_TARGETS, all);
    ui.notifications.info(L("AllOff"));
  }

  /* ------------------------------ Колода ---------------------------------- */

  static #visionId(el) {
    return el.closest("[data-vision-id]")?.dataset.visionId ?? null;
  }

  static #onFlash(_ev, el) {
    const userId = this.#currentUserId();
    const visionId = MadnessPanel.#visionId(el);
    if (!userId || !visionId) return;
    if (isStopped(game.users.get(userId))) return ui.notifications.warn(L("TargetStopped"));
    const ms = Math.max(0.2, Number(this.#draft.flashSec) || FLASH_SECONDS) * 1000;
    dispatch("flash", userId, { visionId, ms });
    const card = el.closest(".bm-card");
    if (card) {
      card.classList.add("flashing");
      setTimeout(() => card.classList.remove("flashing"), ms);
    }
  }

  static async #onToggleHeld(_ev, el) {
    const userId = this.#currentUserId();
    const id = MadnessPanel.#visionId(el);
    if (!userId || !id) return;
    const held = new Set(getTarget(userId).held);
    if (held.has(id)) held.delete(id); else held.add(id);
    await updateTarget(userId, { held: [...held] });
  }

  static async #onToggleAmbient(_ev, el) {
    const userId = this.#currentUserId();
    const id = MadnessPanel.#visionId(el);
    if (!userId || !id) return;
    const t = getTarget(userId);
    const ambient = new Set(t.ambient);
    if (ambient.has(id)) ambient.delete(id); else ambient.add(id);
    await updateTarget(userId, { ambient: [...ambient] });
    if (ambient.size && !t.intensity) ui.notifications.info(L("AmbientNeedsIntensity"));
  }

  static #onEditVision(_ev, el) {
    const v = getVision(MadnessPanel.#visionId(el));
    if (!v) return;
    this.#draft = {
      ...emptyDraft(this.#draft),
      editingId: v.id,
      kind: v.kind,
      name: v.name ?? "",
      img: v.img ?? "",
      label: v.label ?? "",
      byActor: (v.actors?.length ?? 0) > 0,
      ...lookDraft(v.look),
      autoHide: false,
      hue: v.tint?.hue ?? 0,
      saturation: v.tint?.saturation ?? 1,
      brightness: v.tint?.brightness ?? 1,
      soundSrc: v.sound?.src ?? "",
      soundVolume: v.sound?.volume ?? 0.8
    };
    this.#fineOpen = v.kind === "appearance" && !isPlainLook(v.look);
    this.#tab = "work";
    this.render();
  }

  static async #onDeleteVision(_ev, el) {
    const v = getVision(MadnessPanel.#visionId(el));
    if (!v) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: L("DeleteTitle") },
      content: `<p>${F("DeleteConfirm", { name: esc(v.name || this.#autoName(v)) })}</p>`
    });
    if (!ok) return;
    if (this.#draft.editingId === v.id) this.#draft = emptyDraft(this.#draft);
    await deleteVision(v.id);
  }

  /* -------------------------- Форма видения ------------------------------- */

  static #onSetKind(_ev, el) {
    if (this.#draft.editingId) return; // вид правимого видения не меняем
    this.#draft.kind = el.dataset.kind;
    this.render();
  }

  static #onToggleFine() {
    this.#fineOpen = !this.#fineOpen;
    this.render();
  }

  static #onPickImg() {
    openFilePicker("imagevideo", this.#draft.img, (path) => { this.#draft.img = path; this.render(); });
  }

  static async #onSavePreset() {
    const src = String(this.#draft.img ?? "").trim();
    if (!src) return ui.notifications.warn(L("NeedImage"));
    await addPreset(basename(src), src);
    ui.notifications.info(F("PresetSaved", { name: basename(src) }));
  }

  static #onUsePreset(_ev, el) {
    const src = el.closest("[data-src]")?.dataset.src;
    if (!src) return;
    this.#draft.img = src;
    this.render();
  }

  static async #onRemovePreset(_ev, el) {
    const id = el.closest("[data-preset-id]")?.dataset.presetId;
    if (id) await removePreset(id);
  }

  static #onPickSound() {
    openFilePicker("audio", this.#draft.soundSrc, (path) => { this.#draft.soundSrc = path; this.render(); });
  }

  static #onCancelEdit() {
    this.#draft = emptyDraft(this.#draft);
    this.render();
  }

  static async #onSubmitVision() {
    await this.#submit(false);
  }

  /** Создать и сразу держать у выбранного игрока — и перейти на «Игру». */
  static async #onSubmitAndHold() {
    await this.#submit(true);
  }

  async #submit(hold) {
    const v = this.#buildVision();
    if (!v) return;
    const editing = !!this.#draft.editingId;
    const toHide = v.kind === "phantom" && this.#draft.autoHide ? this.#visibleObjects(v) : null;
    await saveVision(v);
    if (toHide) await this.#hideObjects(v.sceneId, toHide);
    const userId = hold ? this.#currentUserId() : null;
    if (userId) {
      const held = new Set(getTarget(userId).held);
      held.add(v.id);
      await updateTarget(userId, { held: [...held] });
      this.#tab = "play";
    }
    ui.notifications.info(F(editing ? "VisionSaved" : "VisionCreated", { name: v.name }));
    this.#draft = emptyDraft(this.#draft);
    this.render();
  }

  /** Собрать видение из формы и выделенного на сцене. null — не хватает данных. */
  #buildVision() {
    const d = this.#draft;
    const base = d.editingId ? getVision(d.editingId) : null;
    const v = base ? foundry.utils.deepClone(base) : newVision(d.kind);
    const sel = selection();
    const sceneId = canvas.scene?.id ?? null;
    const warn = (k) => { ui.notifications.warn(L(k)); return null; };

    switch (d.kind) {
      case "appearance": {
        v.img = String(d.img ?? "").trim();
        v.label = String(d.label ?? "").trim();
        v.look = lookFromDraft(d);
        if (!v.img && !v.label && isPlainLook(v.look)) return warn("NeedImageOrLabel");
        if (sel.tokens.length) {
          if (d.byActor) {
            v.actors = [...new Set(sel.tokens.map((t) => t.document.actorId).filter(Boolean))];
            if (!v.actors.length) return warn("NeedActorTokens");
            v.tokens = []; v.sceneId = null;
          } else {
            v.tokens = sel.tokens.map((t) => t.document.id);
            v.actors = []; v.sceneId = sceneId;
          }
        } else if (!base) {
          return warn("NeedTokens");
        } else if (d.byActor && v.tokens.length) {
          // Перевод «эти токены» → «все токены их актёров».
          const scene = game.scenes.get(v.sceneId);
          v.actors = [...new Set(v.tokens.map((id) => scene?.tokens.get(id)?.actorId).filter(Boolean))];
          if (!v.actors.length) return warn("NeedActorTokens");
          v.tokens = []; v.sceneId = null;
        } else if (!d.byActor && v.actors.length) {
          return warn("NeedTokens");
        }
        v.tiles = [];
        break;
      }
      case "phantom":
      case "vanish": {
        if (sel.tokens.length || sel.tiles.length) {
          v.tokens = sel.tokens.map((t) => t.document.id);
          v.tiles = sel.tiles.map((t) => t.document.id);
          v.sceneId = sceneId;
        } else if (!base) {
          return warn("NeedObjects");
        }
        v.actors = [];
        break;
      }
      case "tint":
        v.tint = {
          hue: Number(d.hue) || 0,
          saturation: Number.isFinite(Number(d.saturation)) ? Number(d.saturation) : 1,
          brightness: Number.isFinite(Number(d.brightness)) ? Number(d.brightness) : 1
        };
        v.sceneId = null;
        break;
      case "sound": {
        const src = String(d.soundSrc ?? "").trim();
        if (!src) return warn("NeedSound");
        v.sound = { src, volume: Math.max(0, Math.min(1, Number(d.soundVolume) || 0.8)) };
        v.sceneId = null;
        break;
      }
    }
    v.name = String(d.name ?? "").trim() || this.#autoName(v);
    return v;
  }

  /** Объекты призрака, которые сейчас видят все (их надо спрятать). */
  #visibleObjects(v) {
    const scene = game.scenes.get(v.sceneId);
    if (!scene) return null;
    return {
      Token: v.tokens.filter((id) => scene.tokens.get(id) && !scene.tokens.get(id).hidden),
      Tile: v.tiles.filter((id) => scene.tiles.get(id) && !scene.tiles.get(id).hidden)
    };
  }

  async #hideObjects(sceneId, byType) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    for (const [type, ids] of Object.entries(byType)) {
      if (ids.length) await scene.updateEmbeddedDocuments(type, ids.map((_id) => ({ _id, hidden: true })));
    }
  }

  /* --------------------------- Музыка безумия ---------------------------- */

  #readTrack() {
    const track = parseTrackInput(this.#draft.musicSrc);
    if (!track) ui.notifications.warn(L("NeedTrack"));
    return track;
  }

  static #onToggleMusic() {
    this.#musicOpen = !this.#musicOpen;
    this.render();
  }

  static #onMusicPick() {
    openFilePicker("audio", this.#draft.musicSrc, (p) => { this.#draft.musicSrc = p; this.render(); });
  }

  static async #onMusicFromLM() {
    const t = await currentLazyMusicTrack();
    if (!t) return ui.notifications.warn(L("NoLMTrack"));
    this.#draft.musicSrc = t.streamUrl || t.videoId || "";
    this.render();
    ui.notifications.info(F("TrackTaken", { name: t.displayTitle || t.title }));
  }

  static async #onMusicSavePreset() {
    const track = this.#readTrack();
    if (track) await addMusicPreset(track.displayTitle || track.title, track);
  }

  static #onMusicUsePreset(_ev, el) {
    const id = el.closest("[data-preset-id]")?.dataset.presetId;
    const p = getMusicPresets().find((x) => x.id === id);
    if (!p) return;
    this.#draft.musicSrc = p.track?.streamUrl || p.track?.videoId || "";
    this.render();
  }

  static async #onMusicRemovePreset(_ev, el) {
    const id = el.closest("[data-preset-id]")?.dataset.presetId;
    if (id) await removeMusicPreset(id);
  }

  static async #onMusicStart() {
    const userId = this.#currentUserId();
    if (!userId) return;
    const track = this.#readTrack();
    if (!track) return;
    const isolate = !!this.element.querySelector("[name=music-isolate]")?.checked;
    // since — новый запуск: тот же трек можно включить снова, если общая
    // музыка уже сменила его у цели без изоляции.
    await updateTarget(userId, { music: { enabled: true, isolate, track, since: Date.now() } });
    ui.notifications.info(F("MusicStarted", { name: game.users.get(userId)?.name }));
  }

  static async #onMusicStop() {
    const userId = this.#currentUserId();
    if (userId) await updateTarget(userId, { music: { enabled: false } });
  }
}

/* Выделенное на сцене в редакторе — без перерисовки панели. */
for (const hook of ["controlToken", "controlTile", "canvasReady"]) {
  Hooks.on(hook, () => { if (game.user?.isGM) MadnessPanel.updateSelection(); });
}
// Сменилась сцена у ГМ — колода в панели другая.
Hooks.on("canvasReady", () => { if (game.user?.isGM) MadnessPanel.refresh(); });
