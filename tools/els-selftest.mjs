/**
 * Epic Loading Screens — самопроверка смены сцены без Foundry.
 *
 * Запуск из папки модуля:  node tools/els-selftest.mjs [путь к main.js]
 *
 * Каждый сценарий грузит els/scripts/main.js в чистую песочницу с заглушками
 * DOM и Foundry и с ручными часами. Холст повторяет порядок Foundry v14:
 * Scene#view отказывает, пока canvas.loading; хуки update* идут раньше view;
 * canvasReady приходит раньше, чем снимается canvas.loading. Проверяются
 * долгая загрузка, отказ в переходе, сбой отрисовки, щелчок по экрану,
 * таймеры прошлого показа и фоновая подгрузка картинок. Код выхода 0 —
 * всё прошло.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = process.argv[2] ? resolve(process.argv[2]) : join(root, "els/scripts/main.js");
const code = readFileSync(mainPath, "utf8");
const ru = JSON.parse(readFileSync(join(root, "els/lang/ru.json"), "utf8"));
const en = JSON.parse(readFileSync(join(root, "els/lang/en.json"), "utf8"));

/* --------------------------------- Часы ---------------------------------- */

function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  return {
    get now() { return now; },
    setTimeout: (fn, ms = 0, ...a) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, a }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async until(t) {
      for (;;) {
        await flush();
        let next = null;
        for (const [id, tm] of timers) {
          if (tm.at > t) continue;
          if (!next || tm.at < next[1].at || (tm.at === next[1].at && id < next[0])) next = [id, tm];
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn(...next[1].a);
      }
      now = Math.max(now, t);
      await flush();
    }
  };
}

/* ---------------------------------- DOM ---------------------------------- */

class El {
  constructor(id = "", cls = "") {
    this.id = id;
    this.cls = new Set(cls.split(/\s+/).filter(Boolean));
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.children = [];
    this.textContent = "";
    this.listeners = {};
    this._html = "";
    const c = this.cls;
    this.classList = {
      add: (...n) => n.forEach(x => c.add(x)),
      remove: (...n) => n.forEach(x => c.delete(x)),
      contains: (n) => c.has(n),
      toggle: (n, on) => { const v = on ?? !c.has(n); v ? c.add(n) : c.delete(n); return v; }
    };
  }
  set innerHTML(html) {
    this._html = html;
    this.children = [...html.matchAll(/<div\s+(id|class)="([^"]+)"/g)]
      .map(m => m[1] === "id" ? new El(m[2]) : new El("", m[2]));
  }
  get innerHTML() { return this._html; }
  querySelector(sel) {
    return this.children.find(c => sel[0] === "#" ? c.id === sel.slice(1) : c.cls.has(sel.slice(1))) ?? null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] ?? []) fn({}); }
}

/* -------------------------------- Мир ------------------------------------ */

const SECTIONS = [
  { id: "s1", name: "Город", images: ["a.webp", "b.webp", "c.webp", "d.webp"], tips: ["t1", "t2"], prefix: "" },
  { id: "s2", name: "Пещера", images: ["e.webp", "f.webp"], tips: ["t3"], prefix: "" }
];

