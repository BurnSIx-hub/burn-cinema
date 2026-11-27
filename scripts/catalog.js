/**
 * 🔥 Cinema — картотека «киностудии» ГМа.
 * Контейнер объединяет бывшие модули: casting-call (casting/),
 * narrator-text (narrator/), epic-loading-screens (els/),
 * session-ratings (ratings/), npc-cards (npc/).
 * Код суб-модулей работает как раньше; настройки хранятся под старыми
 * namespace — миграция данных не нужна; в «Настройках» они собраны под
 * 🔥 Cinema (см. categorizeEntry). Общий socket-канал module.burn-cinema
 * (сообщения различаются полем type, коллизий нет).
 */

const { ApplicationV2 } = foundry.applications.api;

const CARDS = [
  {
    id: "casting",
    title: "Casting Call",
    sub: "Кастинг: раздача персонажей по сценам",
    icon: "fa-solid fa-masks-theater",
    run: () => game.burnCinema?.openCasting?.()
  },
  {
    id: "narrator",
    title: "Narrator",
    sub: "Текст нарратора на весь экран",
    icon: "fa-solid fa-scroll",
    gmOnly: true,
    run: () => game.burnCinema?.openNarrator?.()
  },
  {
    id: "screens",
    title: "Loading Screens",
    sub: "Эпичные загрузочные экраны между сценами",
    icon: "fa-solid fa-photo-film",
    gmOnly: true,
    run: () => game.burnCinema?.openScreens?.()
  },
  {
    id: "ratings",
    title: "Session Ratings",
    sub: "IMDB кампании: оценки глав игроками",
    icon: "fa-solid fa-clapperboard",
    run: () => game.burnCinema?.openRatings?.()
  },
  {
    id: "npc",
    title: "NPC Cards",
    sub: "Карточки NPC: показ и раздача игрокам",
    icon: "fa-solid fa-id-card",
    run: () => game.burnCinema?.openNpc?.()
  },
  {
    id: "madness",
    title: "Восприятие безумия",
    sub: "Колода видений для игрока: облик, призраки, пропажи",
    icon: "fa-solid fa-brain",
    gmOnly: true,
    run: () => game.burnCinema?.openMadness?.()
  },
  {
    id: "inspect",
    title: "Осмотр предметов",
    sub: "Зоны на карте: лупа, подсветка и плашка с текстом",
    icon: "fa-solid fa-magnifying-glass",
    gmOnly: true,
    run: () => game.burnCinema?.openInspect?.()
  }
];

class CinemaCatalog extends ApplicationV2 {
  static #instance = null;

  static DEFAULT_OPTIONS = {
    id: "burn-cinema-catalog",
    classes: ["burncat"],
    window: { title: "🔥 Cinema", icon: "fa-solid fa-film" },
    position: { width: 440, height: "auto" }
  };

  static open() {
    this.#instance ??= new CinemaCatalog();
    this.#instance.render({ force: true });
  }

  async _renderHTML() {
    return CARDS.filter((c) => !c.gmOnly || game.user.isGM).map((c) => `
      <button type="button" class="burncat-card" data-card="${c.id}">
        <i class="burncat-icon ${c.icon}"></i>
        <span class="burncat-text">
          <span class="burncat-title">${c.title}</span>
          <span class="burncat-sub">${c.sub}</span>
        </span>
        <i class="burncat-go fa-solid fa-chevron-right"></i>
      </button>`).join("");
  }

  _replaceHTML(result, content) {
    content.innerHTML = `<div class="burncat-list">${result}</div>`;
    content.querySelectorAll(".burncat-card").forEach((el) => {
      el.addEventListener("click", () => {
        const card = CARDS.find((c) => c.id === el.dataset.card);
        try {
          card?.run();
        } catch (err) {
          console.error("burn-cinema | карточка упала:", err);
          ui.notifications.error(`Cinema: «${card?.title}» — ошибка (см. консоль)`);
        }
      });
    });
  }
}

/* ------------------------- Раздел в «Настройках» -------------------------- */

// Foundry раскладывает настройки по модулю, чей id совпадает с namespace.
// Старых модулей больше нет, и настройки суб-модулей падали в «Не назначено».
const LEGACY_NS = new Set([
  "casting-call", "narrator-text", "epic-loading-screens", "session-ratings", "npc-cards"
]);

function categorizeEntry(wrapped, namespace, ...args) {
  // Исходный метод зовём всегда: обёртку WRAPPER, которая не передаёт вызов
  // дальше, libWrapper снимает.
  const category = wrapped(namespace, ...args);
  const cinema = LEGACY_NS.has(namespace) ? game.modules.get("burn-cinema") : null;
  return cinema ? { id: cinema.id, label: cinema.title } : category;
}

Hooks.once("setup", () => {
  const path = "foundry.applications.settings.SettingsConfig.prototype._categorizeEntry";
  const proto = foundry.applications.settings?.SettingsConfig?.prototype;
  if (typeof proto?._categorizeEntry !== "function") {
    console.warn("burn-cinema | нет SettingsConfig#_categorizeEntry — настройки останутся в «Не назначено»");
    return;
  }
  try {
    if (globalThis.libWrapper) libWrapper.register("burn-cinema", path, categorizeEntry, "WRAPPER");
    else {
      const original = proto._categorizeEntry;
      proto._categorizeEntry = function (...args) { return categorizeEntry.call(this, original.bind(this), ...args); };
    }
  } catch (err) {
    console.error("burn-cinema | не удалось собрать настройки под 🔥 Cinema", err);
  }
});

// Каждая карточка — отдельная плитка в папке 🔥 Burn (плоский список).
// Окно-картотека CinemaCatalog оставлено в коде на будущее, но напрямую
// в папку кладём индивидуальные действия.
Hooks.once("ready", () => {
  CARDS.forEach((c, i) => {
    Hooks.callAll("hubRegisterTile", {
      moduleId: `cinema-${c.id}`,
      title: c.title,
      icon: c.icon,
      order: 30 + i,
      gmOnly: c.gmOnly,
      onClick: c.run
    });
  });
});
