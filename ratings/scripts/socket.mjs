/**
 * Socket layer. Foundry core socket (no socketlib dependency).
 *
 * Message flow:
 *   GM  → all : { t:"openVote",  chapterId }   players auto-open the vote dialog
 *   GM  → all : { t:"closeVote", chapterId }   players close any open dialog
 *   GM  → all : { t:"refresh" }                everyone re-renders open windows
 *   player→GM : { t:"vote", chapterId, userId, scores }  GM stores it
 */

import { MODULE_ID, recordVote, fmtScore, i18n } from "./store.mjs";

export const CHANNEL = "module.burn-cinema"; // единый канал контейнера

let _openVoteDialog = null; // injected by main.mjs to avoid a circular import
let _refreshApps = null;

export function wireSocket({ openVoteDialog, refreshApps }) {
  _openVoteDialog = openVoteDialog;
  _refreshApps = refreshApps;
  game.socket.on(CHANNEL, onMessage);
}

async function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "openVote":
      // Players (and any non-GM) get the rating dialog popped for them.
      if (!game.user.isGM) _openVoteDialog?.(msg.chapterId);
      break;
    case "closeVote":
      _closeVoteDialogs(msg.chapterId);
      _refreshApps?.();
      break;
    case "refresh":
      _refreshApps?.();
      break;
    case "vote":
      // Only the GM writes. If several GMs are online, the primary one wins.
      if (game.user.isGM && game.users.activeGM?.isSelf !== false) {
        await handleIncomingVote(msg);
      }
      break;
  }
}

async function handleIncomingVote({ chapterId, userId, scores }) {
  const ch = await recordVote(chapterId, userId, scores);
  if (!ch) return;
  const voter = game.users.get(userId);
  ui.notifications?.info(
    i18n("Notify.GotVote", {
      user: voter?.name ?? userId,
      score: fmtScore(mean(Object.values(scores ?? {})))
    })
  );
  _refreshApps?.();
  broadcast({ t: "refresh" });
}

function mean(nums) {
  const arr = nums.filter((n) => Number.isFinite(Number(n))).map(Number);
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function _closeVoteDialogs(chapterId) {
  for (const app of Object.values(ui.windows ?? {})) {
    if (app?.options?.classes?.includes("session-ratings-vote")) {
      if (!chapterId || app.chapterId === chapterId) app.close();
    }
  }
  // ApplicationV2 instances aren't always in ui.windows; also sweep the registry.
  for (const app of foundry.applications.instances?.values?.() ?? []) {
    if (app?.constructor?.name === "VoteApp" && (!chapterId || app.chapterId === chapterId)) {
      app.close();
    }
  }
}

/** Send to everyone else. */
export function broadcast(msg) {
  game.socket.emit(CHANNEL, msg);
}

/** Player → GM: submit a vote. */
export function sendVote(chapterId, scores) {
  broadcast({ t: "vote", chapterId, userId: game.user.id, scores });
}
