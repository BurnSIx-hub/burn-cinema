/**
 * ДВИЖОК ВИДЕНИЙ — работает на КЛИЕНТЕ ЦЕЛИ (и у ГМ, когда он сам себе цель).
 *
 * Источник правды — world-настройки (колода и состояние цели) и флаг стопа
 * на User. Движок их только читает и по ним наполняет подмены OV (wrap.js),
 * а Foundry перерисовывает затронутые объекты.
 *
 * Что показано сейчас = (удерживаемые ∪ вспыхнувшие) видения текущей сцены,
 * либо ничего, если игрок нажал стоп.
 * Фон: раз в случайный интервал (по силе) берём ОДНО видение из фонового
 * набора цели и показываем вспышкой случайной длительности.
 */

import { INTENSITY, appliesToScene, rand, normalizeLook, isPlainLook } from "./constants.js";
import { getDeck, getTarget, isStopped, setStop } from "./state.js";
import { emit } from "./net.js";
import { OV, LOOKED, keyOf, lookForDoc, lookSig } from "./wrap.js";
import { syncNameViews } from "./names.js";
import { startMadnessMusic, stopMadnessMusic, isMadnessMusicOn, onMadnessMusicChange } from "./music.js";

/* ------------------------------ Текстуры --------------------------------- */

const TEX_CACHE = new Map(); // src -> PIXI.Texture

const texAlive = (t) => !!t && !t.destroyed && !!t.baseTexture && !t.baseTexture.destroyed;

async function loadTex(src) {
  if (!src) return null;
  const cached = TEX_CACHE.get(src);
  if (texAlive(cached)) return cached;
  try {
    const load = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
    const tex = await load(src);
    if (texAlive(tex)) { TEX_CACHE.set(src, tex); return tex; }
  } catch (err) {
    console.warn(`burn-cinema | безумие: не загрузилась картинка ${src}`, err);
  }
  return null;
}

/* -------------------------------------------------------------------------- */

class VisionEngine {
  #flashing = new Map();   // visionId -> timeout
  #ambientTimer = null;
  #ambientLevel = 0;
  #localStop = false;      // стоп нажат, флаг на User ещё не записан
  #seq = 0;                // защита от гонки асинхронных перерисовок
  #shown = [];             // id видений, показанных прямо сейчас
  #filter = null;          // ColorMatrixFilter на canvas.stage
  #loops = new Map();      // visionId -> Promise<Sound> (удерживаемый звук)
  #lastReport = "";
  #problems = [];         // почему видение не применилось у этой цели
  #warned = new Set();     // о чём уже предупредили в консоли

  /** Игрок нажал стоп (флаг на User или ещё не дошедший до сервера). */
  get stopped() {
    return this.#localStop || isStopped(game.user);
  }

  /** Пересобрать всё по актуальному состоянию (настройки, сцена, стоп). */
  sync() {
    const t = getTarget(game.user.id);
    if (this.stopped) {
      this.#clearFlashes();
      this.#setAmbient(0);
    } else {
      this.#setAmbient(t.intensity | 0);
    }
    this.#syncMusic(t);
    return this.#render();
  }

