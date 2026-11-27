/**
 * 🔥 Осмотр предметов — самопроверка логики без Foundry.
 *
 * Запуск отдельно:  node tools/inspect-selftest.mjs
 * Её же зовёт tools/els-selftest.mjs, так что общий прогон модуля один.
 * Проверяются: приведение данных (формат для Картографа), память осмотра,
 * итог проверки, адресаты, геометрия зоны, раскладка плашки, переводы
 * и что файлы из module.json существуют.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function runInspectTests(check) {
  const L = await import(pathToFileURL(join(root, "inspect/scripts/logic.mjs")).href);
  const { normalizeSystem, memoryKey, planInspection, resolveOutcome, textFor, targetsFor,
    distToPolygons, pxToUnits, inRange, placePlaque, DEFAULTS, BEHAVIOR_TYPE, OUTCOME } = L;

  // Формат
  check("осмотр: тип поведения burn-cinema.inspect", BEHAVIOR_TYPE === "burn-cinema.inspect");
  const n0 = normalizeSystem({});
  check("осмотр: пустой system → значения по умолчанию", JSON.stringify(n0) === JSON.stringify({ ...DEFAULTS }), JSON.stringify(n0));
  const n1 = normalizeSystem({ checkMode: "weird", visibility: "x", repeat: 5, dc: "15", range: -3, duration: "abc", title: "  Кровать " });
  check("осмотр: мусорные значения чинятся", n1.checkMode === "none" && n1.visibility === "self" && n1.repeat === "remember"
    && n1.dc === 15 && n1.range === 0 && n1.duration === 0 && n1.title === "Кровать", JSON.stringify(n1));
  check("осмотр: normalizeSystem(null) не падает", normalizeSystem(null).title === "");

  // Тексты не живут в регионе (1.3.1)
  const leaky = normalizeSystem({ text: "секрет", textFail: "провал", gmNote: "заметка", title: "Кровать" });
  check("осмотр: normalizeSystem выбрасывает тексты", !("text" in leaky) && !("textFail" in leaky) && !("gmNote" in leaky)
    && !JSON.stringify(leaky).includes("секрет"), JSON.stringify(leaky));
  check("осмотр: в DEFAULTS нет текстов", !L.SECRET_FIELDS.some((f) => f in DEFAULTS));
  check("осмотр: textKey проверяется", normalizeSystem({ textKey: "abc" }).textKey === ""
    && normalizeSystem({ textKey: "0123456789abcdef" }).textKey === "0123456789abcdef"
    && normalizeSystem({ textKey: "../../etc" }).textKey === "");
  const k1 = L.newTextKey(), k2 = L.newTextKey();
  check("осмотр: новые ключи текстов разные и допустимые", k1 !== k2 && L.isTextKey(k1) && k1.length === 16);
  const wf = L.newWorldFileName("beftest");
  check("осмотр: имя файла мира — префикс и 128 бит", /^world-beftest-[0-9a-f]{32}\.json$/.test(wf), wf);
  check("осмотр: hasSecret", L.hasSecret({ text: " x " }) && !L.hasSecret({ text: "  " }) && !L.hasSecret(null));

  // Хранилище
  const KA = "aaaaaaaaaaaaaaaa", KB = "bbbbbbbbbbbbbbbb";
  check("осмотр: мусорный файл — пусто", Object.keys(L.parseStoreFile("{oops")).length === 0
    && Object.keys(L.parseStoreFile({ zones: { "bad key": { text: "x" } } })).length === 0);
  const merged = L.mergeStore([
    { name: `world-beftest-${"1".repeat(32)}.json`, data: { zones: { [KA]: { text: "мир" } } } },
    { name: "kartograf-zzz.json", data: JSON.stringify({ zones: { [KA]: { text: "картограф" }, [KB]: { text: "только картограф" } } }) },
    { name: `world-other-${"2".repeat(32)}.json`, data: { zones: { [KB]: { text: "чужой мир" } } } }
  ], "beftest");
  check("осмотр: файл мира главнее выгрузки", merged.zones[KA].text === "мир", JSON.stringify(merged.zones[KA]));
  check("осмотр: выгрузка Картографа читается", !!merged.zones[KB]);
  check("осмотр: главный файл мира найден", merged.mainFile === `world-beftest-${"1".repeat(32)}.json`, merged.mainFile);
  const built = L.buildStoreFile({ [KA]: { text: "a", junk: 1 }, [KB]: { text: "b" } }, new Set([KA]));
  check("осмотр: в файл мира идут только ключи мира", Object.keys(built.zones).join() === KA && !("junk" in built.zones[KA]));

  // Перевод зон 1.3.0
  const { findLegacy } = await import(pathToFileURL(join(root, "inspect/scripts/migrate.mjs")).href);
  const legacy = findLegacy([{ _id: "S", regions: [{ _id: "R", behaviors: [
    { _id: "B1", type: BEHAVIOR_TYPE, system: { text: "<p>старое</p>", title: "Кровать" } },
    { _id: "B2", type: BEHAVIOR_TYPE, system: { textKey: KA, title: "новое" } },
    { _id: "B3", type: "teleportToken", system: { text: "чужое" } }
  ] }] }]);
  check("осмотр: перевод находит только старые зоны осмотра", legacy.length === 1 && legacy[0].behaviorId === "B1", JSON.stringify(legacy));

  // Ключ памяти без точек (точка ломает путь флага)
  const k = [memoryKey({ actorId: "A1" }), memoryKey({ tokenId: "T1" }), memoryKey({ userId: "U1" }), memoryKey()];
  check("осмотр: ключи памяти", k.join() === "a_A1,t_T1,u_U1,u_x", k.join());
  check("осмотр: в ключах нет точек", k.every((s) => !s.includes(".")));

  // План осмотра
  const roll = { checkMode: "roll", dc: 12 };
  check("осмотр: первый раз с броском — нужен бросок", planInspection(roll, null).needRoll === true);
  check("осмотр: «запомнить» — повтор без броска", (() => {
    const p = planInspection({ ...roll, repeat: "remember" }, { o: "fail" });
    return p.allowed && !p.needRoll && p.reuse === "fail";
  })());
  check("осмотр: «каждый раз» — снова бросок", planInspection({ ...roll, repeat: "always" }, { o: "fail" }).needRoll === true);
  check("осмотр: «один раз» — повтор запрещён", planInspection({ ...roll, repeat: "once" }, { o: "success" }).allowed === false);
  check("осмотр: «один раз», первый осмотр разрешён", planInspection({ repeat: "once" }, null).allowed === true);
  check("осмотр: без проверки — броска нет", planInspection({}, null).needRoll === false);
  check("осмотр: пассивная — броска нет", planInspection({ checkMode: "passive" }, null).needRoll === false);

  // Итог
  check("осмотр: без проверки — plain", resolveOutcome({}, {}) === OUTCOME.PLAIN);
  check("осмотр: бросок = СЛ — успех", resolveOutcome(roll, { total: 12 }) === OUTCOME.SUCCESS);
  check("осмотр: бросок < СЛ — провал", resolveOutcome(roll, { total: 11 }) === OUTCOME.FAIL);
  check("осмотр: броска нет — провал", resolveOutcome(roll, {}) === OUTCOME.FAIL);
  check("осмотр: пассивная 14 ≥ 12 — успех", resolveOutcome({ checkMode: "passive", dc: 12 }, { passive: 14, total: 1 }) === OUTCOME.SUCCESS);
  check("осмотр: пассивная берёт пассивное, не бросок", resolveOutcome({ checkMode: "passive", dc: 12 }, { passive: 8, total: 20 }) === OUTCOME.FAIL);

  // Тексты
  const sys = { text: "<p>Кровать будто котом изодрана, но кота тут нет</p>", textFail: "" }; // секретная часть
  check("осмотр: успех — основной текст", textFor(sys, "success", "—") === sys.text);
  check("осмотр: провал без текста — запасной", textFor(sys, "fail", "Ничего.") === "Ничего.");
  check("осмотр: пустой текст зоны — запасной, а не пустая плашка", textFor({}, "plain", "Ничего.") === "Ничего.");
  check("осмотр: провал с текстом", textFor({ ...sys, textFail: "Обычная кровать." }, "fail", "x") === "Обычная кровать.");

  // Адресаты
  const t1 = targetsFor({ visibility: "self" }, "U1", ["U1", "U2"]);
  check("осмотр: «лично» — только кликнувший", t1.users.join() === "U1" && !t1.chat);
  const t2 = targetsFor({ visibility: "all" }, "U1", ["U2", "U3"]);
  check("осмотр: «всем» — все игроки и кликнувший", t2.users.sort().join() === "U1,U2,U3" && !t2.chat);
  const t3 = targetsFor({ visibility: "chat" }, "U1", ["U2"]);
  check("осмотр: «чат» — кликнувший + чат", t3.users.join() === "U1" && t3.chat);

  // Геометрия
  const sq = [{ points: [0, 0, 100, 0, 100, 100, 0, 100] }];
  check("осмотр: точка внутри — 0", distToPolygons(50, 50, sq) === 0);
  check("осмотр: точка справа — 50 px", Math.abs(distToPolygons(150, 50, sq) - 50) < 1e-9);
  check("осмотр: угол — по диагонали", Math.abs(distToPolygons(103, 104, sq) - 5) < 1e-9);
  check("осмотр: дыра вырезает точку", distToPolygons(50, 50, [...sq, { points: [40, 40, 60, 40, 60, 60, 40, 60], isPositive: false }]) > 0);
  check("осмотр: px → футы", pxToUnits(200, 100, 5) === 10);
  check("осмотр: дистанция 0 — без предела", inRange({ range: 0 }, 9999));
  check("осмотр: дистанция 10 — 10 можно, 10.5 нельзя", inRange({ range: 10 }, 10) && !inRange({ range: 10 }, 10.5));

  // Раскладка плашки
  const pp = placePlaque({ anchorTop: { x: 500, y: 400 }, anchorBottom: { x: 500, y: 500 }, viewW: 1000, viewH: 800, w: 200, h: 100 });
  check("осмотр: плашка над зоной по центру", pp.left === 400 && pp.top === 286 && !pp.below, JSON.stringify(pp));
  const pt = placePlaque({ anchorTop: { x: 500, y: 40 }, anchorBottom: { x: 500, y: 120 }, viewW: 1000, viewH: 800, w: 200, h: 100 });
  check("осмотр: у верхнего края — под зоной", pt.below && pt.top === 134, JSON.stringify(pt));
  const pe = placePlaque({ anchorTop: { x: 990, y: 400 }, anchorBottom: { x: 990, y: 450 }, viewW: 1000, viewH: 800, w: 200, h: 100 });
  check("осмотр: у правого края — не вылезает", pe.left === 792, JSON.stringify(pe));

  // Переводы
  const ru = JSON.parse(readFileSync(join(root, "inspect/lang/ru.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "inspect/lang/en.json"), "utf8"));
  const flat = (o, p = "") => Object.entries(o).flatMap(([k2, v]) => (v && typeof v === "object" ? flat(v, `${p}${k2}.`) : [`${p}${k2}`]));
  const fr = flat(ru).sort().join(), fe = flat(en).sort().join();
  check("осмотр: переводы ru и en совпадают", fr === fe);
  const used = new Set();
  for (const f of ["inspect/scripts/main.mjs", "inspect/scripts/manager.mjs", "inspect/scripts/editor.mjs", "inspect/scripts/migrate.mjs"]) {
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/\bLF?\("([A-Za-z.]+)"/g)) used.add(`BURNINSPECT.${m[1]}`);
  }
  const have = new Set(flat(ru));
  const missing = [...used].filter((k2) => !have.has(k2));
  check("осмотр: все ключи из кода есть в ru.json", missing.length === 0, missing.join(", "));
  for (const f of Object.keys(DEFAULTS)) {
    check(`осмотр: у поля ${f} есть подпись`, have.has(`BURNINSPECT.Behavior.FIELDS.${f}.label`));
  }
  for (const en2 of ["Check", "Visibility", "Repeat"]) {
    const vals = Object.values(L[en2.toUpperCase()]);
    check(`осмотр: подписи вариантов ${en2}`, vals.every((v) => have.has(`BURNINSPECT.${en2}.${v}`)));
  }
  check("осмотр: подпись типа поведения", !!ru.TYPES?.RegionBehavior?.["burn-cinema"]?.inspect);

  // Манифест
  const man = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  check("осмотр: тип объявлен в documentTypes", !!man.documentTypes?.RegionBehavior?.inspect);
  const files = [...man.esmodules, ...man.styles, ...man.languages.map((l) => l.path)];
  const absent = files.filter((f) => !existsSync(join(root, f)));
  check("осмотр: все файлы манифеста на месте", absent.length === 0, absent.join(", "));
  check("осмотр: скрипт осмотра в манифесте", man.esmodules.includes("inspect/scripts/main.mjs"));
  check("осмотр: картинка лупы на месте", existsSync(join(root, "inspect/assets/magnifier.svg")));

  // Утечки: показ и запрос уходят только адресатам, заметка ГМа не идёт в чат
  const mainSrc = readFileSync(join(root, "inspect/scripts/main.mjs"), "utf8");
  const emits = [...mainSrc.matchAll(/game\.socket\.emit\(SOCKET,[^;]*;/g)].map((m) => m[0]);
  check("осмотр: каждый emit с recipients", emits.length >= 3 && emits.every((e) => e.includes("recipients")), emits.filter((e) => !e.includes("recipients")).join(" | "));
  const chatBlocks = [...mainSrc.matchAll(/ChatMessage\.create\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
  check("осмотр: заметка ГМа не попадает в чат", chatBlocks.length > 0 && chatBlocks.every((c) => !/gmNote/.test(c)));
  const storeSrc = readFileSync(join(root, "inspect/scripts/store.mjs"), "utf8");
  check("осмотр: хранилище пишет только ГМ", /if \(!game\.user\.isGM\) throw/.test(storeSrc) && /if \(!game\.user\.isGM\) return state/.test(storeSrc));

  // Открытый API для внешних холстов (inspect/API.md)
  check("осмотр: apiVersion 1", /apiVersion: 1,/.test(mainSrc));
  for (const m of ["zoneAt", "zoneOf", "inspectZone", "hover", "setAnchor", "reposition", "closePlaque"]) {
    check(`осмотр: API ${m}`, new RegExp(`\\b${m}: `).test(mainSrc));
  }
  check("осмотр: хук burnCinema.inspectHover", /Hooks\.callAll\("burnCinema\.inspectHover"/.test(mainSrc));
  check("осмотр: якорь далеко за экраном прячет, а не прижимает плашку", /far\(a\.top\) && far\(a\.bottom\) \? null : a/.test(mainSrc));
  check("осмотр: при внешнем якоре 2D-подсветка не рисуется", /if \(!z \|\| ui_\.anchorFn\) return;/.test(mainSrc));
  const css = readFileSync(join(root, "inspect/styles/inspect.css"), "utf8");
  check("осмотр: лупа работает не только на #board", /^\.burn-inspect-cursor \{/m.test(css));
  const apiDoc = readFileSync(join(root, "inspect/API.md"), "utf8");
  check("осмотр: API.md описывает все методы", ["zoneAt", "zoneOf", "inspectZone", "hover", "setAnchor", "reposition", "closePlaque", "apiVersion"].every((m) => apiDoc.includes(m)));

  // Синтаксис модулей браузера
  for (const f of ["inspect/scripts/main.mjs", "inspect/scripts/manager.mjs", "inspect/scripts/logic.mjs",
    "inspect/scripts/store.mjs", "inspect/scripts/editor.mjs", "inspect/scripts/migrate.mjs"]) {
    let ok = true, err = "";
    try { execFileSync(process.execPath, ["--check", join(root, f)], { stdio: "pipe" }); }
    catch (e) { ok = false; err = String(e.stderr ?? e).split("\n").slice(0, 4).join(" "); }
    check(`осмотр: ${f} без синтаксических ошибок`, ok, err);
  }
}

// Отдельный запуск
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let passed = 0;
  const failures = [];
  const check = (name, ok, extra = "") => { if (ok) passed++; else failures.push(extra ? `${name} — ${extra}` : name); };
  await runInspectTests(check);
  console.log(`Inspect selftest: ${passed} прошло, ${failures.length} не прошло`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(failures.length ? 1 : 0);
}
