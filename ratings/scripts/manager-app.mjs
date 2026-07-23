/**
 * Main window: the campaign "Hall of Fame" (ApplicationV2).
 * GM sees management controls and vote authors; players see anonymous aggregates
 * and a "Vote" button while a chapter is open.
 */

import {
  MODULE_ID, getChapters, getChapter, createChapter, updateChapter,
  deleteChapter, setStatus, publicStats, decryptVotes, getMyVote,
  fmtScore, i18n, MAX_SCORE, esc
} from "./store.mjs";
import { getKeyString, setKeyString, hasKey } from "./crypto.mjs";
import { broadcast } from "./socket.mjs";
import { VoteApp } from "./vote-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { DialogV2 } = foundry.applications.api;

export class ManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "session-ratings-manager",
    classes: ["session-ratings", "session-ratings-manager"],
    window: {
      title: "session-ratings.App.Title",
      icon: "fa-solid fa-clapperboard",
      resizable: true
    },
    position: { width: 620, height: 720 },
    actions: {
      newChapter: ManagerApp.#onNew,
      openVote: ManagerApp.#onOpenVote,
      closeVote: ManagerApp.#onCloseVote,
      editChapter: ManagerApp.#onEdit,
      deleteChapter: ManagerApp.#onDelete,
      voters: ManagerApp.#onVoters,
      vote: ManagerApp.#onVote,
      manageKey: ManagerApp.#onManageKey
    }
  };

  static PARTS = {
    body: { template: "modules/burn-cinema/ratings/templates/manager.hbs" }
  };

  static instance = null;

  static open() {
    if (!ManagerApp.instance) ManagerApp.instance = new ManagerApp();
    ManagerApp.instance.render(true);
    return ManagerApp.instance;
  }

  static refresh() {
    if (ManagerApp.instance?.rendered) ManagerApp.instance.render(false);
  }

  async _prepareContext() {
    const isGM = game.user.isGM;
    const chapters = getChapters()
      .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
      .map((ch) => {
        const stats = publicStats(ch);
        return {
          id: ch.id,
          number: ch.number,
          title: ch.title,
          poster: ch.poster || "",
          description: ch.description || "",
          date: new Date(ch.createdAt).toLocaleDateString(),
          status: ch.status,
          isOpen: ch.status === "open",
          isDraft: ch.status === "draft",
          isClosed: ch.status === "closed",
          statusLabel: i18n(`Status.${cap(ch.status)}`),
          overall: fmtScore(stats.overall),
          hasScore: stats.overall != null,
          count: stats.count ?? 0,
          youVoted: !!getMyVote(ch.id),
          criteria: (ch.criteria ?? []).map((label) => {
            const v = stats.perCriterion?.[label];
            return { label, value: fmtScore(v), pct: v == null ? 0 : Math.round((v / MAX_SCORE) * 100) };
          })
        };
      });
    return {
      isGM,
      chapters,
      empty: chapters.length === 0,
      max: MAX_SCORE,
      criteriaHint: (chapters[0]?.criteria ?? []).join(" · ")
    };
  }

  /* --------------------------------------------------------------- actions -- */

  static async #onNew() {
    const data = await promptChapter();
    if (!data) return;
    await createChapter(data);
    broadcast({ t: "refresh" });
    this.render(false);
  }

  static async #onEdit(event, target) {
    const id = target.closest("[data-chapter-id]")?.dataset.chapterId;
    const ch = getChapter(id);
    if (!ch) return;
    const data = await promptChapter(ch);
    if (!data) return;
    await updateChapter(id, data);
    broadcast({ t: "refresh" });
    this.render(false);
  }

  static async #onDelete(event, target) {
    const id = target.closest("[data-chapter-id]")?.dataset.chapterId;
    const ch = getChapter(id);
    if (!ch) return;
    const ok = await DialogV2.confirm({
      window: { title: i18n("Confirm.DeleteTitle") },
      content: `<p>${i18n("Confirm.DeleteBody", { title: esc(ch.title) })}</p>`
    });
    if (!ok) return;
    await deleteChapter(id);
    broadcast({ t: "refresh" });
    this.render(false);
  }

  static async #onOpenVote(event, target) {
    const id = target.closest("[data-chapter-id]")?.dataset.chapterId;
    if (!id) return;
    // Only one chapter open for voting at a time.
    for (const ch of getChapters()) {
      if (ch.status === "open" && ch.id !== id) await setStatus(ch.id, "closed");
    }
    await setStatus(id, "open");
    broadcast({ t: "openVote", chapterId: id }); // players get the dialog
    broadcast({ t: "refresh" });
    ui.notifications?.info(i18n("Notify.VotingOpen"));
    this.render(false);
  }

  static async #onCloseVote(event, target) {
    const id = target.closest("[data-chapter-id]")?.dataset.chapterId;
    if (!id) return;
    await setStatus(id, "closed");
    broadcast({ t: "closeVote", chapterId: id });
    broadcast({ t: "refresh" });
    postResultsCard(getChapter(id));
    this.render(false);
  }

  static #onVote(event, target) {
    const id = target.closest("[data-chapter-id]")?.dataset.chapterId;
    if (id) VoteApp.open(id);
  }

  static async #onVoters(event, target) {
    const id = target.closest("[data-chapter-id]")?.dataset.chapterId;
    const ch = getChapter(id);
    if (!ch) return;
    const raw = await decryptVotes(ch); // null if key missing/foreign
    renderVotersDialog(ch, raw);
  }

  static async #onManageKey() {
    manageKeyDialog();
  }
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/* -------------------------------------------------------- create/edit form -- */

