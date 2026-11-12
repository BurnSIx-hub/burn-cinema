/**
 * 🔥 Cinema · «Восприятие безумия» — точка входа под-фичи.
 *
 * - Регистрирует настройки (колода и цели — с onChange: каждый клиент сам
 *   пересобирает свои видения), клавишу стопа и обёртки над placeable.
 * - Выставляет game.burnCinema.openMadness — его зовёт плитка BurnHub
 *   (scripts/catalog.js, карточка cinema-madness).
 * - Принимает вспышки от ГМ и отдаёт ему телеметрию.
 */

import {
  MODULE_ID, SETTING_DECK, SETTING_TARGETS, SETTING_PRESETS, SETTING_MUSIC_PRESETS,
  SETTING_LAST_TARGET, FLAG_STOP
} from "./constants.js";
import { getDeck, getTarget } from "./state.js";
import { onAction, dispatch } from "./net.js";
import { installWrappers } from "./wrap.js";
import { engine } from "./engine.js";
import { MadnessPanel, statusCache } from "./panel.js";

function onDataChange() {
  engine.sync();
  if (game.user?.isGM) MadnessPanel.refresh();
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_DECK, {
    scope: "world", config: false, type: Array, default: [], onChange: onDataChange
  });
  game.settings.register(MODULE_ID, SETTING_TARGETS, {
    scope: "world", config: false, type: Object, default: {}, onChange: onDataChange
  });
  game.settings.register(MODULE_ID, SETTING_PRESETS, {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => { if (game.user?.isGM) MadnessPanel.refresh(); }
  });
  game.settings.register(MODULE_ID, SETTING_MUSIC_PRESETS, {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => { if (game.user?.isGM) MadnessPanel.refresh(); }
  });
  game.settings.register(MODULE_ID, SETTING_LAST_TARGET, {
    scope: "client", config: false, type: String, default: ""
  });

  // Стоп — обычная клавиша в «Настроить управление»: о ней договорились
  // со столом, прятать её незачем. Работает у любого игрока.
  game.keybindings.register(MODULE_ID, "madnessStop", {
    name: "burncinema.Madness.StopKey",
    hint: "burncinema.Madness.StopKeyHint",
    editable: [{ key: "Backspace", modifiers: ["Control", "Alt", "Shift"] }],
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: () => { engine.stopByPlayer(); return true; }
  });
});

Hooks.once("setup", installWrappers);

/* ------------------------------ Команды ГМ -------------------------------- */

onAction("flash", (msg) => {
  if (msg.userId !== game.user.id) return;
  engine.flash(msg.payload?.visionId, msg.payload?.ms);
});

onAction("ping", () => engine.report(true));

/* ------------------------------ Телеметрия -------------------------------- */

function cacheStatus(userId, payload) {
  if (!game.user.isGM) return;
  statusCache.set(userId, payload);
  MadnessPanel.updateStatus();
}

onAction("status", (msg) => cacheStatus(msg.userId, msg.payload));
Hooks.on("burncinemaMadnessStatus", cacheStatus);

/* --------------------------------- Стоп ----------------------------------- */

Hooks.on("updateUser", (user, changes) => {
  if (!changes.flags?.[MODULE_ID]) return;
  if (user.isSelf) engine.onStopFlagChanged();
  if (!game.user.isGM) return;
  const stopped = !!user.getFlag(MODULE_ID, FLAG_STOP);
  if (stopped && !user.isSelf) {
    ui.notifications.warn(game.i18n.format("burncinema.Madness.StopNotify", { name: user.name }));
  }
  MadnessPanel.refresh();
});

/* --------------------------------- Сцена ---------------------------------- */

Hooks.on("canvasReady", () => engine.sync());

Hooks.once("ready", () => {
  const api = (game.burnCinema ??= {});
  api.openMadness = () => { if (game.user.isGM) MadnessPanel.open(); };
  // Отладка: game.burnCinema.madness.engine / getDeck() / getTarget(userId)
  api.madness = { engine, getDeck, getTarget, statusCache, flash: (userId, visionId, ms = 3000) => dispatch("flash", userId, { visionId, ms }) };
  engine.sync();
  if (game.user.isGM) dispatch("ping", null);
});
