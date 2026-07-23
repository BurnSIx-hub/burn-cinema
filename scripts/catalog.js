/**
 * 🔥 Cinema — картотека «киностудии» ГМа.
 * Контейнер объединяет бывшие модули: casting-call (casting/),
 * narrator-text (narrator/), epic-loading-screens (els/),
 * session-ratings (ratings/), npc-cards (npc/).
 * Код суб-модулей работает как раньше; настройки хранятся под старыми
 * namespace — миграция данных не нужна. Общий socket-канал module.burn-cinema
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
