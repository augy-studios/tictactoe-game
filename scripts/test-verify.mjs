#!/usr/bin/env node
// The API's game check, run locally with no database: honest games against
// the computer pass and score on every board, tampered ones are refused,
// turn times come out of the server's stamps as they should, and seeds and
// replay links read back what was written.
//
// Run: node scripts/test-verify.mjs

import { chooseMove, thinkPause } from "../main-site/js/ai.js";
import { emptyBoard, geometry, winningLine, SIZES } from "../main-site/js/rules.js";
import { newSeed, parseSeed, moveRandom } from "../main-site/js/seed.js";
import { packMoves, unpackMoves, replay } from "../main-site/js/record.js";
import { timeBonus, turnPoints } from "../main-site/js/score.js";
import { verify, settle, turnTimes } from "../main-site/api/_lib/verify.js";

const failures = [];
const MIN = 60000;

// The player's moves come from `playerLevel` standing in for a person; the
// computer's from `level`, exactly as the browser's worker plays them.
function playComputerGame(seed, level, playerSide, playerLevel = 3) {
  const geo = geometry(seed.size);
  const board = emptyBoard(seed.size);
  const moves = [];
  for (let ply = 0; ply < geo.cells; ply++) {
    const side = ply % 2;
    const random = side === playerSide ? moveRandom(seed, 99, ply) : moveRandom(seed, level, ply);
    const cell = chooseMove(board, seed.size, side, side === playerSide ? playerLevel : level, random);
    moves.push(cell);
    board[cell] = side;
    if (winningLine(board, geo, cell, side)) break;
  }
  return moves;
}

const expectCode = (label, fn, code) => {
  try {
    fn();
    failures.push(`${label}: passed, want ${code}`);
  } catch (err) {
    if (err.code !== code) failures.push(`${label}: ${err.code} (${err.message}), want ${code}`);
  }
};
const expectOk = (label, fn) => {
  try {
    return fn();
  } catch (err) {
    failures.push(`${label}: ${err.code} (${err.message})`);
    return null;
  }
};

const gameRow = (seed, extra = {}) => ({
  mode: "computer",
  seed: seed.text,
  size: seed.size,
  first_side: 0,
  difficulty: 2,
  server_seed: true,
  created_at: new Date(0).toISOString(),
  ...extra,
});

// Honest games on every board, from both sides.
for (const size of SIZES) {
  for (const playerSide of [0, 1]) {
    const seed = newSeed(size);
    const game = gameRow(seed, { first_side: playerSide, difficulty: 4 });
    const moves = playComputerGame(seed, 4, playerSide, 2);
    const started = Date.now();
    const r = expectOk(`${size}x${size} honest game as ${"XO"[playerSide]}`, () => verify(game, moves, playerSide, null, 0, 40 * MIN, []));
    if (r) {
      console.log(`${size}x${size} as ${"XO"[playerSide]}: ${moves.length} plies, ${r.outcome}, ${r.score} points, checked in ${Date.now() - started} ms`);
      const undone = verify(game, moves, playerSide, null, 2, 40 * MIN, []);
      if (r.score > 0 && undone.score >= r.score) failures.push(`${size}x${size}: undos did not cost points`);
    }
  }
}

// Master against Master on 3x3 can only draw, and still verifies.
{
  const seed = parseSeed("3X3-BXK4-M9TR");
  const moves = playComputerGame(seed, 5, 0, 5);
  const low = verify(gameRow(seed, { difficulty: 5 }), moves, 0, null, 0, 40 * MIN, []);
  if (low.outcome !== "draw") failures.push(`Master v Master on 3x3 should draw, got ${low.outcome}`);
}

// Tampering.
{
  const seed = parseSeed("4X4-BXK4-M9TR");
  const game = gameRow(seed);
  const moves = playComputerGame(seed, 2, 0);
  // Swap the computer's first reply for some other empty cell.
  const other = [...Array(16).keys()].find((c) => !moves.slice(0, 2).includes(c) && c !== moves[1]);
  const doctored = [moves[0], other];
  expectCode("a doctored computer move", () => verify(game, doctored, 0, { by: "resign", side: 0 }, 0, MIN, []), "not_computer");
  expectCode("a move on a taken cell", () => verify(game, [5, 5], 0, { by: "resign", side: 0 }, 0, MIN, []), "illegal");
  expectCode("a cell off a 4x4 board", () => verify(game, [16], 0, { by: "resign", side: 0 }, 0, MIN, []), "illegal");
  expectCode("an unfinished game", () => verify(game, moves.slice(0, 2), 0, null, 0, MIN, []), "unfinished");
  expectCode("the computer's side", () => verify(game, moves, 1, null, 0, MIN, []), "bad_side");
  expectCode("the computer resigning", () => verify(game, moves.slice(0, 2), 0, { by: "resign", side: 1 }, 0, MIN, []), "illegal");
  expectCode("resigning a finished game", () => settle(game, moves, { by: "resign", side: 0 }), "illegal");
  const r = expectOk("an early resignation", () => verify(game, moves.slice(0, 2), 0, { by: "resign", side: 0 }, 0, MIN, []));
  if (r && (r.outcome !== "loss" || r.timeBonus || r.turnBonus)) failures.push("an early resignation should be a loss with no time bonus");
}

