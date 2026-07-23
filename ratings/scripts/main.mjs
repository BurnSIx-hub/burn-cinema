/** Module entry: settings, scene control button, socket wiring, public API. */

import { MODULE_ID, SETTING_CHAPTERS, SETTING_CRITERIA, SETTING_MYVOTES, migrateLegacy, i18n } from "./store.mjs";
import { SECRET_SETTING } from "./crypto.mjs";
import { ManagerApp } from "./manager-app.mjs";
import { openVoteDialog } from "./vote-app.mjs";
import { wireSocket } from "./socket.mjs";

// i18nInit (not init): translations are loaded here, so setting labels resolve.
Hooks.once("i18nInit", () => {
  game.settings.register(MODULE_ID, SETTING_CHAPTERS, {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, SETTING_CRITERIA, {
    name: i18n("Settings.Criteria.Name"),
    hint: i18n("Settings.Criteria.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: i18n("Defaults.Criteria")
  });

  // AES key for encrypting raw votes — client scope: stays in the GM's browser,
  // never synced to other clients.
  game.settings.register(MODULE_ID, SECRET_SETTING, {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  // This browser's own submitted votes (private mirror for edit / "you voted").
  game.settings.register(MODULE_ID, SETTING_MYVOTES, {
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (game.modules.get("burnhub")?.active) return; // с BurnHub кнопка в папке 🔥 Burn; без него — своя (видна всем)
  // Visible to everyone: GM manages, players open results / vote.
  const tool = {
    name: MODULE_ID,
    title: `${MODULE_ID}.Controls.Open`,
    icon: "fa-solid fa-clapperboard",
    button: true,
    order: 100,
    onChange: () => ManagerApp.open(), // v13+
    onClick: () => ManagerApp.open()   // v12
  };

  if (Array.isArray(controls)) {
    const control = controls.find((c) => c.name === "notes" || c.name === "token");
    control?.tools?.push(tool);
  } else {
    const control = controls.notes ?? controls.tokens ?? controls.token ?? Object.values(controls)[0];
    if (control?.tools) control.tools[tool.name] = tool;
  }
});

// When the GM's write to the chapters setting propagates, refresh open windows
// so players' averages update even if a socket "refresh" raced ahead of the sync.
Hooks.on("updateSetting", (setting) => {
  if (setting?.key === `${MODULE_ID}.${SETTING_CHAPTERS}`) ManagerApp.refresh();
});

Hooks.once("ready", async () => {
  wireSocket({
    openVoteDialog,
    refreshApps: () => ManagerApp.refresh()
  });

  // Encrypt any legacy plaintext votes on the GM's first load of this version.
  if (game.user.isGM) {
    try {
      await migrateLegacy();
    } catch (err) {
      console.error(`${MODULE_ID} | migration failed`, err);
    }
  }

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: () => ManagerApp.open(),
      openVote: (chapterId) => openVoteDialog(chapterId)
    };
  }
  console.info(`${MODULE_ID} | Ready (v${mod?.version ?? "?"})`);
});

// ─── Экспорт для картотеки Cinema (scripts/catalog.js) ───
Hooks.once("ready", () => {
  (game.burnCinema ??= {}).openRatings = () => ManagerApp.open();
});