  /** Вспышка видения на ms миллисекунд (команда ГМ или фон). */
  flash(visionId, ms) {
    if (this.stopped || !canvas.ready) return;
    const v = getDeck().find((x) => x.id === visionId);
    if (!v || !appliesToScene(v, canvas.scene?.id)) return;
    if (getTarget(game.user.id).held.includes(visionId)) return; // и так показано
    clearTimeout(this.#flashing.get(visionId));
    this.#flashing.set(visionId, setTimeout(() => {
      this.#flashing.delete(visionId);
      this.#render();
    }, Math.max(100, ms | 0)));
    if (v.kind === "sound") this.#playSound(v, false);
    this.#render();
  }

  /** Стоп с клавиатуры игрока: сразу гасим всё, потом ставим флаг на себя. */
  async stopByPlayer() {
    // Игрок жмёт стоп в неловкий момент — ему нужно знать, что нажатие дошло.
    ui.notifications.info(game.i18n.localize("burncinema.Madness.StopSelf"));
    if (this.stopped) return;
    this.#localStop = true;
    this.sync();
    try {
      await setStop(game.user);
    } catch (err) {
      // Флаг не записался — стоп всё равно держится до F5.
      console.warn("burn-cinema | безумие: флаг стопа не записался", err);
    }
  }

  /** Флаг стопа на моём User изменился (хук updateUser). */
  onStopFlagChanged() {
    if (!isStopped(game.user)) this.#localStop = false;
    this.sync();
  }

  /** Отправить ГМ телеметрию (force — даже если ничего не поменялось). */
  report(force = false) {
    const payload = {
      shown: this.#shown,
      flashing: [...this.#flashing.keys()],
      intensity: this.#ambientLevel,
      stopped: this.stopped,
      sceneId: canvas.scene?.id ?? null,
      music: isMadnessMusicOn(),
      problems: this.#problems
    };
    const json = JSON.stringify(payload);
    if (!force && json === this.#lastReport) return;
    this.#lastReport = json;
    emit("status", game.user.id, payload);
    // ГМ, который сам себе цель: сокет не доставляет отправителю его же сообщение.
    Hooks.callAll("burncinemaMadnessStatus", game.user.id, payload);
  }

  /* ------------------------------ Фон ------------------------------------- */

  #setAmbient(level) {
    if (level === this.#ambientLevel && (level === 0 || this.#ambientTimer)) return;
    clearTimeout(this.#ambientTimer);
    this.#ambientTimer = null;
    this.#ambientLevel = level;
    if (level > 0) this.#scheduleAmbient();
  }

  #scheduleAmbient() {
    const cfg = INTENSITY[this.#ambientLevel];
    if (!cfg) return;
    this.#ambientTimer = setTimeout(() => this.#ambientTick(), rand(cfg.intervalMin, cfg.intervalMax));
  }

  #ambientTick() {
    this.#ambientTimer = null;
    const cfg = INTENSITY[this.#ambientLevel];
    if (!cfg || this.stopped) return;
    const t = getTarget(game.user.id);
    const held = new Set(t.held);
    const sceneId = canvas.scene?.id;
    const deck = new Map(getDeck().map((v) => [v.id, v]));
    const pool = t.ambient
      .map((id) => deck.get(id))
      .filter((v) => v && appliesToScene(v, sceneId) && !held.has(v.id) && !this.#flashing.has(v.id));
    if (pool.length) this.flash(pool[rand(0, pool.length - 1)].id, rand(cfg.durMin, cfg.durMax));
    this.#scheduleAmbient();
  }

  #clearFlashes() {
    for (const t of this.#flashing.values()) clearTimeout(t);
    this.#flashing.clear();
  }

  /* ----------------------------- Рендер ----------------------------------- */

  async #render() {
    const seq = ++this.#seq;
    const ready = !!canvas.ready;
    const sceneId = canvas.scene?.id ?? null;
    const t = getTarget(game.user.id);
    const deck = new Map(getDeck().map((v) => [v.id, v]));
    const heldIds = new Set(this.stopped ? [] : t.held);

    const ids = new Set(heldIds);
    if (!this.stopped) for (const id of this.#flashing.keys()) ids.add(id);
    const visions = ready
      ? [...ids].map((id) => deck.get(id)).filter((v) => v && appliesToScene(v, sceneId))
      : [];

    // Картинки облика грузим ДО подмены — иначе мигнёт пустой токен.
    await Promise.all(visions.filter((v) => v.kind === "appearance" && v.img).map((v) => loadTex(v.img)));
    if (seq !== this.#seq) return; // пока грузили, пришло состояние новее

    this.#problems = this.#checkAppearance(visions);

    const show = new Set();
    const hide = new Set();
    const look = new Map();
    const lookByActor = new Map();
    const loops = new Set();
    let tint = null;

    for (const v of visions) {
      switch (v.kind) {
        case "appearance": {
          // Картинка, которая не загрузилась, облик не ломает: остальные
          // настройки (масштаб, кольцо, оттенок…) всё равно применяются.
          const tex = v.img ? TEX_CACHE.get(v.img) : null;
          const settings = normalizeLook(v.look);
          const l = { img: texAlive(tex) ? v.img : null, label: v.label || "", look: settings };
          if (!l.img && !l.label && isPlainLook(settings)) break;
          for (const id of v.tokens ?? []) look.set(id, l);
          for (const id of v.actors ?? []) lookByActor.set(id, l);
          break;
        }
        case "phantom":
          for (const id of v.tokens ?? []) show.add(`Token.${id}`);
          for (const id of v.tiles ?? []) show.add(`Tile.${id}`);
          break;
        case "vanish":
          for (const id of v.tokens ?? []) hide.add(`Token.${id}`);
          for (const id of v.tiles ?? []) hide.add(`Tile.${id}`);
          break;
        case "tint":
          tint = v.tint;
          break;
        case "sound":
          if (heldIds.has(v.id)) loops.add(v.id);
          break;
      }
    }

    // Затронуты объекты и из прошлого набора, и из нового.
    const visKeys = new Set([...OV.show, ...OV.hide, ...show, ...hide]);
    const lookTokens = new Set([...OV.look.keys(), ...look.keys()]);
    const lookActors = new Set([...OV.lookByActor.keys(), ...lookByActor.keys()]);

    OV.show = show;
    OV.hide = hide;
    OV.look = look;
    OV.lookByActor = lookByActor;

    if (ready) {
      for (const tok of canvas.tokens?.placeables ?? []) {
        const doc = tok.document;
        const vis = visKeys.has(keyOf(tok));
        const lk = lookTokens.has(doc.id) || (!!doc.actorId && lookActors.has(doc.actorId));
        if (!vis && !lk) continue;
        const flags = {};
        if (vis) { flags.refreshState = true; flags.refreshVisibility = true; }
        if (lk) flags.refreshNameplate = true; // картинку и кольцо — через #applyLooks
        tok.renderFlags.set(flags);
      }
      for (const tile of canvas.tiles?.placeables ?? []) {
        if (visKeys.has(keyOf(tile))) tile.renderFlags.set({ refreshState: true, refreshVisibility: true });
      }
    }

    if (ready) this.#applyLooks();
    syncNameViews(); // имя и картинка облика в трекере и чате
    this.#applyTint(tint);
    this.#syncLoops(deck, loops);
    const failed = new Set(this.#problems.map((p) => p.id));
    this.#shown = visions.filter((v) => !failed.has(v.id)).map((v) => v.id);
    this.report();
  }

  /**
   * Облик меняет данные токена (wrap.js → TokenDocument#prepareData), а не
   * только картинку меша: так Foundry сама рисует кольцо, масштаб, отражение
   * и оттенок. Документ, чей облик сменился или снят, пересчитываем, а его
   * токен на холсте перерисовываем целиком — текстура и кольцо грузятся в
   * Token#draw. Нетронутые токены не трогаем.
   */
  #applyLooks() {
    const docs = new Set(LOOKED.keys());
    for (const tok of canvas.tokens?.placeables ?? []) {
      if (lookForDoc(tok.document)) docs.add(tok.document);
    }
    for (const doc of docs) {
      const want = lookSig(lookForDoc(doc));
      if (want === (LOOKED.get(doc) ?? "")) continue;
      // Токен удалён — забываем его.
      if (!doc.parent?.tokens?.has(doc.id)) { LOOKED.delete(doc); continue; }
      try {
        doc.reset();
        if (!want) LOOKED.delete(doc);
        const tok = doc.object;
        if (tok && !tok.destroyed) tok.renderFlags.set({ redraw: true });
      } catch (err) {
        console.warn(`burn-cinema | безумие: не удалось перерисовать токен ${doc.name}`, err);
      }
    }
  }

  /**
   * Облик, который цель не увидит: картинка не загрузилась или (для видения,
   * привязанного к сцене) его токенов на сцене нет. Без этого облик молча не
   * применялся, и ни ГМ, ни игрок не знали почему.
   */
  #checkAppearance(visions) {
    const problems = [];
    for (const v of visions) {
      if (v.kind !== "appearance") continue;
      let why = null;
      if (v.img && !texAlive(TEX_CACHE.get(v.img))) why = "img";
      else if (v.sceneId && !(canvas.tokens?.placeables ?? []).some((tk) => (v.tokens ?? []).includes(tk.document.id))) {
        why = "tokens";
      }
      if (!why) continue;
      problems.push({ id: v.id, why });
      const key = `${v.id}:${why}:${v.img ?? ""}`;
      if (this.#warned.has(key)) continue;
      this.#warned.add(key);
      console.warn(why === "img"
        ? `burn-cinema | безумие: облик «${v.name}» не применён — не загрузилась картинка ${v.img}`
        : `burn-cinema | безумие: облик «${v.name}» не применён — его токенов нет на сцене ${canvas.scene?.name ?? ""}`);
    }
    return problems;
  }

  /* ------------------------------ Цвет ------------------------------------ */

  #applyTint(tint) {
    const stage = canvas.stage ?? canvas.app?.stage;
    if (!stage) return;
    if (!tint) {
      if (this.#filter && Array.isArray(stage.filters)) {
        const rest = stage.filters.filter((f) => f !== this.#filter);
        stage.filters = rest.length ? rest : null;
      }
      return;
    }
    const Cls = globalThis.PIXI?.ColorMatrixFilter ?? globalThis.PIXI?.filters?.ColorMatrixFilter;
    if (!Cls) return;
    this.#filter ??= new Cls();
    const f = this.#filter;
    f.reset();
    if (tint.hue) f.hue(tint.hue, true);
    if (tint.saturation != null && tint.saturation !== 1) f.saturate(tint.saturation - 1, true);
    if (tint.brightness != null && tint.brightness !== 1) f.brightness(tint.brightness, true);
    const cur = stage.filters ?? [];
    if (!cur.includes(f)) stage.filters = [...cur, f];
  }

  /* ------------------------------ Звук ------------------------------------ */

  #playSound(v, loop) {
    const src = v.sound?.src;
    if (!src) return null;
    try {
      return foundry.audio.AudioHelper.play({
        src, volume: v.sound.volume ?? 0.8, loop, channel: "environment"
      }, false);
    } catch (err) {
      console.warn(`burn-cinema | безумие: звук ${src} не заиграл`, err);
      return null;
    }
  }

  /** Удерживаемые звуки звучат по кругу, пока видение держится. */
  #syncLoops(deck, wanted) {
    for (const [id, p] of this.#loops) {
      if (wanted.has(id)) continue;
      this.#loops.delete(id);
      Promise.resolve(p).then((s) => s?.stop?.()).catch(() => {});
    }
    for (const id of wanted) {
      if (this.#loops.has(id)) continue;
      const p = this.#playSound(deck.get(id), true);
      if (p) this.#loops.set(id, p);
    }
  }

  /* ------------------------------ Музыка ---------------------------------- */

  #syncMusic(t) {
    const m = t.music ?? {};
    const on = !this.stopped && m.enabled && m.track;
    const job = on
      ? startMadnessMusic(m.track, { isolate: m.isolate !== false, since: m.since ?? null })
      : stopMadnessMusic();
    Promise.resolve(job)
      .then(() => this.report())
      .catch((err) => console.warn("burn-cinema | безумие: музыка", err));
  }
}

export const engine = new VisionEngine();

// Трек безумия кончился сам (без изоляции его сменила общая музыка) — сказать ГМ.
onMadnessMusicChange(() => engine.report());
