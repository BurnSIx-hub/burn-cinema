/**
 * Casting Call — Foundry VTT module
 * GM creates scenes (troupes) with roles backed by Actors.
 * Players pick a role and become owner of the linked Actor.
 */

const MODULE_ID = "casting-call";
const SETTING_SCENES = "scenes";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/* -------------------------------------------------------------------------- */
/*  Data helpers                                                              */
/* -------------------------------------------------------------------------- */

function getScenes() {
  return foundry.utils.duplicate(game.settings.get(MODULE_ID, SETTING_SCENES) ?? []);
}

async function setScenes(scenes) {
  return game.settings.set(MODULE_ID, SETTING_SCENES, scenes);
}

function makeId() {
  return foundry.utils.randomID(16);
}

function findScene(scenes, sceneId) {
  return scenes.find(s => s.id === sceneId);
}

function findRole(scene, roleId) {
  return scene?.roles?.find(r => r.id === roleId);
}

async function resolveActor(uuid) {
  if (!uuid) return null;
  try {
    return await fromUuid(uuid);
  } catch (e) {
    return null;
  }
}

/**
 * Remove a specific user's ownership entry from an Actor, restoring them to
 * the default ownership level. We read the current ownership object, delete
 * the user's key, and write the whole object back. The `-=key` prefix syntax
 * does not work for the top-level `ownership` field in Foundry v14 — the
 * schema validator rejects it as "not a mapping of user IDs and permission
 * levels".
 */
async function releaseActorOwnership(actor, userId) {
  if (!actor || !userId) return;
  const ownership = foundry.utils.duplicate(actor.ownership ?? {});
  if (!(userId in ownership)) return;
  delete ownership[userId];
  await actor.update({ ownership }, { diff: false, recursive: false });
}

async function enrichBio(html, { secrets = false } = {}) {
  // v13/v14 path
  try {
    const TE = foundry.applications?.ux?.TextEditor?.implementation;
    if (TE?.enrichHTML) return await TE.enrichHTML(html, { secrets });
  } catch (e) { /* fall through */ }
  // Legacy global
  try {
    if (globalThis.TextEditor?.enrichHTML) {
      return await globalThis.TextEditor.enrichHTML(html, { secrets });
    }
  } catch (e) { /* fall through */ }
  return html;
}

/**
 * Resolve the role title via the Showstopper module if it's installed.
 * Showstopper exposes an async global: `showstopper.getActorIntroTitle(actor)`
 * which returns Promise<string>. It may resolve to an empty string if the
 * actor has no intro title configured — in that case we fall back to the
 * actor's name.
 */
