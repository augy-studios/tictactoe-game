#!/usr/bin/env node
// The computer: the same seed always plays the same game, Master cannot be
// beaten on 3x3 whatever the player does, and every level answers quickly on
// every board. With --matches, each level plays the one below it.
//
// Run: node scripts/test-ai.mjs [--matches]

import { chooseMove, LEVELS } from "../main-site/js/ai.js";
import { emptyBoard, geometry, winningLine, SIZES } from "../main-site/js/rules.js";
import { newSeed, parseSeed, moveRandom } from "../main-site/js/seed.js";

const failures = [];

// Plays two levels against each other on `seed`; returns the winner or -1.
function match(seed, levels) {
  const geo = geometry(seed.size);
  const board = emptyBoard(seed.size);
  for (let ply = 0; ply < geo.cells; ply++) {
    const side = ply % 2;
    const cell = chooseMove(board, seed.size, side, levels[side], moveRandom(seed, levels[side], ply));
    board[cell] = side;
    if (winningLine(board, geo, cell, side)) return { winner: side, board };
  }
  return { winner: -1, board };
}

// Same seed, same game.
for (const size of SIZES) {
  const seed = newSeed(size);
  const a = match(seed, [3, 4]);
  const b = match(parseSeed(seed.text), [3, 4]);
  if (a.board.join() !== b.board.join()) failures.push(`${seed.text}: two plays of one seed differ`);
}

// Master on 3x3, against every line a player could try, from both sides.
let games = 0;
function everyLine(seed, board, ply, masterSide) {
  const geo = geometry(3);
  const side = ply % 2;
  if (side === masterSide) {
    const cell = chooseMove(board, 3, side, 5, moveRandom(seed, 5, ply));
    board[cell] = side;
    if (!winningLine(board, geo, cell, side) && ply + 1 < 9) everyLine(seed, board, ply + 1, masterSide);
    else games++;
    board[cell] = -1;
    return;
  }
  for (let cell = 0; cell < 9; cell++) {
    if (board[cell] !== -1) continue;
    board[cell] = side;
    if (winningLine(board, geo, cell, side)) {
      failures.push(`Master lost on 3x3 as ${"XO"[masterSide]} to ${board.join(",")}`);
      games++;
    } else if (ply + 1 < 9) everyLine(seed, board, ply + 1, masterSide);
    else games++;
    board[cell] = -1;
  }
}
for (const text of ["3X3-BXK4-M9TR", "3X3-2222-ZZZZ"]) {
  for (const masterSide of [0, 1]) everyLine(parseSeed(text), emptyBoard(3), 0, masterSide);
}
console.log(`Master unbeaten across ${games} games on 3x3`);

// Speed: the slowest single move per level and board, over a few games.
for (const size of SIZES) {
  const row = [];
  for (let level = 1; level <= 5; level++) {
    let slowest = 0;
    for (let n = 0; n < 3; n++) {
      const seed = newSeed(size);
      const geo = geometry(size);
      const board = emptyBoard(size);
      for (let ply = 0; ply < geo.cells; ply++) {
        const side = ply % 2;
        const who = side === 0 ? level : 3;
        const t = performance.now();
        const cell = chooseMove(board, size, side, who, moveRandom(seed, who, ply));
        const ms = performance.now() - t;
        if (who === level) slowest = Math.max(slowest, ms);
        board[cell] = side;
        if (winningLine(board, geo, cell, side)) break;
      }
    }
    row.push(`${LEVELS[level].name} ${Math.round(slowest)} ms`);
    if (slowest > 3000) failures.push(`${size}x${size} ${LEVELS[level].name}: a move took ${Math.round(slowest)} ms`);
  }
  console.log(`${size}x${size}: ${row.join(", ")}`);
}

if (process.argv.includes("--matches")) {
  for (const size of SIZES) {
    for (let level = 2; level <= 5; level++) {
      const tally = { stronger: 0, weaker: 0, draw: 0 };
      for (let n = 0; n < 20; n++) {
        const seed = newSeed(size);
        // Alternate who moves first.
        const strongSide = n % 2;
        const levels = strongSide === 0 ? [level, level - 1] : [level - 1, level];
        const { winner } = match(seed, levels);
        if (winner === -1) tally.draw++;
        else if (winner === strongSide) tally.stronger++;
        else tally.weaker++;
      }
      console.log(`${size}x${size} ${LEVELS[level].name} v ${LEVELS[level - 1].name}: won ${tally.stronger}, lost ${tally.weaker}, drew ${tally.draw}`);
      if (tally.weaker > tally.stronger) failures.push(`${size}x${size}: ${LEVELS[level].name} lost more than it won to ${LEVELS[level - 1].name}`);
    }
  }
}

if (failures.length) {
  console.error("ai test failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("ai ok.");
