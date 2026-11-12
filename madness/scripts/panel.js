/**
 * ПАНЕЛЬ ГМ — «Восприятие безумия» (ApplicationV2 + Handlebars).
 *
 * Три зоны: цель (сила фона, стоп), колода видений текущей сцены (вспышка,
 * держать, в фон) и форма нового видения. Объекты для облика, призрака и
 * пропажи берутся из выделенного на сцене — ГМ ставит и двигает их
 * штатными инструментами Foundry.
 *
 * Недописанное в форме хранится в #draft и переживает перерисовку панели
 * (перерисовка приходит от любой записи настроек).
 */

import {
  MODULE_ID, SETTING_LAST_TARGET, SETTING_TARGETS, KINDS, KIND_ICONS, FLASH_SECONDS,
  defaultTarget, newVision, appliesToScene
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

export class MadnessPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  #userId = null;
  #draft = emptyDraft();
  #allScenes = false;

  static DEFAULT_OPTIONS = {
    id: "burn-cinema-madness",
    classes: ["burn-madness"],
    window: { title: "burncinema.Madness.Title", icon: "fa-solid fa-brain", resizable: true },
    position: { width: 560, height: "auto" },
    actions: {
      resume: MadnessPanel.#onResume,
      clearTarget: MadnessPanel.#onClearTarget,
      stopAll: MadnessPanel.#onStopAll,
      flash: MadnessPanel.#onFlash,
      toggleHeld: MadnessPanel.#onToggleHeld,
      toggleAmbient: MadnessPanel.#onToggleAmbient,
      editVision: MadnessPanel.#onEditVision,
      deleteVision: MadnessPanel.#onDeleteVision,
      setKind: MadnessPanel.#onSetKind,
      pickImg: MadnessPanel.#onPickImg,
      savePreset: MadnessPanel.#onSavePreset,
      usePreset: MadnessPanel.#onUsePreset,
      removePreset: MadnessPanel.#onRemovePreset,
      pickSound: MadnessPanel.#onPickSound,
      submitVision: MadnessPanel.#onSubmitVision,
      cancelEdit: MadnessPanel.#onCancelEdit,
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

  /** Обновить счётчик выделенного на сцене. */
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
      if (el?.dataset?.draft) this.#readDraftField(el);
      if (el?.name === "intensity") {
        const out = root.querySelector("[data-intensity-label]");
        if (out) out.textContent = L(`Intensity${el.value}`);
      }
    });

    root.addEventListener("change", async (ev) => {
      const el = ev.target;
      if (el?.dataset?.draft) this.#readDraftField(el);
      switch (el?.name) {
        case "target":
          this.#userId = el.value;
          await game.settings.set(MODULE_ID, SETTING_LAST_TARGET, el.value);
          this.render();
          break;
        case "intensity": {
          const userId = this.#currentUserId();
          if (userId) await updateTarget(userId, { intensity: Math.max(0, Math.min(3, el.value | 0)) });
          break;
        }
        case "allScenes":
          this.#allScenes = el.checked;
          this.render();
          break;
        case "byActor":
          this.render(); // подсказка про выделение зависит от галки
          break;
      }
    });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#paintStatus();
    this.#paintSelection();
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

  #describe(v) {
    const objects = () => {
      const all = [
        ...(v.tokens ?? []).map((id) => objectName(v.sceneId, "tokens", id) ?? "?"),
        ...(v.tiles ?? []).map((id) => objectName(v.sceneId, "tiles", id) ?? "?")
      ];
      if (!all.length) return L("NoObjects");
      const shown = all.slice(0, 3).join(", ");
      return all.length > 3 ? `${shown} ${F("AndMore", { n: all.length - 3 })}` : shown;
    };
    switch (v.kind) {
      case "appearance": {
        const who = v.actors?.length
          ? F("AllTokensOf", { names: v.actors.map((id) => game.actors.get(id)?.name ?? "?").join(", ") })
          : objects();
        return v.label ? `${who} → «${v.label}»` : who;
      }
      case "phantom":
      case "vanish":
        return objects();
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

    const here = deck.filter((v) => appliesToScene(v, sceneId));
    const shownDeck = this.#allScenes ? deck : here;
    const visions = shownDeck.map((v) => ({
      id: v.id,
      name: v.name || this.#autoName(v),
      kind: v.kind,
      icon: KIND_ICONS[v.kind] ?? "fa-question",
      kindLabel: L(`Kind.${v.kind}`),
      desc: this.#describe(v),
      img: v.kind === "appearance" ? v.img : null,
      held: held.has(v.id),
      ambient: ambient.has(v.id),
      elsewhere: !appliesToScene(v, sceneId),
      sceneName: v.sceneId ? (game.scenes.get(v.sceneId)?.name ?? "?") : null,
      editing: this.#draft.editingId === v.id
    }));

    const targets = getAllTargets();
    const activeCount = Object.values(targets)
      .filter((t) => isTargetActive(foundry.utils.mergeObject(defaultTarget(), t, { inplace: false }))).length;

    const d = this.#draft;
    const music = target?.music ?? defaultTarget().music;

    return {
      users: this.#players().map((u) => {
        const t = targets[u.id];
        let label = u.name;
        if (!u.active) label += ` (${L("Offline")})`;
        if (isStopped(u)) label = `⛔ ${label}`;
        else if (t && isTargetActive(foundry.utils.mergeObject(defaultTarget(), t, { inplace: false }))) label = `● ${label}`;
        return { id: u.id, label, selected: u.id === userId };
      }),
      hasTarget: !!userId,
      targetName: user?.name ?? "",
      stopped: isStopped(user),
      target,
      intensityLabel: L(`Intensity${target?.intensity ?? 0}`),
      activeCount,
      sceneName: canvas.scene?.name ?? "—",
      visions,
      hasVisions: visions.length > 0,
      elsewhereCount: deck.length - here.length,
      allScenes: this.#allScenes,
      draft: d,
      editing: !!d.editingId,
      kinds: KINDS.map((k) => ({ key: k, icon: KIND_ICONS[k], label: L(`Kind.${k}`), active: d.kind === k })),
      kindHint: L(`KindHint.${d.kind}`),
      isAppearance: d.kind === "appearance",
      isPhantom: d.kind === "phantom",
      isVanish: d.kind === "vanish",
      isTint: d.kind === "tint",
      isSound: d.kind === "sound",
      needsSelection: ["appearance", "phantom", "vanish"].includes(d.kind),
      presets: getPresets(),
      musicPresets: getMusicPresets(),
      music,
      musicTrackName: music.track?.displayTitle || music.track?.title || "",
      hasLazyMusic: !!game.modules.get("lazy-music")?.active
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
    else parts.push(`${L("StatusSees")}: ${names.length ? names.join(", ") : "—"}`);
    parts.push(`${L("StatusAmbient")}: ${s.intensity ?? 0}`);
    if (s.sceneId && s.sceneId !== canvas.scene?.id) {
      parts.push(F("StatusOtherScene", { name: game.scenes.get(s.sceneId)?.name ?? "?" }));
    }
    if (s.music) parts.push(L("StatusMusic"));
    dot?.classList.toggle("live", !s.stopped && names.length > 0);
    dot?.classList.toggle("stop", !!s.stopped);
    if (text) text.textContent = parts.join(" · ");
  }

  #paintSelection() {
    const el = this.element?.querySelector("[data-selection]");
    if (!el) return;
    const { tokens, tiles } = selection();
    el.textContent = F("Selected", { tokens: tokens.length, tiles: tiles.length });
    el.classList.toggle("bm-warn", tokens.length + tiles.length === 0);
  }

  /* ------------------------------ Цель ------------------------------------ */

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
      autoHide: false,
      hue: v.tint?.hue ?? 0,
      saturation: v.tint?.saturation ?? 1,
      brightness: v.tint?.brightness ?? 1,
      soundSrc: v.sound?.src ?? "",
      soundVolume: v.sound?.volume ?? 0.8
    };
    this.render();
  }

  static async #onDeleteVision(_ev, el) {
    const v = getVision(MadnessPanel.#visionId(el));
    if (!v) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: L("DeleteTitle") },
      content: `<p>${F("DeleteConfirm", { name: foundry.utils.escapeHTML(v.name || this.#autoName(v)) })}</p>`
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
    const v = this.#buildVision();
    if (!v) return;
    const toHide = v.kind === "phantom" && this.#draft.autoHide ? this.#visibleObjects(v) : null;
    await saveVision(v);
    if (toHide) await this.#hideObjects(v.sceneId, toHide);
    ui.notifications.info(F(this.#draft.editingId ? "VisionSaved" : "VisionCreated", { name: v.name }));
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
        if (!v.img && !v.label) return warn("NeedImageOrLabel");
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
    await updateTarget(userId, { music: { enabled: true, isolate, track } });
    ui.notifications.info(F("MusicStarted", { name: game.users.get(userId)?.name }));
  }

  static async #onMusicStop() {
    const userId = this.#currentUserId();
    if (userId) await updateTarget(userId, { music: { enabled: false } });
  }
}

/* Счётчик выделенного в форме — без перерисовки панели. */
for (const hook of ["controlToken", "controlTile", "canvasReady"]) {
  Hooks.on(hook, () => { if (game.user?.isGM) MadnessPanel.updateSelection(); });
}
// Сменилась сцена у ГМ — колода в панели другая.
Hooks.on("canvasReady", () => { if (game.user?.isGM) MadnessPanel.refresh(); });
