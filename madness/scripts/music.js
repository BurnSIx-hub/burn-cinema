/**
 * «Музыка безумия» — интеграция с Lazy Music.
 *
 * ЗАДАЧА: цель слышит СВОЙ трек вместо общего; остальные игроки слышат
 * общий и никогда — трек цели.
 *
 * КАК: на клиенте цели патчим статические методы PlayerReceiver из Lazy Music.
 * У Lazy Music один плеер на клиент, поэтому одновременно звучит либо общий
 * трек, либо трек безумия:
 *  - с изоляцией команды общей музыки (play/pause/stop/seek/restoreState)
 *    к цели не доходят, пока играет трек безумия;
 *  - без изоляции следующий общий трек (или стоп) сменяет трек безумия —
 *    дальше цель слушает общую музыку вместе со всеми.
 * Громкость (gmvol, ползунок Foundry) не блокируем — иначе цель не смогла бы
 * убавить звук.
 *
 * Зависимость мягкая: если Lazy Music не установлен/выключен — функции просто
 * возвращают false, остальной модуль работает как раньше.
 */

const LM_SOCKET = "module.lazy-music";
/** Метка на классе PlayerReceiver: патч уже стоит (храним в ней оригиналы). */
const PATCHED = Symbol.for("burn-cinema.madness.lazyMusicPatch");

/** Путь к модулю Lazy Music с учётом routePrefix — чтобы получить ТОТ ЖЕ
 *  экземпляр ES-модуля, который импортировал сам Lazy Music (иначе патч уйдёт
 *  в чужую копию класса и ничего не даст). */
function lmPath(file) {
  const p = `modules/lazy-music/scripts/${file}`;
  return foundry.utils.getRoute?.(p) ?? `/${p}`;
}

let _patching = null;   // Promise<boolean>: патч ставится один раз на страницу
let _orig = null;       // оригинальные методы PlayerReceiver
let _receiver = null;   // сам PlayerReceiver
let _mini = null;       // мини-плеер Lazy Music (название трека у игрока)
let _loudness = null;   // ровная громкость Lazy Music (множитель трека)
let _lock = false;      // изоляция: общая музыка не перебивает трек безумия
let _internal = false;  // идёт наш собственный вызов — пропускаем сквозь патч
let _trackKey = null;   // какой трек безумия играет (чтобы не перезапускать тот же)
let _run = null;        // запуск ГМ: трек + момент нажатия «Включить у цели»
let _spentRun = null;   // этот запуск уже сменила общая музыка — не повторять
let _sharedTitle = "";  // название общего трека — его и показывает мини-плеер
let _onChange = null;   // играет ли трек безумия — сообщить движку

async function importLM(file) {
  try {
    return await import(lmPath(file));
  } catch (err) {
    console.warn(`burn-cinema | Lazy Music: не загрузился ${file} — музыка безумия отключена`, err);
    return null;
  }
}

function changed() {
  try { _onChange?.(); } catch (err) { console.warn("burn-cinema | безумие: музыка", err); }
}

/** Название трека из команды Lazy Music (play — трек, restoreState — состояние). */
function sharedTrackOf(name, args) {
  if (name === "play") return args[0] ?? null;
  if (name === "restoreState") return args[0]?.playback?.track ?? null;
  return null;
}

function showTitle(title) {
  if (!game.user.isGM) _mini?.update?.({ title });
}

/**
 * Поставить патч-перехватчик на приёмник Lazy Music.
 * Движок синхронизируется несколько раз подряд (ready, canvasReady, onChange):
 * все вызовы ждут один и тот же промис, иначе второй вызов принял бы уже
 * поставленный перехватчик за оригинал, и тот вызывал бы сам себя.
 */
function ensurePatched() {
  _patching ??= (async () => {
    const PR = (await importLM("player-receiver.mjs"))?.PlayerReceiver;
    if (!PR) return false;
    _mini = (await importLM("mini-player.mjs"))?.LMMini ?? null;
    _loudness = (await importLM("loudness.mjs"))?.LMLoudness ?? null;
    _receiver = PR;

    _orig = PR[PATCHED] ?? {
      play: PR.play.bind(PR),
      pause: PR.pause.bind(PR),
      stop: PR.stop.bind(PR),
      seek: PR.seek.bind(PR),
      restoreState: PR.restoreState.bind(PR)
    };

    const guard = (name) => (...args) => {
      // Своя команда или трека безумия нет — Lazy Music работает как обычно.
      if (_internal || !_trackKey) return _orig[name](...args);

      const shared = sharedTrackOf(name, args);
      if (shared) _sharedTitle = shared.displayTitle || shared.title || "";

      if (_lock) {
        // Громкость Мастера из состояния всё равно применяем.
        if (name === "restoreState") PR.setGMVolume(args[0]?.gmVolume ?? 1);
        if (shared) showTitle(_sharedTitle);
        return;
      }
      // Без изоляции пауза и перемотка относятся к общему треку, не к нашему.
      if (name === "pause" || name === "seek") return;

      // Без изоляции новый общий трек (или стоп) сменяет трек безумия.
      _spentRun = _run;
      _trackKey = null;
      _run = null;
      const result = _orig[name](...args);
      changed();
      return result;
    };
    for (const name of Object.keys(_orig)) PR[name] = guard(name);
    PR[PATCHED] = _orig;
    return true;
  })();
  return _patching;
}

