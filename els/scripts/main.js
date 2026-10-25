/**
 * Epic Loading Screens — Foundry VTT v13/v14
 * v2.5.0
 */

// ═══════════════════════════════════════════════════════════════
//  НАСТРОЙКИ ПО УМОЛЧАНИЮ
// ═══════════════════════════════════════════════════════════════
const DEFAULT_MIN_SECS   = 1;
const DEFAULT_FADE_MS    = 800;
const DEFAULT_SHOW_TIPS  = true;
// Локализованный заголовок по умолчанию; вычисляется на момент показа (см. lang/*.json)
const defaultTipPrefix = () => game.i18n.localize("ELS.DefaultTipPrefix");
const SLIDE_MS           = 7000;
const STALL_MS           = 15000; // столько ждём canvasReady, потом смотрим, грузится ли ещё холст
const WATCH_MS           = 2000;  // шаг повторной проверки, пока холст грузится

const MODULE_ID = "epic-loading-screens";

// Локализация: строки в lang/ru.json и lang/en.json (ключи ELS.*)
const L  = (k)    => game.i18n.localize(`ELS.${k}`);
const LF = (k, d) => game.i18n.format(`ELS.${k}`, d);

// ═══════════════════════════════════════════════════════════════
//  IN-MEMORY КЭШ настроек
// ═══════════════════════════════════════════════════════════════
const _cache = {
  sections: null,
  bindings: null,

  getSections() {
    if (this.sections) return this.sections;
    try { this.sections = JSON.parse(game.settings.get(MODULE_ID, "sections") || "[]"); }
    catch { this.sections = []; }
    return this.sections;
  },

  getBindings() {
    if (this.bindings) return this.bindings;
    try { this.bindings = JSON.parse(game.settings.get(MODULE_ID, "bindings") || "{}"); }
    catch { this.bindings = {}; }
    return this.bindings;
  },

  invalidate() { this.sections = null; this.bindings = null; },
};

function getSections() { return _cache.getSections(); }
function getBindings() { return _cache.getBindings(); }

async function saveSections(sections) {
  _cache.sections = sections;
  await game.settings.set(MODULE_ID, "sections", JSON.stringify(sections));
}

async function saveBindings(b) {
  _cache.bindings = b;
  await game.settings.set(MODULE_ID, "bindings", JSON.stringify(b));
}

function uid() { return Math.random().toString(36).slice(2, 9); }

function getSectionForScene(scene) {
  const sections = getSections();
  if (!sections.length) return null;
  const sectionId = getBindings()[scene?.id];
  if (sectionId) {
    const found = sections.find(s => s.id === sectionId);
    if (found) return found;
  }
  return sections[0] ?? null;
}

// ═══════════════════════════════════════════════════════════════
//  КЭШ ИЗОБРАЖЕНИЙ
// ═══════════════════════════════════════════════════════════════
// Картинки качаются по одной и только пока холст не грузит сцену: у игроков
// они идут по тому же каналу до сервера ГМа, что и карта, и десятки мегабайт
// заставок, пущенные разом, отнимали у карты полосу.
const ELSCache = {
  _ready: new Set(),
  _queue: [],
  _busy:  false,
  _wait:  null,

  preloadAll() {
    const run = () => {
      this._queue = [...new Set(getSections().flatMap(s => s.images ?? []))];
      this._pump();
    };
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(run, { timeout: 5000 });
    } else {
      setTimeout(run, 1000);
    }
  },

  _pump() {
    if (this._busy || this._wait) return;
    while (this._queue.length && this._ready.has(this._queue[0])) this._queue.shift();
    if (!this._queue.length) return;
    if (canvas?.loading) {
      this._wait = setTimeout(() => { this._wait = null; this._pump(); }, WATCH_MS);
      return;
    }
    this._busy = true;
    this._one(this._queue.shift()).then(() => { this._busy = false; this._pump(); });
  },

  _one(url) {
    return new Promise(resolve => {
      if (!url || this._ready.has(url)) return resolve();
      const img = new Image();
      img.onload  = () => { this._ready.add(url); resolve(); };
      img.onerror = () => resolve();
      img.src = url;
    });
  },

  has(url) { return this._ready.has(url); },
};

