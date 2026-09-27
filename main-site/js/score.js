// Scoring. The score grows as the game goes on, from what a side does with
// its moves, and the result adds a bonus at the end. Then it is scaled by
// the opponent and the board, and by how quickly the game and each turn
// were played. The API recomputes all of it from the replayed moves and the
// server's own times, and never takes a score from a browser.
//
// Integers throughout, so the page and the server always agree.

import { WIN_LENGTH } from "./rules.js";

const PER_MOVE = 10;
// A move that leaves a line one short of a win, and one that stops the
// other side finishing a line. Each line counts, so a fork counts twice.
const THREAT = 25;
const BLOCK = 30;
const WIN = 300;
// A win in the fewest moves the board allows earns this much more, down to
// nothing for a win on the last possible move.
const QUICK_WIN = 150;
const DRAW = 150;
// Undo is unlimited, and each one costs this much before the percentages.
export const UNDO_COST = 30;

// Percent by computer level 1 to 5. A game between two people counts at 100.
export const LEVEL_PERCENT = [0, 40, 80, 120, 170, 240];
export const NETWORK_PERCENT = 100;
// Percent by board: the bigger boards are longer and harder to read.
export const BOARD_PERCENT = { 3: 100, 4: 125, 5: 150 };

export function percentFor(mode, level, size) {
  const base = mode === "computer" ? LEVEL_PERCENT[level] ?? 0 : NETWORK_PERCENT;
  return Math.floor((base * (BOARD_PERCENT[size] ?? 100)) / 100);
}

// What the moves so far are worth to `side`, before the result.
export function progress(plies, side) {
  let own = 0;
  let points = 0;
  for (const p of plies) {
    if (p.side !== side) continue;
    own++;
    points += PER_MOVE + THREAT * p.threats + BLOCK * p.blocks;
  }
  return { own, points };
}

// "win", "draw" or "loss" for `side`, from an outcome's winner.
export function resultFor(winner, side) {
  if (winner === -1) return "draw";
  return winner === side ? "win" : "loss";
}

function resultBonus(result, own, size) {
  if (result === "draw") return DRAW;
  if (result !== "win") return 0;
  const k = WIN_LENGTH[size];
  const most = Math.ceil((size * size) / 2);
  const quick = Math.floor((QUICK_WIN * Math.max(0, most - Math.max(k, own))) / (most - k));
  return WIN + quick;
}

// The score so far, shown while playing. Never below zero.
export function liveScore(plies, side, percent, undos = 0) {
  const raw = progress(plies, side).points - UNDO_COST * undos;
  return Math.max(0, Math.floor((raw * percent) / 100));
}

/* ---- time ----
   Both time bonuses go to wins and draws only, so losing fast is never
   worth anything, and only on a seed the server picked: a seed chosen by the
   player could have been practised against the deterministic computer. The
   times are the server's, never the browser's. */

// Each turn: up to this many points, in full at 1.5 seconds or quicker and
// shrinking evenly to nothing at 10 seconds. A turn's time is from when the
// server heard of the move before (or of the start, or an undo) to when it
// heard of this one; see api/_lib/verify.js.
export const TURN_POINTS = 20;
export const TURN_FAST_MS = 1500;
export const TURN_SLOW_MS = 10000;

export function turnPoints(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  const t = Math.min(TURN_SLOW_MS, Math.max(TURN_FAST_MS, Math.floor(ms)));
  return Math.floor((TURN_POINTS * (TURN_SLOW_MS - t)) / (TURN_SLOW_MS - TURN_FAST_MS));
}

// turnMs: the server's time for every ply, null where it has none (a move
// made offline, or the computer's).
export function turnBonus(turnMs, side, result, serverSeed) {
  if (!serverSeed || (result !== "win" && result !== "draw") || !Array.isArray(turnMs)) return 0;
  let points = 0;
  turnMs.forEach((ms, ply) => {
    if (ply % 2 === side && ms !== null) points += turnPoints(ms);
  });
  return points;
}

// The whole game: up to half as much again, shrinking evenly to nothing at
// the end of a window that grows with the board.
export const TIME_BONUS_MAX = 50;
export const TIME_WINDOW_MS = { 3: 2 * 60000, 4: 5 * 60000, 5: 10 * 60000 };

export function timeBonus(result, elapsedMs, serverSeed, size) {
  if (!serverSeed || (result !== "win" && result !== "draw")) return 0;
  const window = TIME_WINDOW_MS[size] ?? TIME_WINDOW_MS[3];
  const left = Math.max(0, window - Math.max(0, Math.floor(elapsedMs)));
  return Math.floor((TIME_BONUS_MAX * left) / window);
}

// The final score: progress, the result's bonus and the turn points, less
// any undos, scaled by the opponent and board, then by the game's time bonus.
export function finalScore({ plies, side, result, size, percent, undos = 0, turns = 0, bonusPercent = 0 }) {
  const { own, points } = progress(plies, side);
  const raw = points + resultBonus(result, own, size) + turns - UNDO_COST * undos;
  const base = Math.max(0, Math.floor((raw * percent) / 100));
  return Math.floor((base * (100 + bonusPercent)) / 100);
}