function makeWorld({ minSecs = 5, imgMs = 3000, loadMs = {} } = {}) {
  const clock = makeClock();
  const hooks = {};
  const Hooks = {
    on: (n, fn) => (hooks[n] ??= []).push(fn),
    once: (n, fn) => (hooks[n] ??= []).push(fn),
    callAll: (n, ...a) => { for (const fn of hooks[n] ?? []) fn(...a); return true; },
    call: (n, ...a) => { for (const fn of hooks[n] ?? []) if (fn(...a) === false) return false; return true; }
  };

  const settings = { sections: JSON.stringify(SECTIONS), bindings: "{}", tipPrefix: "", fadeMs: 800, minSecs, showTips: true };
  const onChange = {};
  const scenes = new Map();
  const refused = [];
  const draws = [];
  const warns = [];
  const images = { started: [], active: 0, maxActive: 0 };
  const canvas = { scene: null, ready: false, loading: false };

  // Scene#view: отказ, пока холст грузит прошлую сцену
  async function view(scene) {
    if (canvas.loading) { refused.push(scene.id); return; }
    if (canvas.scene?.id !== scene.id) await draw(scene);
  }

  // Canvas#draw в порядке v14
  async function draw(scene) {
    const wasReady = canvas.ready;
    canvas.ready = false;
    canvas.loading = true;
    if (wasReady) Hooks.callAll("canvasTearDown", canvas, {});
    canvas.scene = scene;
    draws.push(scene.id);
    await new Promise(r => clock.setTimeout(r, loadMs[scene.id] ?? 1000));
    if (scene.fail) { canvas.loading = false; return; } // «Texture loading failed»
    canvas.ready = true;
    Hooks.call("canvasReady", canvas);
    await Promise.resolve(); // #handleRegionBehaviorViewedEvents
    canvas.loading = false;
  }

  for (const id of ["A", "B", "C"]) scenes.set(id, { id, name: id, active: false, fail: false, view() { return view(this); } });

  // ГМ активирует сцену: хук updateScene, затем Scene#_onActivate → view
  function activate(id) {
    for (const s of scenes.values()) s.active = false;
    const s = scenes.get(id);
    s.active = true;
    Hooks.callAll("updateScene", s, { active: true }, {}, "gm");
    Promise.resolve().then(() => view(s));
  }

  class FakeImage {
    set src(url) {
      this._src = url;
      images.started.push({ url, at: clock.now, duringLoad: canvas.loading });
      images.active++;
      images.maxActive = Math.max(images.maxActive, images.active);
      clock.setTimeout(() => { images.active--; this.onload?.(); }, imgMs);
    }
    get src() { return this._src; }
  }

  const registry = [];
  const document = {
    body: { appendChild(el) { registry.push(el, ...el.children); } },
    createElement: () => new El(),
    getElementById: (id) => registry.find(e => e.id === id) ?? null,
    querySelector: (sel) => registry.find(e => sel[0] === "#" ? e.id === sel.slice(1) : e.cls.has(sel.slice(1))) ?? null
  };

  const game = {
    i18n: {
      localize: (k) => ru[k] ?? k,
      format: (k, d = {}) => (ru[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => String(d[n] ?? `{${n}}`))
    },
    // Мировая настройка: onChange срабатывает у всех клиентов, как в Foundry
    settings: {
      register(ns, key, data) { onChange[key] = data.onChange; },
      registerMenu() {},
      get: (ns, key) => settings[key],
      set: async (ns, key, v) => { settings[key] = v; onChange[key]?.(v); }
    },
    scenes: {
      get active() { return [...scenes.values()].find(s => s.active) ?? null; },
      get: (id) => scenes.get(id),
      get contents() { return [...scenes.values()]; }
    },
    modules: { get: () => undefined },
    user: { isGM: false }
  };

  const sandbox = {
    Hooks, game, canvas, document,
    foundry: { applications: { api: { ApplicationV2: class {} } } },
    ui: { notifications: { info() {}, warn() {} } },
    FilePicker: class {},
    Image: FakeImage,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    requestAnimationFrame: (cb) => clock.setTimeout(cb, 16),
    requestIdleCallback: (cb) => clock.setTimeout(cb, 50),
    console: { log() {}, warn: (...a) => warns.push(a.join(" ")), error: (...a) => warns.push(a.join(" ")) }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: mainPath });

  // Мир загружен: игрок стоит на активной сцене A
  const A = scenes.get("A");
  A.active = true;
  canvas.scene = A;
  canvas.ready = true;
  Hooks.callAll("init");
  Hooks.callAll("ready");

  const ELS = sandbox.ELS;
  return {
    clock, canvas, scenes, refused, draws, warns, images, activate, draw, ELS, game,
    visible: () => !!ELS.overlay?.cls.has("els-visible"),
    stalled: () => !!ELS.overlay?.cls.has("els-stalled"),
    click: () => ELS.overlay.dispatch("click")
  };
}

/* -------------------------------- Проверки -------------------------------- */

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Обычная смена сцены: экран держится minSecs и уходит после canvasReady
{
  const w = makeWorld({ loadMs: { B: 3000 } });
  w.activate("B");
  await w.clock.until(100);
  check("обычная: экран показан", w.visible());
  await w.clock.until(4000);
  check("обычная: держится до minSecs", w.visible());
  await w.clock.until(5500);
  check("обычная: скрыт после minSecs", !w.visible());
  check("обычная: на сцене B", w.canvas.scene.id === "B");
}

// 2. Большая карта грузится 40 сек — экран не уходит на 15-й секунде
{
  const w = makeWorld({ loadMs: { B: 40000 } });
  w.activate("B");
  await w.clock.until(16000);
  check("долгая: экран стоит после 15 сек, пока холст грузится", w.visible());
  check("долгая: отмечена долгая загрузка", w.stalled());
  check("долгая: подпись о долгой загрузке", w.ELS.stallLabel?.textContent === ru["ELS.StillLoading"],
    JSON.stringify(w.ELS.stallLabel?.textContent));
  await w.clock.until(39000);
  check("долгая: стоит до конца загрузки", w.visible());
  await w.clock.until(41000);
  check("долгая: скрыт после canvasReady", !w.visible());
  check("долгая: подпись снята", !w.stalled());
}

// 3. Отрисовка упала: canvasReady не придёт, холст не грузится — сторож скрывает
{
  const w = makeWorld({ loadMs: { B: 2000 } });
  w.scenes.get("B").fail = true;
  w.activate("B");
  await w.clock.until(14000);
  check("сбой: до сторожа экран стоит", w.visible());
  await w.clock.until(15100);
  check("сбой: сторож скрыл экран", !w.visible());
  check("сбой: предупреждение в консоли", w.warns.some(s => s.includes("Fallback")));
}

