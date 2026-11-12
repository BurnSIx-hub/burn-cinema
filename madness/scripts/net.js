/**
 * Сетевой слой «Восприятия безумия» поверх game.socket (общий канал
 * контейнера module.burn-cinema). Наши сообщения помечены scope="madness",
 * остальные подписчики канала их игнорируют.
 *
 * Постоянное состояние (колода, удержание, сила фона, музыка, стоп) живёт
 * в настройках и флаге User — сокет нужен только для мгновенного:
 *   ГМ   -> цель : "flash"   payload = { visionId, ms } — вспышка видения
 *   ГМ   -> все  : "ping"    «пришлите статус» (ГМ открыл панель)
 *   цель -> ГМ   : "status"  телеметрия для индикатора в панели
 *
 * Адресация: сообщение несёт userId; клиенты с другим game.user.id его
 * игнорируют. Модульный сокет доставляет сообщение всем, так что секрета
 * в нём нет — это осознанно (см. решение «Безумие как колода видений»).
 */

import { SOCKET, SCOPE } from "./constants.js";

const handlers = new Map(); // action -> fn(msg)

export function onAction(action, fn) {
  handlers.set(action, fn);
}

/** Отправить сообщение. userId — адресат команды ГМ или автор отчёта цели. */
export function emit(action, userId, payload = {}) {
  game.socket.emit(SOCKET, { scope: SCOPE, action, userId, payload, from: game.user.id });
}

/** Разослать команду и, если ГМ сам себе адресат, выполнить локально:
 *  game.socket не доставляет отправителю его же сообщение. */
export function dispatch(action, userId, payload = {}) {
  emit(action, userId, payload);
  if (!userId || game.user.id === userId) {
    handlers.get(action)?.({ scope: SCOPE, action, userId, payload, from: game.user.id });
  }
}

Hooks.once("ready", () => {
  game.socket.on(SOCKET, (msg) => {
    if (!msg || msg.scope !== SCOPE) return;
    handlers.get(msg.action)?.(msg);
  });
});