// ═══════════════════════════════════════════════════════════════
//  OVERLAY
// ═══════════════════════════════════════════════════════════════
const ELS = {
  overlay: null, bg: null, bgNext: null,
  spinner: null, sceneName: null,
  tipsBar: null, tipPrefix: null, tipText: null,
  progressBar: null, stallLabel: null,

  _ready:        false,
  _minDone:      false,
  _stalled:      false,
  _stopCycleFn:  null,
  _cycleTimer:   null,
  _minTimer:     null,
  _cleanupTimer: null,
  _fallbackTimer: null,

  _build() {
    if (document.getElementById("els-loading-overlay")) {
      this.overlay    = document.getElementById("els-loading-overlay");
      this.bg         = document.getElementById("els-bg");
      this.bgNext     = document.getElementById("els-bg-next");
      this.spinner    = document.getElementById("els-spinner");
      this.sceneName  = document.getElementById("els-scene-name");
      this.tipsBar    = document.getElementById("els-tips-bar");
      this.tipPrefix  = document.querySelector(".els-tip-prefix");
      this.tipText    = document.querySelector(".els-tip-text");
      this.progressBar = document.getElementById("els-progress-fill");
      this.stallLabel = document.querySelector(".els-stall-label");
      return;
    }
    const el = document.createElement("div");
    el.id = "els-loading-overlay";
    el.innerHTML = `
      <div id="els-bg"></div>
      <div id="els-bg-next"></div>
      <div id="els-spinner">
        <div class="els-spinner-ring"></div>
        <div class="els-spinner-label">${L("Loading")}</div>
        <div class="els-stall-label"></div>
      </div>
      <div id="els-scene-name"></div>
      <div id="els-tips-bar">
        <div class="els-tip-prefix"></div>
        <div class="els-tip-text"></div>
      </div>
      <div id="els-progress-bar">
        <div id="els-progress-fill"></div>
      </div>`;
    document.body.appendChild(el);
    this.overlay     = el;
    this.bg          = el.querySelector("#els-bg");
    this.bgNext      = el.querySelector("#els-bg-next");
    this.spinner     = el.querySelector("#els-spinner");
    this.sceneName   = el.querySelector("#els-scene-name");
    this.tipsBar     = el.querySelector("#els-tips-bar");
    this.tipPrefix   = el.querySelector(".els-tip-prefix");
    this.tipText     = el.querySelector(".els-tip-text");
    this.progressBar = el.querySelector("#els-progress-fill");
    this.stallLabel  = el.querySelector(".els-stall-label");
    // Долгая загрузка: щелчок убирает экран, чтобы игрок добрался до чата
    el.addEventListener("click", () => { if (this._stalled) this._hide(); });
  },

  show(scene) {
    this._build();
    this._ready   = false;
    this._minDone = false;
    this._stopCycle();

    // Таймеры прошлого показа: его минимальный таймер скрывал новый оверлей
    // раньше времени, а отложенная очистка после скрытия стирала новый фон
    clearTimeout(this._minTimer);
    clearTimeout(this._cleanupTimer);
    clearTimeout(this._fallbackTimer);
    this._fallbackTimer = null;
    this._setStalled(false);

    const section  = getSectionForScene(scene);
    const fadeMs   = game.settings.get(MODULE_ID, "fadeMs")   ?? DEFAULT_FADE_MS;
    const minSecs  = game.settings.get(MODULE_ID, "minSecs")  ?? DEFAULT_MIN_SECS;
    const showTips = game.settings.get(MODULE_ID, "showTips") ?? DEFAULT_SHOW_TIPS;
    const images   = section?.images ?? [];
    const tips     = showTips ? (section?.tips ?? []) : [];

    this.overlay.style.setProperty("--els-fade", `${fadeMs}ms`);
    this.overlay.classList.add("els-visible");
    requestAnimationFrame(() => this.spinner?.classList.add("els-spinner-visible"));

    // Название сцены
    const name = scene?.name ?? "";
    if (this.sceneName) {
      this.sceneName.textContent = name;
      this.sceneName.classList.toggle("els-name-visible", !!name);
    }

    // Записи ГМ
    if (tips.length && this.tipPrefix) {
      this.tipPrefix.textContent = section?.prefix?.trim()
        || game.settings.get(MODULE_ID, "tipPrefix")
        || defaultTipPrefix();
      this.tipsBar?.classList.add("els-tips-visible");
    } else {
      this.tipsBar?.classList.remove("els-tips-visible");
    }

    this._startProgress(minSecs);
    this._startCycle(images, tips, fadeMs);

    // Минимальный таймер
    this._minTimer = setTimeout(() => { this._minDone = true; this._tryHide(); }, minSecs * 1000);

    this._fallbackTimer = setTimeout(() => this._watch(), STALL_MS);
  },

  // Сторож на случай, когда canvasReady не приходит. Раньше через 15 сек оверлей
  // скрывался безусловно, а большая карта у игрока на медленной связи грузится
  // дольше: под оверлеем оказывался снимок прошлой сцены, который Foundry v14
  // держит до конца загрузки, — выглядело как зависание до F5. Теперь, пока
  // холст грузится, оверлей стоит; скрываем, только если загрузки нет вовсе
  // (активировали уже открытую сцену, сцену удалили, отрисовка упала).
  _watch() {
    this._fallbackTimer = null;
    if (!this.overlay?.classList.contains("els-visible")) return;
    if (canvas?.loading || _catchUpTimer || _catchUp()) {
      this._setStalled(true);
      this._fallbackTimer = setTimeout(() => this._watch(), WATCH_MS);
      return;
    }
    console.warn("[ELS] Fallback: принудительное скрытие оверлея (canvasReady не пришёл)");
    this._hide();
  },

  _setStalled(on) {
    this._stalled = on;
    this.overlay?.classList.toggle("els-stalled", on);
    if (on && this.stallLabel) this.stallLabel.textContent = L("StillLoading");
  },

  // ── Цикл слайдов (случайный порядок) ─────────────────────
  _startCycle(images, tips, fadeMs) {
    const shuffle = (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // Скачанные — вперёд: первая картинка покажется сразу и не будет делить канал с картой
    const imgs = shuffle(images).sort((a, b) => ELSCache.has(b) - ELSCache.has(a));
    const tps  = shuffle(tips);
    let idx    = 0;
    let active = true;
    this._stopCycleFn = () => { active = false; };

    const show = (i, first) => {
      if (!active) return;
      const img = imgs.length ? imgs[i % imgs.length] : null;
      const tip = tps.length  ? tps[i  % tps.length]  : null;

      if (img && (imgs.length > 1 || first)) {
        first ? this._setBg(this.bg, img, true) : this._crossfade(img, fadeMs);
      }

      if (tip !== null) {
        this.tipText?.classList.remove("els-tip-show");
        setTimeout(() => {
          if (!active || !this.tipText) return;
          this.tipText.innerHTML = tip;
          this.tipText.classList.add("els-tip-show");
        }, first ? 350 : fadeMs * 0.6);
      }
    };

    show(0, true);

    if (imgs.length > 1 || tps.length > 1) {
      const tick = () => {
        if (!active) return;
        this._cycleTimer = setTimeout(() => {
          if (!active) return;
          idx++;
          if (imgs.length > 1 && idx % imgs.length === 0) imgs.sort(() => Math.random() - 0.5);
          if (tps.length  > 1 && idx % tps.length  === 0) tps.sort(() => Math.random() - 0.5);
          show(idx, false);
          tick();
        }, SLIDE_MS);
      };
      tick();
    }
  },

  _stopCycle() {
    if (this._stopCycleFn) { this._stopCycleFn(); this._stopCycleFn = null; }
    if (this._cycleTimer)  { clearTimeout(this._cycleTimer); this._cycleTimer = null; }
  },

  // ── Работа с фоном ────────────────────────────────────────
  _setBg(el, src, fade) {
    if (!el) return;
    const apply = () => {
      el.style.backgroundImage = `url("${src}")`;
      if (fade) requestAnimationFrame(() =>
        requestAnimationFrame(() => el.classList.add("els-bg-visible"))
      );
    };
    if (ELSCache.has(src)) { apply(); return; }
    const img = new Image();
    img.onload  = () => { ELSCache._ready.add(src); apply(); };
    img.onerror = () => console.warn(`[ELS] Не удалось загрузить: ${src}`);
    img.src = src;
  },

  _crossfade(src, fadeMs) {
    const curr = this.bg;
    const next = this.bgNext;
    if (!curr || !next) return;
    // Посреди загрузки сцены не докачиваем: листаем только то, что уже есть
    if (!ELSCache.has(src)) return;

    const swap = () => {
      // Ставим картинку пока next скрыт (opacity:0)
      next.style.backgroundImage = `url("${src}")`;
      // Два rAF гарантируют что браузер применил backgroundImage до анимации
      requestAnimationFrame(() => requestAnimationFrame(() => {
        next.style.transition = `opacity ${fadeMs}ms ease`;
        next.style.opacity = "1";
        setTimeout(() => {
          // curr подхватывает картинку — next убирается мгновенно (без transition)
          curr.style.backgroundImage = `url("${src}")`;
          next.style.transition = "none";
          next.style.opacity = "0";
          next.style.backgroundImage = "";
        }, fadeMs + 50);
      }));
    };

    swap();
  },

  // ── Прогресс-бар ──────────────────────────────────────────
  _startProgress(minSecs) {
    const pb = this.progressBar;
    if (!pb) return;
    pb.style.transition = "none";
    pb.style.width = "0%";
    requestAnimationFrame(() => {
      const dur = Math.max(minSecs * 1000, 800);
      pb.style.transition = `width ${dur}ms cubic-bezier(0.05, 0.1, 0.25, 1)`;
      pb.style.width = "75%";
    });
  },

  _finishProgress() {
    const pb = this.progressBar;
    if (!pb) return;
    pb.style.transition = "width 300ms ease-out";
    pb.style.width = "100%";
  },

  // ── Скрытие ───────────────────────────────────────────────
  onSceneReady() {
    this._ready = true;
    this._finishProgress();
    setTimeout(() => this._tryHide(), 350);
  },

  _tryHide() {
    if (this._ready && this._minDone) this._hide();
  },

  _hide() {
    this._stopCycle();
    if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
    if (!this.overlay) return;
    this._setStalled(false);
    this.spinner?.classList.remove("els-spinner-visible");
    this.tipsBar?.classList.remove("els-tips-visible");
    this.sceneName?.classList.remove("els-name-visible");
    this.overlay.classList.remove("els-visible");
    this._cleanupTimer = setTimeout(() => {
      if (this.bg)     { this.bg.classList.remove("els-bg-visible"); this.bg.style.backgroundImage = ""; }
      if (this.bgNext) { this.bgNext.style.transition = "none"; this.bgNext.style.opacity = "0"; this.bgNext.style.backgroundImage = ""; }
      if (this.tipText)  this.tipText.classList.remove("els-tip-show");
      if (this.progressBar) { this.progressBar.style.transition = "none"; this.progressBar.style.width = "0%"; }
    }, 600);
  },
};

// ═══════════════════════════════════════════════════════════════
//  ГЛАВНОЕ ОКНО НАСТРОЕК
// ═══════════════════════════════════════════════════════════════
class ELSSectionsApp extends foundry.applications.api.ApplicationV2 {
  constructor(options = {}) { super(options); this._tab = "sections"; }

  static DEFAULT_OPTIONS = {
    id:  "els-sections-app",
    tag: "div",
    window: { title: "Epic Loading Screens", icon: "fas fa-layer-group" },
    position: { width: 780, height: 620 },
    actions: {
      switchTab:     ELSSectionsApp._onSwitchTab,
      addSection:    ELSSectionsApp._onAddSection,
      deleteSection: ELSSectionsApp._onDeleteSection,
      editSection:   ELSSectionsApp._onEditSection,
      saveBindings:  ELSSectionsApp._onSaveBindings,
      saveGlobal:    ELSSectionsApp._onSaveGlobal,
    },
  };

  _renderSectionsTab() {
    const sections = getSections();
    const rows = sections.length
      ? sections.map(sec => `
          <div class="els-sec-row" data-id="${sec.id}">
            <div class="els-sec-preview">
              ${sec.images?.[0]
                ? `<img src="${sec.images[0]}" onerror="this.style.opacity='0.2'" />`
                : `<div class="els-sec-no-img"><i class="fas fa-image"></i></div>`}
            </div>
            <div class="els-sec-info">
              <div class="els-sec-name">${sec.name || L("Untitled")}</div>
              <div class="els-sec-meta">
                <span><i class="fas fa-images"></i> ${LF("ImagesCount", { n: sec.images?.length ?? 0 })}</span>
                <span><i class="fas fa-scroll"></i> ${LF("TipsCount", { n: sec.tips?.length ?? 0 })}</span>
              </div>
            </div>
            <div class="els-sec-actions">
              <button data-action="editSection" data-id="${sec.id}">
                <i class="fas fa-edit"></i> ${L("Edit")}
              </button>
              <button data-action="deleteSection" data-id="${sec.id}" class="els-btn-danger">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>`).join("")
      : `<div class="els-empty"><i class="fas fa-layer-group"></i><p>${L("NoSections")}</p></div>`;

    return `
      <div class="els-tab-toolbar">
        <button data-action="addSection" class="els-btn-add">
          <i class="fas fa-plus"></i> ${L("AddSection")}
        </button>
      </div>
      <div class="els-tab-body" id="els-sections-list">${rows}</div>`;
  }

  _renderBindingsTab() {
    const sections = getSections();
    const bindings = getBindings();
    const scenes   = game.scenes?.contents ?? [];

    if (!sections.length) return `
      <div class="els-empty" style="padding:40px">
        <i class="fas fa-exclamation-circle"></i>
        <p>${L("CreateSectionFirst")}</p>
      </div>`;

    const rows = scenes.map(sc => {
      const bound = bindings[sc.id] ?? "";
      const opts  = [
        `<option value="">${L("FirstByDefault")}</option>`,
        ...sections.map(s =>
          `<option value="${s.id}" ${bound === s.id ? "selected" : ""}>${s.name}</option>`),
      ].join("");
      const thumb = sc.thumb
        ? `<img class="els-scene-thumb" src="${sc.thumb}" onerror="this.style.display='none'" />`
        : `<div class="els-scene-thumb els-sec-no-img"><i class="fas fa-map"></i></div>`;
      return `
        <div class="els-bind-row">
          ${thumb}
          <span class="els-bind-name" title="${sc.name}">${sc.name}</span>
          <select class="els-bind-select" data-scene-id="${sc.id}">${opts}</select>
        </div>`;
    }).join("");

    return `
      <div class="els-tab-toolbar">
        <span class="els-tab-hint"><i class="fas fa-info-circle"></i> ${L("BindingsHint")}</span>
        <button data-action="saveBindings" class="els-btn-save" style="margin-left:auto">
          <i class="fas fa-save"></i> ${L("SaveBindings")}
        </button>
      </div>
      <div class="els-tab-body">${rows || `<div class="els-empty"><p>${L("NoScenes")}</p></div>`}</div>`;
  }

  _renderParamsTab() {
    const fadeMs   = game.settings.get(MODULE_ID, "fadeMs")    ?? DEFAULT_FADE_MS;
    const minSecs  = game.settings.get(MODULE_ID, "minSecs")   ?? DEFAULT_MIN_SECS;
    const showTips = game.settings.get(MODULE_ID, "showTips")  ?? DEFAULT_SHOW_TIPS;
    const prefix   = game.settings.get(MODULE_ID, "tipPrefix") || defaultTipPrefix();

    return `
      <div class="els-tab-body" style="padding:18px 22px">
        <div class="els-field-row">
          <label>${L("TipPrefixLabel")}</label>
          <input id="g-prefix" type="text" value="${prefix}" />
        </div>
        <div class="els-field-row">
          <label>${L("MinTime")}</label>
          <input id="g-min-secs" type="number" value="${minSecs}" min="0" max="30" step="0.5" />
        </div>
        <div class="els-field-row">
          <label>${L("FadeSpeed")}</label>
          <input id="g-fade-ms" type="number" value="${fadeMs}" min="100" max="3000" step="100" />
        </div>
        <label class="els-checkbox-row">
          <input id="g-show-tips" type="checkbox" ${showTips ? "checked" : ""} />
          ${L("ShowTips")}
        </label>
        <div style="margin-top:18px;display:flex;justify-content:flex-end">
          <button data-action="saveGlobal" class="els-btn-save">
            <i class="fas fa-save"></i> ${L("Save")}
          </button>
        </div>
      </div>`;
  }

  async _renderHTML(context, options) {
    const tabs = [
      { id: "sections", icon: "fas fa-layer-group", label: L("TabSections") },
      { id: "bindings", icon: "fas fa-link",         label: L("TabBindings") },
      { id: "params",   icon: "fas fa-sliders-h",    label: L("TabParams")   },
    ];
    const nav = tabs.map(t => `
      <button class="els-tab-btn ${this._tab === t.id ? "active" : ""}"
              data-action="switchTab" data-tab="${t.id}">
        <i class="${t.icon}"></i> ${t.label}
      </button>`).join("");

    let body = "";
    if (this._tab === "sections") body = this._renderSectionsTab();
    if (this._tab === "bindings") body = this._renderBindingsTab();
    if (this._tab === "params")   body = this._renderParamsTab();

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="els-config-wrap">
        <nav class="els-tabs-nav">${nav}</nav>
        <div class="els-tab-content">${body}</div>
      </div>`;
    return wrap;
  }

  _replaceHTML(result, content, options) { content.replaceChildren(...result.childNodes); }

  static _onSwitchTab(e, t) { this._tab = t.dataset.tab; this.render({ force: true }); }

  static async _onAddSection() {
    const sections = getSections();
    const s = { id: uid(), name: L("NewSection"), images: [], tips: [], prefix: "" };
    sections.push(s);
    await saveSections(sections);
    new ELSSectionEditApp(s.id, this).render({ force: true });
  }

  static async _onDeleteSection(e, t) {
    const id = t.dataset.id;
    const b = getBindings();
    for (const k of Object.keys(b)) if (b[k] === id) delete b[k];
    await saveBindings(b);
    await saveSections(getSections().filter(s => s.id !== id));
    this.render({ force: true });
  }

  static _onEditSection(e, t) {
    new ELSSectionEditApp(t.dataset.id, this).render({ force: true });
  }

  static async _onSaveBindings() {
    const b = {};
    this.element.querySelectorAll(".els-bind-select").forEach(sel => {
      if (sel.value) b[sel.dataset.sceneId] = sel.value;
    });
    await saveBindings(b);
    ui.notifications.info(L("BindingsSaved"));
  }

  static async _onSaveGlobal() {
    const root = this.element;
    await game.settings.set(MODULE_ID, "tipPrefix", root.querySelector("#g-prefix")?.value    || "");
    await game.settings.set(MODULE_ID, "minSecs",   Number(root.querySelector("#g-min-secs")?.value) || DEFAULT_MIN_SECS);
    await game.settings.set(MODULE_ID, "fadeMs",    Number(root.querySelector("#g-fade-ms")?.value)  || DEFAULT_FADE_MS);
    await game.settings.set(MODULE_ID, "showTips",  !!root.querySelector("#g-show-tips")?.checked);
    ui.notifications.info(L("ParamsSaved"));
  }
}

// ═══════════════════════════════════════════════════════════════
//  РЕДАКТОР СЕКЦИИ
// ═══════════════════════════════════════════════════════════════
class ELSSectionEditApp extends foundry.applications.api.ApplicationV2 {
  constructor(sectionId, parentApp) { super(); this.sectionId = sectionId; this.parentApp = parentApp; }

  static DEFAULT_OPTIONS = {
    id:  "els-section-edit",
    tag: "div",
    window: { title: "ELS.EditSection", icon: "fas fa-edit" },
    position: { width: 660, height: "auto" },
    actions: {
      addImage:    ELSSectionEditApp._onAddImage,
      removeImage: ELSSectionEditApp._onRemoveImage,
      save:        ELSSectionEditApp._onSave,
    },
  };

  _sec() { return getSections().find(s => s.id === this.sectionId) ?? null; }

  async _renderHTML(context, options) {
    const sec = this._sec();
    if (!sec) return document.createElement("div");

    const imgRows = sec.images?.length
      ? sec.images.map((src, i) => `
          <div class="els-img-row" data-index="${i}">
            <img class="els-img-thumb" src="${src}" onerror="this.style.opacity='0.2'" />
            <span class="els-img-path" title="${src}">${src}</span>
            <button type="button" data-action="removeImage" data-index="${i}">
              <i class="fas fa-trash"></i>
            </button>
          </div>`).join("")
      : `<div class="els-empty-small">${L("NoImages")}</div>`;

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="els-config-wrap">
        <section class="els-section">
          <h3><i class="fas fa-tag"></i> ${L("SectionName")}</h3>
          <input id="els-sec-name" type="text" value="${sec.name ?? ""}" placeholder="${L("SectionNamePlaceholder")}" />
        </section>
        <section class="els-section">
          <h3><i class="fas fa-images"></i> ${L("ImagesHeader")}</h3>
          <p class="els-hint">${L("ImagesHint")}</p>
          <div id="els-img-list">${imgRows}</div>
          <button type="button" data-action="addImage" class="els-btn-add">
            <i class="fas fa-plus"></i> ${L("AddImage")}
          </button>
        </section>
        <section class="els-section">
          <h3><i class="fas fa-scroll"></i> ${L("TipsHeader")}</h3>
          <p class="els-hint">${L("TipsHint")}</p>
          <div class="els-field-row">
            <label>${L("TipPrefixShort")}</label>
            <input id="els-sec-prefix" type="text" value="${sec.prefix ?? ""}" placeholder="${L("DefaultTipPrefix")}" />
          </div>
          <textarea id="els-sec-tips" rows="7" placeholder="${L("TipsPlaceholder")}">${(sec.tips ?? []).join("\n")}</textarea>
        </section>
        <div class="els-footer">
          <button type="button" data-action="save" class="els-btn-save">
            <i class="fas fa-save"></i> ${L("Save")}
          </button>
        </div>
      </div>`;
    return wrap;
  }

  _replaceHTML(result, content, options) { content.replaceChildren(...result.childNodes); }

  static async _onAddImage(e, t) {
    const app = this;
    new FilePicker({
      type: "image", current: "",
      callback: async (path) => {
        if (!path) return;
        const sections = getSections();
        const sec = sections.find(s => s.id === app.sectionId);
        if (!sec) return;
        if (sec.images?.includes(path)) { ui.notifications.warn(L("AlreadyAdded")); return; }
        (sec.images ??= []).push(path);
        await saveSections(sections);
        app.render({ force: true });
      },
    }).render(true);
  }

  static async _onRemoveImage(e, t) {
    const sections = getSections();
    const sec = sections.find(s => s.id === this.sectionId);
    if (!sec) return;
    sec.images.splice(Number(t.dataset.index), 1);
    await saveSections(sections);
    this.render({ force: true });
  }

  static async _onSave(e, t) {
    const root = this.element;
    const sections = getSections();
    const sec = sections.find(s => s.id === this.sectionId);
    if (!sec) return;
    sec.name   = root.querySelector("#els-sec-name")?.value?.trim()   || L("Untitled");
    sec.prefix = root.querySelector("#els-sec-prefix")?.value?.trim() || "";
    sec.tips   = (root.querySelector("#els-sec-tips")?.value || "")
      .split("\n").map(s => s.trim()).filter(Boolean);
    await saveSections(sections);
    ui.notifications.info(LF("SectionSaved", { name: sec.name }));
    this.parentApp?.render({ force: true });
    this.close();
  }
}

// ═══════════════════════════════════════════════════════════════
//  РЕГИСТРАЦИЯ + ХУКИ
// ═══════════════════════════════════════════════════════════════
Hooks.once("init", () => {
  const reg = (key, type, def, onChange) => game.settings.register(MODULE_ID, key,
    { scope: "world", config: false, type, default: def, onChange });

  // ГМ правит секции посреди игры — у игроков кэш сбрасывается, иначе старые до F5
  reg("sections",  String,  "[]", () => { _cache.sections = null; ELSCache.preloadAll(); });
  reg("bindings",  String,  "{}", () => { _cache.bindings = null; });
  reg("tipPrefix", String,  ""); // пусто = локализованный заголовок по умолчанию
  reg("fadeMs",    Number,  DEFAULT_FADE_MS);
  reg("minSecs",   Number,  DEFAULT_MIN_SECS);
  reg("showTips",  Boolean, DEFAULT_SHOW_TIPS);

  game.settings.registerMenu(MODULE_ID, "sectionsMenu", {
    name: "ELS.ModuleName", label: "ELS.MenuLabel",
    hint: "ELS.MenuHint",
    icon: "fas fa-layer-group", type: ELSSectionsApp, restricted: true,
  });

  console.log("%c[ELS]%c v2.5.0 init (v13/v14)", "color:#c9a84c;font-weight:bold", "color:#888");
});

Hooks.once("ready", () => {
  ELS._build();
  ELSCache.preloadAll();
  // Запомнить стартовую сцену чтобы canvasTearDown не сработал как "смена" при смене уровня
  _activeSceneId = canvas?.scene?.id ?? game.scenes?.active?.id ?? null;
  console.log("%c[ELS]%c ready", "color:#c9a84c;font-weight:bold", "color:#888");
});

// ── Кнопка на панели инструментов ────────────────────────────
// v14 сохраняет ту же object-based структуру что и v13
Hooks.on("getSceneControlButtons", (controls) => {
  if (game.modules.get("burnhub")?.active) return; // с BurnHub кнопка в папке 🔥 Burn
  if (!game.user?.isGM) return; // без BurnHub — своя кнопка (как раньше, только ГМ)
  controls["epic-loading-screens"] = {
    name:    "epic-loading-screens",
    title:   "Epic Loading Screens",
    icon:    "fas fa-photo-film",
    visible: true,
    order:   99,
    tools: {
      open: {
        name:    "open",
        title:   "ELS.MenuLabel",
        icon:    "fas fa-photo-film",
        button:  true,
        visible: true,
        onClick: () => new ELSSectionsApp().render({ force: true }),
      },
    },
  };
});

// ── Хуки загрузки сцены ───────────────────────────────────────

// ID активной сцены. При смене уровня он НЕ меняется — при смене сцены меняется.
// Инициализируется в Hooks.once("ready") выше.
let _activeSceneId = null;

// Scene#view не переключает сцену, пока холст грузит прошлую (canvas.loading), —
// только предупреждает. ГМ сменил карту, пока игрок ещё грузил предыдущую, —
// игрок оставался на старой до F5. Запоминаем отказ и догоняем активную сцену,
// когда холст освободится.
let _catchUpPending = false;
let _catchUpTimer   = null;

// true — догон начат, оверлей должен остаться
function _catchUp() {
  if (!_catchUpPending) return false;
  _catchUpPending = false;
  const target = game.scenes?.active;
  if (!target || canvas?.scene?.id === target.id) return false;
  console.warn(`[ELS] Foundry отклонил переход на «${target.name}», пока грузилась прошлая сцена — догоняем`);
  const attempt = () => {
    _catchUpTimer = null;
    const scene = game.scenes?.active;
    if (!scene || canvas?.scene?.id === scene.id) return ELS.onSceneReady();
    if (canvas?.loading) { _catchUpTimer = setTimeout(attempt, 100); return; }
    if (!ELS.overlay?.classList.contains("els-visible")) ELS.show(scene);
    scene.view();
  };
  // canvasReady приходит раньше, чем Foundry снимает canvas.loading, —
  // попытка уйдёт на следующий шаг таймера
  attempt();
  return true;
}

// updateScene active:true — единственный надёжный сигнал смены сцены.
// Здесь сразу обновляем _activeSceneId и показываем оверлей.
Hooks.on("updateScene", (scene, changes) => {
  if (!changes.active) return;

  // Если canvas уже показывает эту сцену и готов — смысла в оверлее нет.
  // Это случай "активировать уже просматриваемую сцену" или повторная активация.
  if (canvas?.scene?.id === scene.id && canvas?.ready) {
    _activeSceneId = scene.id;
    return;
  }

  _activeSceneId = scene.id;
  // Хуки update* идут раньше, чем Foundry вызывает Scene#view, — отказ виден здесь
  if (canvas?.loading) _catchUpPending = true;
  ELS.show(scene);
});

// canvasTearDown — резервный хук на случай если updateScene пропустили.
// Смена уровня тоже вызывает canvasTearDown, но canvas.scene.id остаётся прежним.
// Поэтому показываем оверлей ТОЛЬКО если scene ID изменился.
Hooks.on("canvasTearDown", () => {
  if (ELS.overlay?.classList.contains("els-visible")) return;

  const nextId = game.scenes?.active?.id ?? null;
  if (!nextId) return;

  // Та же сцена — смена уровня, пропускаем
  if (nextId === _activeSceneId) return;

  _activeSceneId = nextId;
  ELS.show(game.scenes?.active ?? null);
});

// canvasReady — скрываем оверлей.
// Срабатывает и после смены сцены, и после смены уровня —
// но если оверлей не показан (смена уровня), _hide() не вызовется.
// Если догрузилась не та сцена (переход был отклонён) — оверлей остаётся до нужной.
Hooks.on("canvasReady", () => {
  if (_catchUp()) return;
  ELS.onSceneReady();
});

window.ELS = ELS;

// ─── Экспорт для картотеки Cinema (scripts/catalog.js) ───
Hooks.once("ready", () => {
  (game.burnCinema ??= {}).openScreens = () => new ELSSectionsApp().render({ force: true });
});