// 4. ГМ сменил карту, пока игрок грузил прошлую: Foundry отказал — догоняем
{
  const w = makeWorld({ loadMs: { B: 20000, C: 3000 } });
  w.activate("B");
  await w.clock.until(5000);
  w.activate("C");
  await w.clock.until(5100);
  check("отказ: Foundry отклонил переход на C", w.refused.includes("C"));
  check("отказ: на экране название C", w.ELS.sceneName?.textContent === "C");
  await w.clock.until(20500);
  check("отказ: после B экран не ушёл", w.visible());
  await w.clock.until(25000);
  check("отказ: игрок догнал сцену C", w.canvas.scene.id === "C", `на ${w.canvas.scene.id}`);
  check("отказ: экран скрыт", !w.visible());
  check("отказ: C отрисована один раз", w.draws.join() === "B,C", w.draws.join());
}

// 4б. ГМ вернул ту сцену, что ещё грузится, — догонять нечего
{
  const w = makeWorld({ loadMs: { B: 20000, C: 3000 } });
  w.activate("B");
  await w.clock.until(5000);
  w.activate("C");
  await w.clock.until(8000);
  w.activate("B");
  await w.clock.until(21000);
  check("возврат: остался на B", w.canvas.scene.id === "B");
  check("возврат: лишних отрисовок нет", w.draws.join() === "B", w.draws.join());
  check("возврат: экран скрыт", !w.visible());
}

// 5. Щелчок скрывает экран только при долгой загрузке
{
  const w = makeWorld({ loadMs: { B: 40000 } });
  w.activate("B");
  await w.clock.until(10000);
  w.click();
  check("щелчок: до 15 сек не скрывает", w.visible());
  await w.clock.until(16000);
  w.click();
  check("щелчок: при долгой загрузке скрывает", !w.visible());
  await w.clock.until(41000);
  check("щелчок: после загрузки экран не вернулся", !w.visible());
  check("щелчок: сцена B загрузилась", w.canvas.scene.id === "B" && w.canvas.ready);
}

// 6. Таймер прошлого показа не скрывает новый экран раньше minSecs
{
  const w = makeWorld({ loadMs: { B: 500, C: 1000 } });
  w.activate("B");
  await w.clock.until(3000);
  w.activate("C");
  await w.clock.until(6000);
  check("таймеры: экран C держится свои minSecs", w.visible());
  await w.clock.until(8500);
  check("таймеры: экран C скрыт после minSecs", !w.visible());
}

// 7. Картинки качаются по одной и не во время загрузки сцены
{
  const w = makeWorld({ imgMs: 3000, loadMs: { B: 10000 } });
  await w.clock.until(4000);
  check("подгрузка: по одной картинке", w.images.maxActive === 1, `разом ${w.images.maxActive}`);
  w.activate("B");
  await w.clock.until(11000);
  const during = w.images.started.filter(i => i.duringLoad).length;
  check("подгрузка: во время загрузки сцены — не больше одной (сама заставка)", during <= 1, `${during}`);
  await w.clock.until(60000);
  const all = new Set(w.images.started.map(i => i.url));
  check("подгрузка: после загрузки докачаны все", SECTIONS.flatMap(s => s.images).every(u => all.has(u)), [...all].join());
}

// 8. Смена уровня (та же сцена перерисовывается) — экрана нет
{
  const w = makeWorld();
  w.draw(w.scenes.get("A"));
  await w.clock.until(50);
  check("уровень: экран не показан", !w.visible());
  await w.clock.until(2000);
  check("уровень: экран не показан и после", !w.visible());
}

// 9. Активировали уже открытую сцену — экрана нет
{
  const w = makeWorld();
  w.activate("A");
  await w.clock.until(100);
  check("та же сцена: экран не показан", !w.visible());
}

// 10. ГМ поменял секции посреди игры — у игрока экран уже с новыми
{
  const w = makeWorld({ loadMs: { B: 3000 } });
  w.activate("B");
  await w.clock.until(6000);
  await w.game.settings.set("epic-loading-screens", "sections",
    JSON.stringify([{ id: "n1", name: "Новая", images: ["new.webp"], tips: ["свежая запись"], prefix: "Слухи" }]));
  w.activate("C");
  await w.clock.until(7000);
  check("секции: игрок видит новый заголовок без F5", w.ELS.tipPrefix?.textContent === "Слухи", JSON.stringify(w.ELS.tipPrefix?.textContent));
  check("секции: игрок видит новую запись без F5", w.ELS.tipText?.innerHTML === "свежая запись", JSON.stringify(w.ELS.tipText?.innerHTML));
}

// 11. Переводы: одинаковые ключи
{
  const a = Object.keys(ru).sort().join(), b = Object.keys(en).sort().join();
  check("переводы: ключи ru и en совпадают", a === b);
}

// 12. Осмотр предметов (inspect/) — своя логика, общий прогон
{
  const { runInspectTests } = await import("./inspect-selftest.mjs");
  await runInspectTests(check);
}

console.log(`ELS selftest: ${passed} прошло, ${failures.length} не прошло`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
