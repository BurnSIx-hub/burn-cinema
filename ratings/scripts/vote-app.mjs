/** Player-facing rating dialog (ApplicationV2). One chapter, N criteria × 10 stars. */

import { MODULE_ID, getChapter, i18n, MAX_SCORE, mean, fmtScore, getMyVote, setMyVote } from "./store.mjs";
import { sendVote } from "./socket.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class VoteApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "session-ratings-vote",
    tag: "form",
    classes: ["session-ratings", "session-ratings-vote"],
    window: {
      title: "session-ratings.Vote.Title",
      icon: "fa-solid fa-star"
    },
    position: { width: 460 },
    form: {
      handler: VoteApp.#onSubmit,
      closeOnSubmit: false, // we close manually so an incomplete vote stays open
      submitOnChange: false
    },
    actions: {
      cancel: VoteApp.#onCancel
    }
  };

  static PARTS = {
    form: { template: "modules/burn-cinema/ratings/templates/vote.hbs" }
  };

  constructor(chapterId, options = {}) {
    super(options);
    this.chapterId = chapterId;
    /** @type {Record<string, number>} criterion label → chosen 1..10 */
    this.scores = {};
  }

  /** Only one vote dialog at a time, keyed per chapter. */
  static current = null;

  static open(chapterId) {
    const ch = getChapter(chapterId);
    if (!ch) return;
    if (VoteApp.current && !VoteApp.current.rendered) VoteApp.current = null;
    if (VoteApp.current) {
      if (VoteApp.current.chapterId === chapterId) {
        VoteApp.current.bringToFront?.();
        return VoteApp.current;
      }
      VoteApp.current.close();
    }
    const app = new VoteApp(chapterId);
    VoteApp.current = app;
    app.render(true);
    return app;
  }

  async _prepareContext() {
    const ch = getChapter(this.chapterId);
    // Preload this player's previous vote (kept privately in this browser).
    const prev = getMyVote(this.chapterId) ?? {};
    this.scores = { ...prev };
    return {
      title: ch?.title ?? "",
      number: ch?.number ?? 0,
      poster: ch?.poster || "",
      description: ch?.description || "",
      criteria: (ch?.criteria ?? []).map((label) => ({ label, value: prev[label] ?? 0 })),
      max: MAX_SCORE,
      hasVoted: !!Object.keys(prev).length
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root) return;

    // Build 10 clickable stars per criterion row.
    for (const row of root.querySelectorAll(".sr-crit")) {
      const label = row.dataset.crit;
      const holder = row.querySelector(".sr-stars");
      holder.innerHTML = "";
      for (let n = 1; n <= MAX_SCORE; n++) {
        const star = document.createElement("i");
        star.className = "fa-solid fa-star sr-star";
        star.dataset.value = String(n);
        star.addEventListener("click", () => {
          // Click the currently-selected star again → clear it.
          this.scores[label] = this.scores[label] === n ? 0 : n;
          if (!this.scores[label]) delete this.scores[label];
          this.#paint(row);
        });
        star.addEventListener("mouseenter", () => this.#paint(row, n));
        holder.appendChild(star);
      }
      row.querySelector(".sr-stars").addEventListener("mouseleave", () => this.#paint(row));
      this.#paint(row);
    }
    this.#updateOverall();
  }

  /** Repaint one criterion row; `hover` fills up to that value transiently. */
  #paint(row, hover = null) {
    const label = row.dataset.crit;
    const chosen = this.scores[label] ?? 0;
    const upto = hover ?? chosen;
    for (const star of row.querySelectorAll(".sr-star")) {
      const v = Number(star.dataset.value);
      star.classList.toggle("filled", v <= upto);
      star.classList.toggle("preview", hover != null && v <= hover && v > chosen);
    }
    const valEl = row.querySelector(".sr-crit-val");
    if (valEl) valEl.textContent = chosen ? String(chosen) : "—";
    if (hover == null) this.#updateOverall();
  }

  #updateOverall() {
    const el = this.element?.querySelector(".sr-overall-val");
    if (!el) return;
    el.textContent = fmtScore(mean(Object.values(this.scores)));
  }

  static async #onSubmit(event, form, formData) {
    const ch = getChapter(this.chapterId);
    const criteria = ch?.criteria ?? [];
    // Require every criterion to be rated.
    const missing = criteria.filter((l) => !this.scores[l]);
    if (missing.length) {
      ui.notifications?.warn(i18n("Vote.Incomplete"));
      return; // keep the form open
    }
    sendVote(this.chapterId, this.scores);
    await setMyVote(this.chapterId, { ...this.scores }); // private local mirror
    ui.notifications?.info(i18n("Vote.Thanks"));
    this.close();
  }

  static #onCancel() {
    this.close();
  }

  async close(options) {
    if (VoteApp.current === this) VoteApp.current = null;
    return super.close(options);
  }
}

export function openVoteDialog(chapterId) {
  return VoteApp.open(chapterId);
}
