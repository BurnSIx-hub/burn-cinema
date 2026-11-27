/**
 * 🔥 Осмотр предметов — окно ГМа: список зон сцены и быстрое создание.
 * Для тех, у кого нет Картографа: зона по тайлу, клеткой в точке или
 * осмотр к уже нарисованным регионам.
 */

import { MODULE_ID, BEHAVIOR_TYPE, FLAG_SEEN, CHECK, DEFAULTS, STORE_DIR, normalizeSystem, newTextKey } from "./logic.mjs";
import { loadStore, getSecret } from "./store.mjs";
import { openInspectEditor } from "./editor.mjs";

const { ApplicationV2 } = foundry.applications.api;
const L = (k) => game.i18n.localize(`BURNINSPECT.${k}`);
const LF = (k, d) => game.i18n.format(`BURNINSPECT.${k}`, d);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

const ZONE_COLOR = "#f3c76b";

function zonesOnScene(scene = canvas?.scene) {
  const out = [];
  for (const region of scene?.regions ?? []) {
    for (const behavior of region.behaviors) {
      if (behavior.type === BEHAVIOR_TYPE) out.push({ region, behavior });
    }
  }
  return out;
}

function stripHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = html ?? "";
  return (d.textContent ?? "").replace(/\s+/g, " ").trim();
}

function behaviorData(title = "") {
  return { type: BEHAVIOR_TYPE, name: L("BehaviorName"), system: { ...DEFAULTS, title, textKey: newTextKey() } };
}

function levelsForNew() {
  const scene = canvas.scene;
  if (!scene?.levels || scene.levels.size < 2 || !canvas.level) return [];
  return [canvas.level.id];
}

async function createZone(shape, title, label = "") {
  const [region] = await canvas.scene.createEmbeddedDocuments("Region", [{
    name: `🔍 ${title || label || L("Thing")}`,
    color: ZONE_COLOR,
    shapes: [shape],
    levels: levelsForNew(),
    visibility: CONST.REGION_VISIBILITY.LAYER,
    behaviors: [behaviorData(title)]
  }]);
  const b = region?.behaviors.contents[0];
  if (b) openInspectEditor(b);
  return region;
}

/** Прямоугольник по тайлу: тайл v14 стоит серединой (texture.anchor 0.5). */
export function shapeFromTile(t) {
  const ax = t.texture?.anchorX ?? 0.5, ay = t.texture?.anchorY ?? 0.5;
  return {
    type: "rectangle", x: t.x, y: t.y, width: t.width, height: t.height,
    anchorX: ax, anchorY: ay, rotation: t.rotation ?? 0
  };
}

/* ─────────────────────────── Режим выбора на холсте ─────────────────────── */

let pick = null;

function stopPick() {
  if (!pick) return;
  window.removeEventListener("pointerdown", pick.down, true);
  window.removeEventListener("keydown", pick.key, true);
  canvas.app?.view?.classList.remove("burn-inspect-picking");
  pick = null;
}

function startPick(kind, onDone) {
  stopPick();
  const view = canvas.app?.view;
  if (!view) return;
  const down = (ev) => {
    if (ev.target !== view) return;
    if (ev.button !== 0) { stopPick(); return; }
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const p = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
    stopPick();
    onDone(p);
  };
  const key = (ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); stopPick(); ui.notifications.info(L("PickCancelled")); }
  };
  pick = { kind, down, key };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("keydown", key, true);
  view.classList.add("burn-inspect-picking");
  ui.notifications.info(kind === "tile" ? L("PickTile") : L("PickPoint"));
}

function tileAt(p) {
  const hits = canvas.tiles.placeables.filter((t) => t.visible !== false && t.bounds?.contains(p.x, p.y));
  hits.sort((a, b) => (b.document.elevation - a.document.elevation) || (b.document.sort - a.document.sort));
  return hits[0] ?? null;
}

/* ─────────────────────────────── Окно ───────────────────────────────────── */