async function promptChapter(existing = null) {
  const title = existing?.title ?? "";
  const poster = existing?.poster ?? "";
  const description = existing?.description ?? "";
  const content = `
    <div class="sr-form">
      <div class="form-group">
        <label>${i18n("Form.Title")}</label>
        <input type="text" name="title" value="${esc(title)}" autofocus />
      </div>
      <div class="form-group">
        <label>${i18n("Form.Poster")}</label>
        <div class="sr-file-row">
          <input type="text" name="poster" value="${esc(poster)}" placeholder="${i18n("Form.PosterHint")}" />
          <button type="button" class="sr-file-pick" title="${i18n("Form.Browse")}"><i class="fa-solid fa-file-image"></i></button>
        </div>
      </div>
      <div class="form-group">
        <label>${i18n("Form.Description")}</label>
        <textarea name="description" rows="3">${esc(description)}</textarea>
      </div>
    </div>`;

  const result = await DialogV2.wait({
    window: { title: existing ? i18n("Form.EditTitle") : i18n("Form.NewTitle"), icon: "fa-solid fa-clapperboard" },
    position: { width: 460 },
    content,
    buttons: [
      {
        action: "save",
        label: i18n("Form.Save"),
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => {
          const form = button.form;
          return {
            title: form.elements.title.value,
            poster: form.elements.poster.value,
            description: form.elements.description.value
          };
        }
      },
      { action: "cancel", label: i18n("Form.Cancel"), icon: "fa-solid fa-xmark" }
    ],
    render: (event, dialog) => {
      const el = dialog.element ?? dialog;
      const btn = el.querySelector(".sr-file-pick");
      const input = el.querySelector("input[name='poster']");
      btn?.addEventListener("click", () => {
        new foundry.applications.apps.FilePicker.implementation({
          type: "image",
          current: input.value,
          callback: (path) => { input.value = path; }
        }).render(true);
      });
    },
    rejectClose: false
  });
  return result && result !== "cancel" ? result : null;
}

/* --------------------------------------------------------- GM voter detail -- */