// Turn times from stamps. Against the computer at level 2, the player X.
{
  const seed = parseSeed("3X3-BXK4-M9TR");
  const game = gameRow(seed);
  const pause = thinkPause(2);
  const t0 = Date.parse(game.created_at);
  const at = (ms) => new Date(t0 + ms).toISOString();
  const moves = [4, 0, 8, 2, 6];
  const events = [
    { kind: "move", side: 0, ply: 0, cell: 4, at: at(2000) },
    { kind: "move", side: 0, ply: 2, cell: 8, at: at(2000 + pause + 3000) },
    // Undone and played again after the undo.
    { kind: "undo", side: 0, ply: null, cell: null, at: at(9000) },
    { kind: "move", side: 0, ply: 2, cell: 8, at: at(9000 + 1200) },
    { kind: "move", side: 0, ply: 4, cell: 6, at: at(9000 + 1200 + pause + 5000) },
  ];
  const got = turnTimes(game, moves, events);
  const want = [2000, null, 1200, null, 5000];
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`computer turn times ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

  // A stamp for a different cell than the one finally played is ignored,
  // and so is a turn whose previous stamp went missing.
  const gaps = turnTimes(game, [4, 0, 7, 2, 6], [events[0], events[1], { ...events[4] }]);
  if (gaps[2] !== null) failures.push("a stamp for another cell was counted");
  if (gaps[4] !== null) failures.push("a turn after a replaced stamp was counted");

  // The player as O: the computer's first move is between the start and theirs.
  const asO = turnTimes({ ...game, first_side: 1 }, [4, 0], [{ kind: "move", side: 1, ply: 1, cell: 0, at: at(pause + 2500) }]);
  if (asO[1] !== 2500) failures.push(`O's first turn ${asO[1]}, want 2500`);
}

// A network game: each turn from the other player's stamp.
{
  const seed = parseSeed("3X3-BXK4-M9TR");
  const game = gameRow(seed, { mode: "network", difficulty: null });
  const t0 = Date.parse(game.created_at);
  const at = (ms) => new Date(t0 + ms).toISOString();
  const events = [
    { kind: "move", side: 0, ply: 0, cell: 4, at: at(1000) },
    { kind: "move", side: 1, ply: 1, cell: 0, at: at(3000) },
    { kind: "move", side: 0, ply: 2, cell: 8, at: at(7000) },
  ];
  const got = turnTimes(game, [4, 0, 8], events);
  if (JSON.stringify(got) !== JSON.stringify([1000, 2000, 4000])) failures.push(`network turn times ${JSON.stringify(got)}`);
}

// The bonuses themselves.
if (turnPoints(800) !== 20 || turnPoints(1500) !== 20 || turnPoints(10000) !== 0 || turnPoints(20000) !== 0) {
  failures.push("turn points should be 20 up to 1.5 s and 0 from 10 s");
}
if (timeBonus("win", 0, true, 3) !== 50) failures.push("instant 3x3 win bonus should be 50");
if (timeBonus("win", MIN, true, 3) !== 25) failures.push("one minute 3x3 win bonus should be 25");
if (timeBonus("draw", 5 * MIN, true, 5) !== 25) failures.push("five minute 5x5 draw bonus should be 25");
if (timeBonus("loss", 0, true, 3) !== 0) failures.push("losses get no time bonus");
if (timeBonus("win", 0, false, 3) !== 0) failures.push("a chosen seed gets no time bonus");

// Seeds and replay links.
for (const text of ["3X3-BXK4-M9TR", "4x4 bxk4 m9tr", "5BXK4M9TR"]) {
  const seed = parseSeed(text);
  if (!seed) failures.push(`${text} did not read as a seed`);
}
if (parseSeed("BXK4-M9TR", 4)?.text !== "4X4-BXK4-M9TR") failures.push("a bare seed should take the board it is given");
if (parseSeed("3X3-BXK4-M9T") || parseSeed("6X6-BXK4-M9TR") || parseSeed("3X3-AEIO-U011")) failures.push("a bad seed read as one");
{
  const seed = parseSeed("5X5-BXK4-M9TR");
  const moves = playComputerGame(seed, 3, 0);
  const packed = packMoves(moves);
  if (JSON.stringify(unpackMoves(seed, packed)) !== JSON.stringify(moves)) failures.push("a replay link did not unpack to its game");
  if (unpackMoves(seed, packed + packed[0]) !== null) failures.push("a replay link with a repeated cell unpacked");
  if (unpackMoves(seed, "zz") !== null) failures.push("a replay link with junk unpacked");
  if (replay(seed, moves).error) failures.push("an honest 5x5 game did not replay");
}

if (failures.length) {
  console.error("verify test failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("verify ok.");
