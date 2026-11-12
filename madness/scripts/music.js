/**
 * «Музыка безумия» — интеграция с Lazy Music.
 *
 * ЗАДАЧА: цель слышит СВОЙ трек и НЕ слышит общий; остальные игроки слышат
 * общий и никогда — трек цели.
 *
 * КАК: на клиенте цели патчим статические методы PlayerReceiver из Lazy Music.
 * Пока стоит «изоляция», команды общей музыки (play/pause/stop/seek/restoreState)
 * игнорируются — кроме наших собственных вызовов (флаг _internal). Трек цели
 * никуда не транслируется: его играет только этот клиент. Громкость (gmvol,
 * ползунок Foundry) не блокируем — иначе цель не смогла бы убавить звук.
 *
 * Зависимость мягкая: если Lazy Music не установлен/выключен — функции просто
 * возвращают false, остальной модуль работает как раньше.
 */

const LM_SOCKET = "module.lazy-music";

/** Путь к модулю Lazy Music с учётом routePrefix — чтобы получить ТОТ ЖЕ
 *  экземпляр ES-модуля, который импортировал сам Lazy Music (иначе патч уйдёт
 *  в чужую копию класса и ничего не даст). */
function lmPath(file) {
  const p = `modules/lazy-music/scripts/${file}`;
  return foundry.utils.getRoute?.(p) ?? `/${p}`;
}

let _patched = false;
let _lock = false;      // цель изолирована от общей музыки
let _internal = false;  // идёт наш собственный вызов — пропускаем сквозь патч
let _orig = null;       // оригинальные методы PlayerReceiver
let _trackKey = null;   // что играет сейчас (чтобы не перезапускать тот же трек)

async function getReceiver() {
  try {
    const mod = await import(lmPath("player-receiver.mjs"));
    return mod?.PlayerReceiver ?? null;
  } catch (err) {
    console.warn("burn-cinema | Lazy Music недоступен — музыка безумия отключена", err);
    return null;
  }
}

/** Поставить патч-перехватчик на приёмник Lazy Music (идемпотентно). */
async function ensurePatched() {
  if (_patched) return true;
  const PR = await getReceiver();
  if (!PR) return false;

  _orig = {
    play: PR.play.bind(PR),
    pause: PR.pause.bind(PR),
    stop: PR.stop.bind(PR),
    seek: PR.seek.bind(PR),
    restoreState: PR.restoreState.bind(PR)
  };

  const guard = (name) => (...args) => {
    if (_lock && !_internal) return; // общая музыка во время изоляции — мимо
    return _orig[name](...args);
  };
  PR.play = guard("play");
  PR.pause = guard("pause");
  PR.stop = guard("stop");
  PR.seek = guard("seek");
  PR.restoreState = guard("restoreState");

  _patched = true;
  return true;
}

/** Ключ трека — чтобы повторный apply не перезапускал ту же композицию. */
function trackKey(t) {
  return t ? `${t.streamUrl ?? ""}|${t.videoId ?? t.id ?? ""}` : null;
}

/**
 * Запустить трек безумия у ЭТОГО клиента.
 * @param {object} track   payload для PlayerReceiver.play
 * @param {boolean} isolate глушить ли общую музыку
 */
export async function startMadnessMusic(track, { isolate = true } = {}) {
  if (!track) return false;
  if (!(await ensurePatched())) return false;

  const key = trackKey(track);
  _lock = !!isolate;
  if (key && key === _trackKey) return true; // уже играет — не дёргаем заново

  _internal = true;
  try {
    // showBanner:false — баннер с названием выдал бы подмену.
    _orig.play(track, { autoplay: true, showBanner: false });
    _trackKey = key;
  } finally {
    _internal = false;
  }
  return true;
}

/** Снять изоляцию, заглушить трек безумия и вернуть цель к общей музыке. */
export async function stopMadnessMusic() {
  // Музыка безумия не играет — ничего не трогаем. Иначе каждая синхронизация
  // (любая правка колоды) обрывала бы цели общую музыку.
  if (!_lock && !_trackKey) return;
  await ensurePatched();
  _internal = true;
  try { _orig?.stop?.(); } finally { _internal = false; }
  _lock = false;
  _trackKey = null;

  // Попросить у ГМ актуальное состояние общей музыки — цель «возвращается в строй».
  // (Работает для игроков; ГМ, тестирующий на себе, к себе же не обращается.)
  try {
    if (!game.user.isGM) {
      game.socket.emit(LM_SOCKET, { action: "state-request", payload: {}, senderId: game.user.id, targetId: null });
    }
  } catch (_e) { /* Lazy Music мог быть выключен */ }
}

/** Активна ли сейчас изоляция (для индикатора у ГМ). */
export function isMusicIsolated() { return _lock; }

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
    const name = s.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    return { streamUrl: s, title: name, displayTitle: name, position: 0 };
  }
  return null;
}