function renderVotersDialog(chapter, raw) {
  // raw === null → the encrypted votes couldn't be decrypted on this machine.
  if (raw === null) {
    new DialogV2({
      window: { title: i18n("Voters.Title", { title: chapter.title }), icon: "fa-solid fa-lock" },
      position: { width: 460 },
      content: `<p class="sr-empty">${i18n("Key.CannotDecrypt")}</p>`,
      buttons: [{ action: "ok", label: i18n("Form.Close"), default: true }]
    }).render(true);
    return;
  }
  const rows = Object.entries(raw ?? {}).map(([userId, vote]) => {
    const user = game.users.get(userId);
    const cells = (chapter.criteria ?? [])
      .map((l) => `<td>${vote.scores?.[l] ?? "—"}</td>`)
      .join("");
    return `<tr>
      <td class="sr-voter"><span class="sr-dot" style="background:${user?.color ?? "#888"}"></span>${esc(user?.name ?? userId)}</td>
      ${cells}
      <td class="sr-voter-overall">${fmtScore(vote.overall)}</td>
    </tr>`;
  });
  const head = (chapter.criteria ?? []).map((l) => `<th>${esc(l)}</th>`).join("");
  const body = rows.length ? rows.join("") : `<tr><td colspan="99" class="sr-empty">${i18n("Voters.None")}</td></tr>`;
  const content = `
    <table class="sr-voters-table">
      <thead><tr><th>${i18n("Voters.Player")}</th>${head}<th>${i18n("Voters.Overall")}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  new DialogV2({
    window: { title: i18n("Voters.Title", { title: chapter.title }), icon: "fa-solid fa-users" },
    position: { width: 480 },
    content,
    buttons: [{ action: "ok", label: i18n("Form.Close"), default: true }]
  }).render(true);
}

/* --------------------------------------------------------- key management -- */

function manageKeyDialog() {
  const key = getKeyString();
  const content = `
    <div class="sr-form">
      <p class="sr-key-note">${i18n("Key.Note")}</p>
      <div class="form-group">
        <label>${i18n("Key.Current")}</label>
        <textarea class="sr-key-field" rows="2" readonly>${esc(key || i18n("Key.NoneYet"))}</textarea>
      </div>
      <div class="form-group">
        <label>${i18n("Key.Import")}</label>
        <input type="text" name="import" placeholder="${i18n("Key.ImportHint")}" />
      </div>
      <p class="sr-key-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${i18n("Key.Warn")}</p>
    </div>`;
  new DialogV2({
    window: { title: i18n("Key.Title"), icon: "fa-solid fa-key" },
    position: { width: 520 },
    content,
    buttons: [
      {
        action: "import",
        label: i18n("Key.DoImport"),
        icon: "fa-solid fa-file-import",
        callback: async (event, button) => {
          const val = button.form.elements.import.value.trim();
          if (!val) return;
          await setKeyString(val);
          ui.notifications?.info(i18n("Key.Imported"));
          ManagerApp.refresh();
        }
      },
      { action: "close", label: i18n("Form.Close"), default: true }
    ]
  }).render(true);
}

/* ------------------------------------------------------------- chat result -- */

function postResultsCard(chapter) {
  if (!chapter) return;
  const stats = publicStats(chapter);
  const crit = (chapter.criteria ?? [])
    .map((l) => `<li>${esc(l)}: <strong>${fmtScore(stats.perCriterion?.[l])}</strong></li>`)
    .join("");
  const content = `
    <div class="session-ratings-card">
      <h3><i class="fa-solid fa-clapperboard"></i> ${i18n("Card.Header", { n: chapter.number })}</h3>
      <div class="sr-card-title">${esc(chapter.title)}</div>
      <div class="sr-card-score">${fmtScore(stats.overall)}<span>/ ${MAX_SCORE}</span> ⭐</div>
      <div class="sr-card-votes">${i18n("Card.Votes", { n: stats.count })}</div>
      <ul class="sr-card-crit">${crit}</ul>
    </div>`;
  ChatMessage.create({ content, speaker: { alias: i18n("App.Title") } });
}
