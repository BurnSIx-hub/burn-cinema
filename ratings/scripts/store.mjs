/**
 * Data layer for session-ratings.
 *
 * The world setting `chapters` holds, per chapter:
 *   - public meta (title, poster, description, number, status, criteria)
 *   - `stats`     : plaintext aggregate — count + per-criterion/overall averages,
 *                   the only rating data players can read
 *   - `enc`       : AES-GCM ciphertext of the identified per-user votes; only the
 *                   GM (who holds the key) can decrypt it
 *   - `voterCount`: convenience mirror of stats.count
 *
 * Only the GM writes the world setting. Players submit votes over the socket.
 * A player's own vote is mirrored into a private client-scope setting (`myVotes`)
 * so they can see "you voted" and edit their vote without exposing anyone.
 */

import { encryptJSON, decryptJSON } from "./crypto.mjs";

export const MODULE_ID = "session-ratings";
export const SETTING_CHAPTERS = "chapters";
export const SETTING_CRITERIA = "criteria";
export const SETTING_MYVOTES = "myVotes"; // client scope, this browser only
export const MAX_SCORE = 10;

export function i18n(key, data) {
  const full = `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/** Configured criteria labels (comma separated in settings) → clean array. */
export function getCriteria() {
  const raw = game.settings.get(MODULE_ID, SETTING_CRITERIA) ?? "";
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [i18n("Defaults.Overall")];
}

/** Full chapters array (a deep copy — safe to mutate before saving). */
export function getChapters() {
  const raw = game.settings.get(MODULE_ID, SETTING_CHAPTERS) ?? [];
  return foundry.utils.deepClone(raw);
}

export function getChapter(id) {
  return getChapters().find((c) => c.id === id) ?? null;
}

/** Persist. GM only — callers on player clients must route through the socket. */
export async function saveChapters(chapters) {
  if (!game.user?.isGM) {
    console.warn(`${MODULE_ID} | saveChapters called on a non-GM client — ignored`);
    return;
  }
  await game.settings.set(MODULE_ID, SETTING_CHAPTERS, chapters);
}

export function newId() {
  return foundry.utils.randomID(16);
}

function emptyStats() {
  return { count: 0, overall: null, perCriterion: {} };
}

/** Create a draft chapter (not yet open for voting). GM only. */
export async function createChapter({ title, poster = "", description = "" }) {
  const chapters = getChapters();
  const number = chapters.reduce((m, c) => Math.max(m, c.number ?? 0), 0) + 1;
  const chapter = {
    id: newId(),
    number,
    title: title?.trim() || i18n("Chapter.Untitled", { n: number }),
    poster: poster || "",
    description: description || "",
    createdAt: Date.now(),
    status: "draft", // draft → open → closed
    criteria: getCriteria(), // snapshot: a chapter keeps its own criteria set
    stats: emptyStats(),
    voterCount: 0,
    enc: await encryptJSON({}) // encrypted { [userId]: { scores, overall, at } }
  };
  chapters.push(chapter);
  await saveChapters(chapters);
  return chapter;
}

export async function updateChapter(id, patch) {
  const chapters = getChapters();
  const ch = chapters.find((c) => c.id === id);
  if (!ch) return null;
  Object.assign(ch, patch);
  await saveChapters(chapters);
  return ch;
}

export async function deleteChapter(id) {
  const chapters = getChapters().filter((c) => c.id !== id);
  await saveChapters(chapters);
}

export async function setStatus(id, status) {
  return updateChapter(id, { status });
}

/** Currently open-for-voting chapter, if any. */
export function getOpenChapter() {
  return getChapters().find((c) => c.status === "open") ?? null;
}

/** Decrypt the identified votes of one chapter. GM only; null if no/foreign key. */
export async function decryptVotes(chapter) {
  if (!chapter?.enc) return {};
  const raw = await decryptJSON(chapter.enc);
  return raw ?? null;
}

/**
 * Record (or replace) one user's vote. GM only — the write half of the socket
 * handshake. Decrypts the blob, updates it, recomputes public stats, re-encrypts.
 */
export async function recordVote(chapterId, userId, scores) {
  const chapters = getChapters();
  const ch = chapters.find((c) => c.id === chapterId);
  if (!ch) return null;

  const clean = {};
  for (const label of ch.criteria) {
    const v = Number(scores?.[label]);
    if (Number.isFinite(v) && v >= 1) clean[label] = Math.min(MAX_SCORE, Math.round(v));
  }
  if (!Object.keys(clean).length) return null;

  const raw = (await decryptJSON(ch.enc)) ?? {};
  raw[userId] = { scores: clean, overall: mean(Object.values(clean)), at: Date.now() };

  ch.stats = computeStatsFromRaw(raw, ch.criteria);
  ch.voterCount = ch.stats.count;
  ch.enc = await encryptJSON(raw);

  await saveChapters(chapters);
  return ch;
}

/* --------------------------------------------------------- my (local) vote -- */

export function getMyVote(chapterId) {
  const all = game.settings.get(MODULE_ID, SETTING_MYVOTES) ?? {};
  return all[chapterId] ?? null;
}

export async function setMyVote(chapterId, scores) {
  const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTING_MYVOTES) ?? {});
  all[chapterId] = scores;
  await game.settings.set(MODULE_ID, SETTING_MYVOTES, all);
}

/* ------------------------------------------------------------------ stats -- */

export function mean(nums) {
  const arr = nums.filter((n) => Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Aggregate stats from decrypted raw votes. */
export function computeStatsFromRaw(raw, criteria) {
  const votes = Object.values(raw ?? {});
  const perCriterion = {};
  for (const label of criteria ?? []) {
    perCriterion[label] = mean(votes.map((v) => v.scores?.[label]));
  }
  return { count: votes.length, overall: mean(votes.map((v) => v.overall)), perCriterion };
}

/** Public stats for display (already plaintext on the chapter). */
export function publicStats(chapter) {
  return chapter?.stats ?? emptyStats();
}

export function fmtScore(n) {
  return n == null ? "—" : (Math.round(n * 10) / 10).toFixed(1);
}

/** Minimal HTML escaper for values interpolated into dialog/chat HTML strings. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------------------------------------------- migration -- */

/**
 * One-time upgrade of pre-encryption chapters (0.1.x stored a plaintext `votes`
 * object). GM only. Encrypts the votes, fills in stats, drops the plaintext.
 */
export async function migrateLegacy() {
  if (!game.user?.isGM) return;
  const chapters = getChapters();
  let migrated = 0;
  for (const ch of chapters) {
    if (ch.votes && !ch.enc) {
      ch.criteria ??= getCriteria();
      ch.stats = computeStatsFromRaw(ch.votes, ch.criteria);
      ch.voterCount = ch.stats.count;
      ch.enc = await encryptJSON(ch.votes);
      delete ch.votes;
      migrated++;
    } else if (!ch.enc) {
      ch.stats ??= emptyStats();
      ch.voterCount ??= 0;
      ch.enc = await encryptJSON({});
      migrated++;
    }
  }
  if (migrated) {
    await saveChapters(chapters);
    console.info(`${MODULE_ID} | migrated ${migrated} chapter(s) to encrypted votes`);
  }
}