async function getShowstopperTitle(actor) {
  if (!actor) return undefined;
  const fn = globalThis.showstopper?.getActorIntroTitle;
  if (typeof fn !== "function") return undefined;
  try {
    const v = await fn(actor);
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch (e) {
    WARN("showstopper.getActorIntroTitle threw:", e);
  }
  return undefined;
}

/**
 * The "current" role title for a role: showstopper value if available,
 * otherwise the actor name, otherwise whatever roleName is stored on the role.
 */
async function resolveRoleTitle(role, actor) {
  return (await getShowstopperTitle(actor)) ?? actor?.name ?? role?.roleName ?? "";
}

function userColor(userId) {
  const c = game.users.get(userId)?.color;
  if (!c) return "#888888";
  if (typeof c === "string") return c;
  return c.css ?? c.toString?.() ?? "#888888";
}

/* -------------------------------------------------------------------------- */
/*  Socket — players ask the GM to mutate scenes for them                     */
/* -------------------------------------------------------------------------- */

const REQUEST_FLAG = "request";
// Verbose dev logging. Set to true if you need to debug player→GM flow.
const DEBUG = false;
const LOG = (...args) => { if (DEBUG) console.log(`%c[CastingCall]`, "color:#b88fd8;font-weight:bold", ...args); };
const WARN = (...args) => console.warn(`%c[CastingCall]`, "color:#b88fd8;font-weight:bold", ...args);

/**
 * Player → GM request channel.
 *
 * We avoid game.socket.emit because Foundry's server-side socket middleware
 * silently dropped our module channel messages in v14 (reproduced in testing).
 *
 * Instead, players write a request into their own User flag. ALL clients
 * receive the updateUser hook (this is core Foundry state replication and is
 * guaranteed to work), and the primary GM picks it up and processes it.
 *
 * Players can set their own user flags without GM permission.
 */
async function sendRequest(action, payload) {
  const request = {
    action,
    payload,
    userId: game.user.id,
    nonce: foundry.utils.randomID(8),
    timestamp: Date.now()
  };
  LOG("sendRequest →", action, payload);
  await game.user.update({ [`flags.${MODULE_ID}.${REQUEST_FLAG}`]: request }); // raw: setFlag валидирует scope
}

async function handleUserUpdate(user, changes) {
  // Only the primary active GM processes requests
  if (!game.user.isGM) return;
  const activeGM = game.users.find(u => u.isGM && u.active);
  if (activeGM?.id !== game.user.id) return;

  // Only react to changes that include our flag
  const req = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${REQUEST_FLAG}`);
  if (!req || typeof req !== "object") return;

  LOG("handleUserUpdate: received request", req, "from user:", user.name);

  if (req.action === "takeRole") {
    await gmTakeRole(req.payload.sceneId, req.payload.roleId, user);
  } else if (req.action === "leaveRole") {
    await gmLeaveRole(req.payload.sceneId, req.payload.roleId, user);
  }

  // Clear the flag so future requests with same content still trigger updates
  try {
    await user.update({ [`flags.${MODULE_ID}.-=${REQUEST_FLAG}`]: null }); // raw unset
  } catch (e) { /* the user may not be GM-updatable in some edge cases */ }
}

/* -------------------------------------------------------------------------- */
/*  GM-side mutations (ownership + state)                                     */
/* -------------------------------------------------------------------------- */

async function gmTakeRole(sceneId, roleId, user) {
  LOG("gmTakeRole called", { sceneId, roleId, userName: user?.name });
  const scenes = getScenes();
  const scene = findScene(scenes, sceneId);
  const role = findRole(scene, roleId);
  if (!scene || !role) {
    WARN("gmTakeRole: scene or role not found", { sceneId, roleId });
    return;
  }

  // Already taken by someone else? Block.
  if (role.takenBy && role.takenBy !== user.id) {
    LOG("gmTakeRole: blocked, taken by", role.takenBy);
    return;
  }

  const actor = await resolveActor(role.actorUuid);
  if (!actor) {
    WARN("gmTakeRole: actor not resolved", role.actorUuid);
    return;
  }

  // One player — one role. Release any other roles this user already holds
  // across all scenes before taking the new one.
  for (const s of scenes) {
    for (const r of s.roles) {
      if (r.id === roleId) continue;
      if (r.takenBy !== user.id) continue;
      const prevActor = await resolveActor(r.actorUuid);
      if (prevActor) {
        await releaseActorOwnership(prevActor, user.id);
      }
      r.takenBy = null;
    }
  }

  // Grant ownership: set OWNER for this user
  const ownership = foundry.utils.duplicate(actor.ownership ?? {});
  ownership[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  await actor.update({ ownership });

  role.takenBy = user.id;
  await setScenes(scenes);
  refreshAllOpenApps();
}

async function gmLeaveRole(sceneId, roleId, user) {
  const scenes = getScenes();
  const scene = findScene(scenes, sceneId);
  const role = findRole(scene, roleId);
  if (!scene || !role) return;

  // Player can only leave their own role; GM can release any
  if (!user.isGM && role.takenBy !== user.id) return;

  const actor = await resolveActor(role.actorUuid);
  if (actor && role.takenBy) {
    await releaseActorOwnership(actor, role.takenBy);
  }

  role.takenBy = null;
  await setScenes(scenes);
  refreshAllOpenApps();
}

/* -------------------------------------------------------------------------- */
/*  Refresh helpers                                                           */
/* -------------------------------------------------------------------------- */

function refreshAllOpenApps() {
  for (const app of Object.values(ui.windows)) {
    if (app instanceof SceneManagerApp || app instanceof ScenePickerApp) {
      app.render(false);
    }
  }
  // ApplicationV2 instances live in foundry.applications.instances
  if (foundry.applications?.instances) {
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof SceneManagerApp || app instanceof ScenePickerApp) {
        app.render(false);
      }
    }
  }
}

/**
 * Open an image in a popout viewer. Foundry's ImagePopout supports a few
 * different shapes across versions; we try them in order.
 */
function openImagePopout(src, title) {
  if (!src) return;
  const Popout =
    foundry.applications?.apps?.ImagePopout
    ?? globalThis.ImagePopout;
  if (!Popout) return;

  try {
    // v13+ AppV2 signature: new ImagePopout({ src, window: { title } }).render(true)
    const app = new Popout({ src, window: { title: title || "" } });
    if (typeof app.render === "function") {
      app.render(true);
      return;
    }
  } catch (e) { /* try legacy */ }

  try {
    // Legacy: new ImagePopout(src, { title }).render(true)
    const app = new Popout(src, { title: title || "" });
    app.render(true);
  } catch (e) { /* nothing we can do */ }
}

/* -------------------------------------------------------------------------- */
/*  Scene Manager (GM)                                                        */
/* -------------------------------------------------------------------------- */

class SceneManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "casting-call-manager",
    classes: ["casting-call", "manager"],
    tag: "div",
    window: {
      title: "CASTING.ManagerTitle",
      icon: "fas fa-masks-theater",
      resizable: true
    },
    position: { width: 900, height: 640 },
    actions: {
      newScene: SceneManagerApp.#onNewScene,
      openScene: SceneManagerApp.#onOpenScene,
      renameScene: SceneManagerApp.#onRenameScene,
      deleteScene: SceneManagerApp.#onDeleteScene,
      toggleActive: SceneManagerApp.#onToggleActive,
      releaseAll:   SceneManagerApp.#onReleaseAll
    }
  };

  static PARTS = {
    main: { template: "modules/burn-cinema/casting/templates/manager.hbs" }
  };

  /** @type {string|null} currently selected scene id */
  selectedSceneId = null;
  /** @type {string|null} currently selected role id (right pane shows its actor) */
  selectedRoleId = null;

  async _prepareContext(_options) {
    const scenes = getScenes();
    if (!this.selectedSceneId && scenes.length) {
      this.selectedSceneId = scenes[0].id;
    }
    const scene = findScene(scenes, this.selectedSceneId) ?? null;

    // GM-side: re-sync stored roleName from Showstopper if it has drifted.
    // Player clients see the result via the updateSetting hook.
    let mutated = false;
    if (scene) {
      for (const role of scene.roles) {
        const actor = await resolveActor(role.actorUuid);
        const ss = await getShowstopperTitle(actor);
        if (ss && ss !== role.roleName) {
          role.roleName = ss;
          mutated = true;
        }
      }
    }
    if (mutated) {
      // Schedule the write outside this render tick to avoid recursion
      Promise.resolve().then(() => setScenes(scenes));
    }

    const roles = [];
    if (scene) {
      for (const role of scene.roles) {
        const actor = await resolveActor(role.actorUuid);
        roles.push({
          id: role.id,
          roleName: role.roleName || "",
          actorName: actor?.name ?? game.i18n.localize("CASTING.ActorNotFound"),
          actorImg: actor?.img ?? "icons/svg/mystery-man.svg",
          actorFound: !!actor,
          takenByName: role.takenBy ? (game.users.get(role.takenBy)?.name ?? "?") : null,
          takenByColor: role.takenBy ? userColor(role.takenBy) : null,
          isSelected: role.id === this.selectedRoleId
        });
      }
    }

    let rightPane = { isEmpty: true, isMissing: false };
    if (scene && this.selectedRoleId) {
      const role = findRole(scene, this.selectedRoleId);
      if (role) {
        const actor = await resolveActor(role.actorUuid);
        if (actor) {
          const bio = actor.system?.details?.biography?.value
                   ?? actor.system?.biography
                   ?? "";
          const enriched = bio
            ? await enrichBio(bio, { secrets: game.user.isGM })
            : `<p class="empty">${game.i18n.localize("CASTING.NoBiography")}</p>`;
          rightPane = {
            isEmpty: false,
            isMissing: false,
            roleId: role.id,
            roleName: role.roleName || "",
            actorName: actor.name,
            actorImg: actor.img,
            actorUuid: actor.uuid,
            biography: enriched,
            takenByName: role.takenBy ? (game.users.get(role.takenBy)?.name ?? "?") : null,
            takenByColor: role.takenBy ? userColor(role.takenBy) : null
          };
        } else {
          rightPane = { isEmpty: false, isMissing: true, roleId: role.id };
        }
      }
    }

    return {
      scenes: scenes.map(s => ({
        id: s.id,
        name: s.name,
        isActive: !!s.isActive,
        isSelected: s.id === this.selectedSceneId,
        roleCount: s.roles.length,
        takenCount: s.roles.filter(r => r.takenBy).length
      })),
      hasScenes: scenes.length > 0,
      scene,
      roles,
      rightPane,
      isGM: game.user.isGM
    };
  }

  _onRender(_context, _options) {
    const root = this.element;

    // Restore biography scroll position only if we're still showing the same role
    // (so switching to a different role naturally starts at the top).
    const scrollEl = root.querySelector(".cc-right-scroll");
    if (scrollEl && this._savedScrollFor === this.selectedRoleId && this._savedScrollTop != null) {
      scrollEl.scrollTop = this._savedScrollTop;
    }
    // Track scrolling so we can restore on the next render
    if (scrollEl) {
      scrollEl.addEventListener("scroll", () => {
        this._savedScrollFor = this.selectedRoleId;
        this._savedScrollTop = scrollEl.scrollTop;
      }, { passive: true });
    }

    // Click role card
    root.querySelectorAll("[data-role-id]").forEach(el => {
      el.addEventListener("click", ev => {
        if (ev.target.closest("[data-action]")) return; // let action buttons handle
        this.selectedRoleId = el.dataset.roleId;
        this.render(false);
      });
    });

    // Big portrait in the right pane → open image popout
    const bigPortrait = root.querySelector("img.cc-actor-portrait-big");
    if (bigPortrait) {
      bigPortrait.addEventListener("click", () => {
        openImagePopout(bigPortrait.getAttribute("src"), bigPortrait.dataset.imgName);
      });
    }

    // Drop zone for adding Actors to scene
    const dropZone = root.querySelector(".roles-list");
    if (dropZone && game.user.isGM) {
      dropZone.addEventListener("dragover", ev => {
        ev.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", async ev => {
        ev.preventDefault();
        dropZone.classList.remove("drag-over");
        await this._handleActorDrop(ev);
      });
    }

    // Per-role action buttons (rename, remove)
    root.querySelectorAll("[data-role-action]").forEach(btn => {
      btn.addEventListener("click", async ev => {
        ev.stopPropagation();
        const action = btn.dataset.roleAction;
        const roleId = btn.closest("[data-role-id]")?.dataset.roleId;
        if (!roleId) return;
        if (action === "edit") await this._editRoleName(roleId);
        else if (action === "remove") await this._removeRole(roleId);
        else if (action === "release") await this._releaseRole(roleId);
      });
    });
  }

  async _handleActorDrop(ev) {
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
    catch (e) { return; }
    if (data?.type !== "Actor") return;

    const actor = await resolveActor(data.uuid);
    if (!actor) return;

    const scenes = getScenes();
    const scene = findScene(scenes, this.selectedSceneId);
    if (!scene) return;

    scene.roles.push({
      id: makeId(),
      actorUuid: actor.uuid,
      // Prefer Showstopper's intro title; fall back to the actor name
      roleName: await resolveRoleTitle(null, actor),
      takenBy: null
    });
    await setScenes(scenes);
    this.render(false);
  }

  async _editRoleName(roleId) {
    const scenes = getScenes();
    const scene = findScene(scenes, this.selectedSceneId);
    const role = findRole(scene, roleId);
    if (!role) return;

    const newName = await DialogV2.prompt({
      window: { title: game.i18n.localize("CASTING.RoleName") },
      content: `<input type="text" name="rn" value="${foundry.utils.escapeHTML(role.roleName ?? "")}" placeholder="${game.i18n.localize("CASTING.RoleNamePlaceholder")}" style="width:100%;" autofocus />`,
      ok: {
        label: game.i18n.localize("CASTING.SaveAndClose"),
        callback: (_ev, button) => button.form.elements.rn.value
      }
    }).catch(() => null);

    if (newName === null) return;
    role.roleName = newName;
    await setScenes(scenes);
    this.render(false);
  }

  async _removeRole(roleId) {
    const scenes = getScenes();
    const scene = findScene(scenes, this.selectedSceneId);
    const role = findRole(scene, roleId);
    if (!role) return;

    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("CASTING.RemoveRole") },
      content: `<p>${game.i18n.format("CASTING.RemoveRoleConfirm", { name: role.roleName || "" })}</p>`
    }).catch(() => false);
    if (!confirmed) return;

    // If taken, release ownership first
    if (role.takenBy) {
      const actor = await resolveActor(role.actorUuid);
      if (actor) {
        await releaseActorOwnership(actor, role.takenBy);
      }
    }

    scene.roles = scene.roles.filter(r => r.id !== roleId);
    if (this.selectedRoleId === roleId) this.selectedRoleId = null;
    await setScenes(scenes);
    this.render(false);
  }

  async _releaseRole(roleId) {
    const scenes = getScenes();
    const scene = findScene(scenes, this.selectedSceneId);
    const role = findRole(scene, roleId);
    if (!role || !role.takenBy) return;
    await gmLeaveRole(scene.id, role.id, game.user);
    this.render(false);
  }

  /* ----------------------------- static actions ----------------------------- */

  static async #onNewScene(_event, _target) {
    const name = await DialogV2.prompt({
      window: { title: game.i18n.localize("CASTING.NewScene") },
      content: `<input type="text" name="n" placeholder="${game.i18n.localize("CASTING.SceneNamePlaceholder")}" style="width:100%;" autofocus />`,
      ok: {
        label: game.i18n.localize("CASTING.SaveAndClose"),
        callback: (_ev, button) => button.form.elements.n.value
      }
    }).catch(() => null);
    if (!name) return;

    const scenes = getScenes();
    const newScene = { id: makeId(), name, isActive: false, roles: [] };
    scenes.push(newScene);
    await setScenes(scenes);
    this.selectedSceneId = newScene.id;
    this.selectedRoleId = null;
    this.render(false);
  }

  static async #onOpenScene(event, target) {
    const id = target.dataset.sceneId;
    this.selectedSceneId = id;
    this.selectedRoleId = null;
    this.render(false);
  }

  static async #onRenameScene(event, target) {
    event.stopPropagation();
    const id = target.dataset.sceneId;
    const scenes = getScenes();
    const scene = findScene(scenes, id);
    if (!scene) return;

    const newName = await DialogV2.prompt({
      window: { title: game.i18n.localize("CASTING.RenameScene") },
      content: `<input type="text" name="n" value="${foundry.utils.escapeHTML(scene.name)}" style="width:100%;" autofocus />`,
      ok: {
        label: game.i18n.localize("CASTING.SaveAndClose"),
        callback: (_ev, button) => button.form.elements.n.value
      }
    }).catch(() => null);
    if (!newName) return;
    scene.name = newName;
    await setScenes(scenes);
    this.render(false);
  }

  static async #onDeleteScene(event, target) {
    event.stopPropagation();
    const id = target.dataset.sceneId;
    const scenes = getScenes();
    const scene = findScene(scenes, id);
    if (!scene) return;

    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("CASTING.DeleteScene") },
      content: `<p>${game.i18n.format("CASTING.DeleteSceneConfirm", { name: scene.name })}</p>`
    }).catch(() => false);
    if (!confirmed) return;

    // Release all taken roles' ownership first
    for (const role of scene.roles) {
      if (role.takenBy) {
        const actor = await resolveActor(role.actorUuid);
        if (actor) {
          await releaseActorOwnership(actor, role.takenBy);
        }
      }
    }

    const filtered = scenes.filter(s => s.id !== id);
    await setScenes(filtered);
    if (this.selectedSceneId === id) {
      this.selectedSceneId = filtered[0]?.id ?? null;
      this.selectedRoleId = null;
    }
    this.render(false);
  }

  static async #onToggleActive(event, target) {
    event.stopPropagation();
    const id = target.dataset.sceneId;
    const scenes = getScenes();
    const scene = findScene(scenes, id);
    if (!scene) return;
    scene.isActive = !scene.isActive;
    await setScenes(scenes);
    this.render(false);
  }

  static async #onReleaseAll(event, target) {
    event.stopPropagation();
    const id = target.dataset.sceneId;
    const scenes = getScenes();
    const scene = findScene(scenes, id);
    if (!scene) return;

    const takenRoles = scene.roles.filter(r => r.takenBy);
    if (!takenRoles.length) {
      ui.notifications?.info(game.i18n.localize("CASTING.NothingToRelease"));
      return;
    }

    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("CASTING.ReleaseAll") },
      content: `<p>${game.i18n.format("CASTING.ReleaseAllConfirm", { count: takenRoles.length })}</p>`
    }).catch(() => false);
    if (!confirmed) return;

    for (const role of takenRoles) {
      const actor = await resolveActor(role.actorUuid);
      if (actor) await releaseActorOwnership(actor, role.takenBy);
      role.takenBy = null;
    }

    await setScenes(scenes);
    refreshAllOpenApps();
  }
}

/* -------------------------------------------------------------------------- */
/*  Player Picker (read-only-ish view for players)                            */
/* -------------------------------------------------------------------------- */

class ScenePickerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "casting-call-picker",
    classes: ["casting-call", "picker"],
    tag: "div",
    window: {
      title: "CASTING.ManagerTitle",
      icon: "fas fa-masks-theater",
      resizable: true
    },
    position: { width: 820, height: 600 },
    actions: {
      openScene: ScenePickerApp.#onOpenScene,
      takeRole: ScenePickerApp.#onTakeRole,
      leaveRole: ScenePickerApp.#onLeaveRole
    }
  };

  static PARTS = {
    main: { template: "modules/burn-cinema/casting/templates/picker.hbs" }
  };

  selectedSceneId = null;
  selectedRoleId = null;

  async _prepareContext(_options) {
    const allScenes = getScenes();
    const scenes = allScenes.filter(s => s.isActive);

    if (!this.selectedSceneId || !scenes.find(s => s.id === this.selectedSceneId)) {
      this.selectedSceneId = scenes[0]?.id ?? null;
    }
    const scene = findScene(scenes, this.selectedSceneId) ?? null;

    const roles = [];
    if (scene) {
      for (const role of scene.roles) {
        const actor = await resolveActor(role.actorUuid);
        const isMine = role.takenBy === game.user.id;
        const isTakenByOther = role.takenBy && !isMine;
        const liveRoleName = (await getShowstopperTitle(actor)) ?? role.roleName ?? "";
        roles.push({
          id: role.id,
          roleName: liveRoleName,
          actorName: actor?.name ?? game.i18n.localize("CASTING.ActorNotFound"),
          actorImg: actor?.img ?? "icons/svg/mystery-man.svg",
          isTakenByOther,
          isMine,
          takenByName: role.takenBy ? (game.users.get(role.takenBy)?.name ?? "?") : null,
          takenByColor: role.takenBy ? userColor(role.takenBy) : null,
          isSelected: role.id === this.selectedRoleId
        });
      }
    }

    let rightPane = { isEmpty: true, isMissing: false };
    if (scene && this.selectedRoleId) {
      const role = findRole(scene, this.selectedRoleId);
      if (role) {
        const actor = await resolveActor(role.actorUuid);
        if (actor) {
          const bio = actor.system?.details?.biography?.value
                   ?? actor.system?.biography
                   ?? "";
          const enriched = bio
            ? await enrichBio(bio, { secrets: false })
            : `<p class="empty">${game.i18n.localize("CASTING.NoBiography")}</p>`;
          const isMine = role.takenBy === game.user.id;
          const isTakenByOther = !!(role.takenBy && !isMine);
          rightPane = {
            isEmpty: false,
            isMissing: false,
            roleId: role.id,
            roleName: (await getShowstopperTitle(actor)) ?? role.roleName ?? "",
            actorName: actor.name,
            actorImg: actor.img,
            biography: enriched,
            takenByName: role.takenBy ? (game.users.get(role.takenBy)?.name ?? "?") : null,
            takenByColor: role.takenBy ? userColor(role.takenBy) : null,
            canTake: !role.takenBy,
            canLeave: isMine,
            isTakenByOther
          };
        } else {
          rightPane = { isEmpty: false, isMissing: true };
        }
      }
    }

    return {
      scenes: scenes.map(s => ({
        id: s.id,
        name: s.name,
        isSelected: s.id === this.selectedSceneId
      })),
      hasScenes: scenes.length > 0,
      hasMultipleScenes: scenes.length > 1,
      scene,
      roles,
      rightPane
    };
  }

  _onRender(_context, _options) {
    const root = this.element;

    // Restore biography scroll position only if we're still showing the same role
    // (so switching to a different role naturally starts at the top).
    const scrollEl = root.querySelector(".cc-right-scroll");
    if (scrollEl && this._savedScrollFor === this.selectedRoleId && this._savedScrollTop != null) {
      scrollEl.scrollTop = this._savedScrollTop;
    }
    if (scrollEl) {
      scrollEl.addEventListener("scroll", () => {
        this._savedScrollFor = this.selectedRoleId;
        this._savedScrollTop = scrollEl.scrollTop;
      }, { passive: true });
    }

    root.querySelectorAll("[data-role-id]").forEach(el => {
      el.addEventListener("click", ev => {
        if (ev.target.closest("[data-action]")) return;
        if (el.tagName === "BUTTON") return; // buttons handled by data-action
        this.selectedRoleId = el.dataset.roleId;
        this.render(false);
      });
    });

    // Big portrait in the right pane → open image popout
    const bigPortrait = root.querySelector("img.cc-actor-portrait-big");
    if (bigPortrait) {
      bigPortrait.addEventListener("click", () => {
        openImagePopout(bigPortrait.getAttribute("src"), bigPortrait.dataset.imgName);
      });
    }

    // Fallback: direct click handlers on the CTA buttons in case actions binding misfires
    const takeBtn = root.querySelector('button[data-action="takeRole"]');
    if (takeBtn) {
      takeBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ScenePickerApp.#onTakeRole.call(this, ev, takeBtn);
      });
    }
    const leaveBtn = root.querySelector('button[data-action="leaveRole"]');
    if (leaveBtn) {
      leaveBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ScenePickerApp.#onLeaveRole.call(this, ev, leaveBtn);
      });
    }
  }

  static async #onOpenScene(_event, target) {
    this.selectedSceneId = target.dataset.sceneId;
    this.selectedRoleId = null;
    this.render(false);
  }

  static async #onTakeRole(_event, target) {
    const roleId = target.dataset.roleId;
    if (!roleId || !this.selectedSceneId) return;

    // Client-side guard so player sees feedback immediately
    const scenes = getScenes();
    const scene = findScene(scenes, this.selectedSceneId);
    const role = findRole(scene, roleId);
    if (role?.takenBy && role.takenBy !== game.user.id) {
      ui.notifications?.warn(game.i18n.localize("CASTING.CannotTake"));
      return;
    }

    // Если у игрока уже есть другая роль — спросить подтверждение
    if (!game.user.isGM) {
      let currentRoleName = null;
      outer: for (const s of scenes) {
        for (const r of s.roles) {
          if (r.takenBy === game.user.id && r.id !== roleId) {
            currentRoleName = r.roleName || "?";
            break outer;
          }
        }
      }
      if (currentRoleName !== null) {
        const ok = await DialogV2.confirm({
          window: { title: game.i18n.localize("CASTING.SwitchRoleTitle") },
          content: `<p>${game.i18n.format("CASTING.SwitchRoleConfirm", { name: currentRoleName })}</p>`
        }).catch(() => false);
        if (!ok) return;
      }
    }

    if (game.user.isGM) {
      await gmTakeRole(this.selectedSceneId, roleId, game.user);
    } else {
      await sendRequest("takeRole", { sceneId: this.selectedSceneId, roleId });
    }
  }

  static async #onLeaveRole(_event, target) {
    const roleId = target.dataset.roleId;
    if (!roleId || !this.selectedSceneId) return;
    if (game.user.isGM) {
      await gmLeaveRole(this.selectedSceneId, roleId, game.user);
    } else {
      await sendRequest("leaveRole", { sceneId: this.selectedSceneId, roleId });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_SCENES, {
    name: "Scenes data",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });
});

Hooks.once("ready", () => {
  // Player → GM request channel via user flag updates.
  // (See sendRequest() for rationale on why we don't use game.socket.emit.)
  Hooks.on("updateUser", (user, changes) => {
    handleUserUpdate(user, changes).catch(err => {
      WARN("handleUserUpdate error:", err);
    });
  });

  // For players: if a scene is already active when they log in, open the picker
  // immediately so they see what's going on. We snapshot afterwards so the
  // updateSetting hook doesn't re-trigger autoopen for the same scene.
  if (!game.user.isGM) {
    const active = getScenes().filter(s => s.isActive);
    if (active.length) {
      const app = new ScenePickerApp();
      app.selectedSceneId = active[0].id;
      app.render(true);
    }
  }
  refreshActiveSnapshot();

  // Expose API
  (game.burnCinema ??= {}).casting = { // бывший game.modules.get("casting-call").api
    openManager: () => {
      if (game.user.isGM) new SceneManagerApp().render(true);
      else new ScenePickerApp().render(true);
    },
    openScene: (sceneName) => {
      const scenes = getScenes();
      const scene = scenes.find(s => s.name === sceneName || s.id === sceneName);
      if (!scene) {
        ui.notifications?.warn(`Casting Call: scene "${sceneName}" not found`);
        return;
      }
      const App = game.user.isGM ? SceneManagerApp : ScenePickerApp;
      const app = new App();
      app.selectedSceneId = scene.id;
      app.render(true);
    }
  };
});

// Refresh open apps on world setting change (for live multi-client sync)
Hooks.on("updateSetting", (setting) => {
  if (setting.key === `${MODULE_ID}.${SETTING_SCENES}`) {
    maybeAutoOpenPicker();
    refreshAllOpenApps();
    // Re-render left toolbar so the player's "Сценки" button can appear or
    // disappear as scenes are activated / deactivated.
    if (!game.user.isGM) {
      ui.controls?.render(true);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  Scene Controls — button inside the Token Controls category                */
/*  GM: always visible. Players: visible only when at least one scene is      */
/*  active, so closed pickers can be reopened.                                */
/* -------------------------------------------------------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  return; // кнопка убрана: у всех есть группа 🔥 Burn

  const tool = {
    name: `${MODULE_ID}-open`,
    title: "CASTING.OpenManager",
    icon: "fas fa-masks-theater",
    button: true,
    visible: true,
    onClick: () => game.burnCinema.casting.openManager(),
    onChange: () => game.burnCinema.casting.openManager()
  };

  // v13+ shape: controls is an object keyed by category name; each category's
  // tools is an object too.
  // v12 shape: controls is an array; each category's tools is an array.
  if (Array.isArray(controls)) {
    const tokens = controls.find(c => c.name === "token" || c.name === "tokens");
    if (tokens) {
      if (Array.isArray(tokens.tools)) tokens.tools.push(tool);
      else tokens.tools[tool.name] = tool;
    }
  } else if (controls && typeof controls === "object") {
    const tokens = controls.tokens ?? controls.token;
    if (tokens) {
      tokens.tools = tokens.tools ?? {};
      if (Array.isArray(tokens.tools)) tokens.tools.push(tool);
      else tokens.tools[tool.name] = tool;
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  Player auto-open: when a scene becomes active, open the picker            */
/* -------------------------------------------------------------------------- */

/**
 * Track which scene IDs were active at the start of this session so we don't
 * re-open the picker on first render for scenes that were already active.
 * Auto-open should only fire on a transition: inactive → active.
 */
let _activeSceneSnapshot = new Set();

function refreshActiveSnapshot() {
  _activeSceneSnapshot = new Set(getScenes().filter(s => s.isActive).map(s => s.id));
}

function maybeAutoOpenPicker() {
  if (game.user.isGM) return;
  const scenes = getScenes();
  const nowActive = scenes.filter(s => s.isActive);
  const newlyActivated = nowActive.find(s => !_activeSceneSnapshot.has(s.id));
  refreshActiveSnapshot();
  if (!newlyActivated) return;

  // Don't re-open if the player is already viewing the picker
  const alreadyOpen = findOpenPicker();
  if (alreadyOpen) {
    alreadyOpen.selectedSceneId = newlyActivated.id;
    alreadyOpen.selectedRoleId = null;
    alreadyOpen.render(false);
    return;
  }

  const app = new ScenePickerApp();
  app.selectedSceneId = newlyActivated.id;
  app.render(true);
}

function findOpenPicker() {
  if (foundry.applications?.instances) {
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof ScenePickerApp && app.rendered) return app;
    }
  }
  for (const app of Object.values(ui.windows ?? {})) {
    if (app instanceof ScenePickerApp && app.rendered) return app;
  }
  return null;
}

// ─── Экспорт для картотеки Cinema (scripts/catalog.js) ───
Hooks.once("ready", () => {
  (game.burnCinema ??= {}).openCasting = () => game.burnCinema.casting.openManager();
});