/** Ключ трека — чтобы повторная синхронизация не перезапускала ту же композицию. */
function trackKey(t) {
  return t ? `${t.streamUrl ?? ""}|${t.videoId ?? t.id ?? ""}` : null;
}

/**
 * Трек для PlayerReceiver.play: с id (по нему Lazy Music ведёт журнал и
 * выравнивает громкость) и с названием общего трека — мини-плеер не должен
 * выдать подмену, как не выдаёт её погашенный баннер.
 */
function payloadFor(track) {
  const p = { ...track, position: 0 };
  if (!p.videoId && !p.id && p.streamUrl) {
    const base = String(p.streamUrl).split("?")[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    // Файлы кэша Lazy Music названы по id ролика YouTube.
    if (/^[A-Za-z0-9_-]{11}$/.test(base)) p.videoId = p.id = base;
    else p.id = `file:${base}`;
  }
  if (p.streamUrl && p.gain == null && _loudness) p.gain = _loudness.gain(p.videoId ?? p.id);
  p.title = p.displayTitle = _sharedTitle;
  return p;
}

/**
 * Запустить трек безумия у ЭТОГО клиента.
 * @param {object} track    payload для PlayerReceiver.play
 * @param {boolean} isolate глушить ли общую музыку
 * @param {number} since    момент нажатия «Включить у цели» (новый запуск)
 */
export async function startMadnessMusic(track, { isolate = true, since = null } = {}) {
  if (!track) return false;
  if (!(await ensurePatched())) return false;

  const key = trackKey(track);
  const run = `${key}#${since ?? ""}`;
  if (run === _spentRun) return true; // общая музыка уже сменила этот запуск
  _lock = !!isolate;
  if (key === _trackKey) { _run = run; return true; } // уже играет — не дёргаем заново

  if (!_trackKey) {
    const cur = window._lmCurrentTrack;
    _sharedTitle = cur?.displayTitle || cur?.title || "";
  }
  _internal = true;
  try {
    // showBanner:false — баннер с названием выдал бы подмену.
    _orig.play(payloadFor(track), { autoplay: true, showBanner: false });
    _trackKey = key;
    _run = run;
  } finally {
    _internal = false;
  }
  changed();
  return true;
}

/** Заглушить трек безумия и вернуть цель к общей музыке. */
export async function stopMadnessMusic() {
  _spentRun = null;
  // Трек безумия не играет — ничего не трогаем. Иначе каждая синхронизация
  // (любая правка колоды) обрывала бы цели общую музыку.
  if (!_trackKey) { _lock = false; return; }
  if (!(await ensurePatched())) return;
  _internal = true;
  try {
    _orig.stop();
  } catch (err) {
    console.warn("burn-cinema | безумие: не удалось остановить трек", err);
  } finally {
    _internal = false;
  }
  _lock = false;
  _trackKey = null;
  _run = null;
  changed();

  // Попросить у ГМ актуальное состояние общей музыки — цель «возвращается в строй».
  // (Работает для игроков; ГМ, тестирующий на себе, к себе же не обращается.)
  try {
    if (!game.user.isGM) {
      game.socket.emit(LM_SOCKET, { action: "state-request", payload: {}, senderId: game.user.id, targetId: null });
    }
  } catch (_e) { /* Lazy Music мог быть выключен */ }
}

/** Играет ли сейчас трек безумия (для статуса у ГМ). */
export function isMadnessMusicOn() { return !!_trackKey; }

/** Движок узнаёт, что трек безумия начался или кончился. */
export function onMadnessMusicChange(fn) { _onChange = fn; }

/* ------------------------- Сторона ГМ: сбор трека ------------------------- */

/** Текущий трек, играющий у ГМ в Lazy Music (для кнопки «взять текущий»). */
export async function currentLazyMusicTrack() {
  try {
    const { LMApp } = await import(lmPath("app.mjs"));
    const app = LMApp?._instance;
    const t = app?.track;
    if (!t) return null;
    const out = {
      source: t.source ?? "youtube",
      videoId: t.id,
      id: t.id,
      title: t.displayTitle || t.title || "",
      displayTitle: t.displayTitle || t.title || "",
      albumArt: t.albumArt,
      position: 0
    };
    // Relay-режим: относительный путь к кэшу — каждый клиент качает со своего Foundry.
    if (app._relayUrl) out.streamUrl = app._relayUrl;
    return out;
  } catch (_e) {
    return null;
  }
}

/**
 * Разобрать ввод ГМ: ссылка/ID YouTube либо путь к аудиофайлу в Data.
 * @returns {object|null} payload для PlayerReceiver.play
 */
export function parseTrackInput(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;

  const yt = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/)
    ?? s.match(/^([A-Za-z0-9_-]{11})$/);
  if (yt) {
    const id = yt[1];
    return { source: "youtube", videoId: id, id, title: id, displayTitle: id, position: 0 };
  }

  if (/\.(m4a|mp3|ogg|wav|webm|opus|flac)(\?.*)?$/i.test(s)) {
    const name = s.split("?")[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    return { streamUrl: s, title: name, displayTitle: name, position: 0 };
  }
  return null;
}