class InspectManager extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "burn-inspect-manager",
    classes: ["burn-inspect-manager"],
    window: { title: "🔥 Осмотр предметов", icon: "fa-solid fa-magnifying-glass", resizable: true },
    position: { width: 520, height: 560 }
  };

  #hooks = [];

  async _renderHTML() {
    await loadStore();
    const zones = zonesOnScene();
    const scene = canvas.scene;
    const rows = zones.map(({ region, behavior }) => {
      const s = normalizeSystem(behavior.system);
      const sec = getSecret(s.textKey);
      const seen = Object.keys(behavior.getFlag(MODULE_ID, FLAG_SEEN) ?? {}).length;
      const badges = [];
      if (s.checkMode !== CHECK.NONE) badges.push(`${s.checkMode === CHECK.PASSIVE ? L("PassiveShort") : "d20"} ${L("DC")} ${s.dc}`);
      badges.push(L(`VisibilityShort.${s.visibility}`));
      badges.push(L(`RepeatShort.${s.repeat}`));
      if (s.range) badges.push(`≤ ${s.range} ${esc(scene.grid.units || "")}`);
      if (sec.gmNote.trim()) badges.push(`<i class="fa-solid fa-user-secret"></i>`);
      const snippet = stripHtml(sec.text).slice(0, 90) || `<em>${L("EmptyText")}</em>`;
      return `<li class="bim-row ${behavior.disabled ? "off" : ""}" data-region="${region.id}" data-behavior="${behavior.id}">
        <div class="bim-main">
          <div class="bim-title">${esc(s.title || region.name)}</div>
          <div class="bim-snippet">${typeof snippet === "string" && !snippet.startsWith("<em>") ? esc(snippet) : snippet}</div>
          <div class="bim-badges">${badges.map((b) => `<span>${b}</span>`).join("")}${seen ? `<span class="seen" data-tooltip="${L("SeenHint")}"><i class="fa-solid fa-eye"></i> ${seen}</span>` : ""}</div>
        </div>
        <div class="bim-actions">
          <a data-act="pan" data-tooltip="${L("Pan")}"><i class="fa-solid fa-location-crosshairs"></i></a>
          <a data-act="edit" data-tooltip="${L("Edit")}"><i class="fa-solid fa-pen"></i></a>
          <a data-act="toggle" data-tooltip="${behavior.disabled ? L("Enable") : L("Disable")}"><i class="fa-solid ${behavior.disabled ? "fa-toggle-off" : "fa-toggle-on"}"></i></a>
          <a data-act="reset" data-tooltip="${L("Reset")}"><i class="fa-solid fa-rotate-left"></i></a>
          <a data-act="delete" data-tooltip="${L("Delete")}"><i class="fa-solid fa-trash"></i></a>
        </div>
      </li>`;
    }).join("");

    const controlled = canvas.regions?.controlled?.length ?? 0;
    // Кто из не-ГМов может смотреть файлы — тот найдёт и файл текстов.
    const browsers = game.users.filter((u) => !u.isGM && u.can("FILES_BROWSE")).map((u) => esc(u.name));
    const warn = browsers.length
      ? `<p class="bim-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${LF("BrowseWarn", { users: browsers.join(", "), dir: STORE_DIR })}</p>`
      : "";
    return `
      <div class="bim-tools">
        <button type="button" data-tool="tile"><i class="fa-solid fa-cubes"></i> ${L("ByTile")}</button>
        <button type="button" data-tool="point"><i class="fa-solid fa-square-plus"></i> ${L("ByPoint")}</button>
        <button type="button" data-tool="regions" ${controlled ? "" : "disabled"} data-tooltip="${L("ToRegionsHint")}"><i class="fa-solid fa-draw-polygon"></i> ${L("ToRegions")}${controlled ? ` (${controlled})` : ""}</button>
      </div>
      <p class="bim-hint">${L("ManagerHint")}</p>
      ${warn}
      ${scene ? "" : `<p class="bim-empty">${L("NoScene")}</p>`}
      ${zones.length ? `<ul class="bim-list">${rows}</ul>` : (scene ? `<p class="bim-empty">${L("NoZones")}</p>` : "")}
      ${zones.length ? `<div class="bim-foot"><button type="button" data-tool="resetAll"><i class="fa-solid fa-rotate-left"></i> ${L("ResetAll")}</button></div>` : ""}`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => this.#tool(b.dataset.tool)));
    content.querySelectorAll(".bim-row [data-act]").forEach((a) => a.addEventListener("click", (ev) => {
      const row = ev.currentTarget.closest(".bim-row");
      this.#act(a.dataset.act, row.dataset.region, row.dataset.behavior);
    }));
  }

  _onFirstRender() {
    const rerender = foundry.utils.debounce(() => this.rendered && this.render(), 100);
    for (const h of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior",
      "updateRegionBehavior", "deleteRegionBehavior", "canvasReady", "controlRegion"]) {
      this.#hooks.push([h, Hooks.on(h, rerender)]);
    }
  }

  _onClose() {
    for (const [h, id] of this.#hooks) Hooks.off(h, id);
    this.#hooks = [];
    stopPick();
  }

  async #tool(tool) {
    if (!canvas.scene) return;
    if (tool === "tile") {
      startPick("tile", async (p) => {
        const tile = tileAt(p);
        if (!tile) return ui.notifications.warn(L("NoTileHere"));
        // Название предмета — только из имени тайла; имя файла идёт лишь в имя региона,
        // чтобы ГМ узнал зону в списке, а игрок не увидел «дом_дерево_3».
        const file = decodeURIComponent(tile.document.texture?.src?.split("/").pop()?.replace(/[?#].*$/, "").replace(/\.[^.]+$/, "") ?? "");
        await createZone(shapeFromTile(tile.document), (tile.document.name ?? "").trim(), file.replace(/[_-]+/g, " ").trim());
      });
    } else if (tool === "point") {
      startPick("point", async (p) => {
        const s = canvas.dimensions.size;
        await createZone({ type: "rectangle", x: p.x, y: p.y, width: s, height: s, anchorX: 0.5, anchorY: 0.5, rotation: 0 }, "");
      });
    } else if (tool === "regions") {
      const regions = canvas.regions?.controlled ?? [];
      for (const r of regions) {
        if (r.document.behaviors.some((b) => b.type === BEHAVIOR_TYPE)) continue;
        const [b] = await r.document.createEmbeddedDocuments("RegionBehavior", [behaviorData("")]);
        if (b) openInspectEditor(b);
      }
    } else if (tool === "resetAll") {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: L("ResetAll") }, content: `<p>${L("ResetAllConfirm")}</p>`
      });
      if (ok) await game.burnCinema.inspect.resetInspectMemory();
    }
  }

  async #act(act, regionId, behaviorId) {
    const region = canvas.scene?.regions.get(regionId);
    const behavior = region?.behaviors.get(behaviorId);
    if (!behavior) return;
    if (act === "edit") return openInspectEditor(behavior);
    if (act === "toggle") return behavior.update({ disabled: !behavior.disabled });
    if (act === "reset") return game.burnCinema.inspect.resetInspectMemory(behavior);
    if (act === "pan") {
      const b = region.bounds;
      return canvas.animatePan({ x: b.x + b.width / 2, y: b.y + b.height / 2, duration: 400 });
    }
    if (act === "delete") {
      const onlyThis = region.behaviors.size === 1;
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: L("Delete") },
        content: `<p>${onlyThis ? LF("DeleteRegionConfirm", { name: esc(region.name) }) : L("DeleteBehaviorConfirm")}</p>`
      });
      if (!ok) return;
      if (onlyThis) return region.delete();
      return behavior.delete();
    }
  }
}

export function openInspectManager() {
  if (!game.user.isGM) return;
  const existing = foundry.applications.instances.get("burn-inspect-manager");
  if (existing) return existing.render({ force: true });
  new InspectManager().render({ force: true });
}
