// The computer. Negamax with alpha-beta pruning, looking a set number of
// moves ahead, and a spread around its best move that makes the weaker
// levels play decent but not best moves. Pure and deterministic: it stops on
// a count of positions rather than a clock and draws its dice from the seed,
// never from Math.random, which is what lets the API replay a game and check
// every move the computer made.
//
// On 3x3 Master searches to the end of the game and cannot be beaten. On
// 4x4 and 5x5 it looks as far as its budget allows.

import { EMPTY, geometry, winningLine } from "./rules.js";

// depth: moves looked ahead. spread: how far below its best score a move
// may be and still be picked. blunder: percent of moves played without
// looking. budget: positions it may look at per move.
export const LEVELS = [
  null,
  { name: "Beginner", depth: 1, spread: 400, blunder: 30, budget: 5000 },
  { name: "Casual", depth: 2, spread: 120, blunder: 10, budget: 20000 },
  { name: "Steady", depth: 3, spread: 30, blunder: 3, budget: 60000 },
  { name: "Sharp", depth: 5, spread: 5, blunder: 0, budget: 120000 },
  { name: "Master", depth: 25, spread: 0, blunder: 0, budget: 150000 },
];

// The pause before the computer shows its move, so it is seen to happen.
// The API takes the same pause off the player's next turn time.
export function thinkPause(level) {
  return 300 + level * 60;
}

const WIN = 1000000;
const INF = 2 * WIN;
const ABORT = Symbol("budget");

// A line worth to a side that alone has marks in it, by how many more it
// needs: one more is nearly a win.
const NEED_WEIGHT = [0, 300, 40, 6, 1];
// The same idea for ordering moves, by marks already in the line.
const ORDER_WEIGHT = [1, 4, 20, 150];

function evaluate(board, geo, side) {
  let score = 0;
  for (const line of geo.lines) {
    let mine = 0;
    let theirs = 0;
    for (const c of line) {
      const v = board[c];
      if (v === side) mine++;
      else if (v !== EMPTY) theirs++;
    }
    if (mine && !theirs) score += NEED_WEIGHT[geo.k - mine];
    else if (theirs && !mine) score -= NEED_WEIGHT[geo.k - theirs];
  }
  return score;
}

// The cells worth trying, best first: a win, then a block, then cells in
// the most open lines. On the bigger boards only cells next to a mark,
// since a move far from everything is never better than one beside it.
function candidates(board, geo, side, filled) {
  const out = [];
  for (let cell = 0; cell < geo.cells; cell++) {
    if (board[cell] !== EMPTY) continue;
    if (geo.size >= 5 && filled > 0 && !geo.near[cell].some((n) => board[n] !== EMPTY)) continue;
    let key = 0;
    for (const i of geo.through[cell]) {
      let mine = 0;
      let theirs = 0;
      for (const c of geo.lines[i]) {
        const v = board[c];
        if (v === side) mine++;
        else if (v !== EMPTY) theirs++;
      }
      if (!theirs) key += mine === geo.k - 1 ? 1000000 : ORDER_WEIGHT[mine];
      if (!mine) key += theirs === geo.k - 1 ? 100000 : ORDER_WEIGHT[theirs];
    }
    out.push({ cell, key });
  }
  // Stable, so equal cells keep board order and the result never varies.
  out.sort((a, b) => b.key - a.key);
  return out.map((m) => m.cell);
}

function search(ctx, side, depth, alpha, beta, ply) {
  if (++ctx.nodes > ctx.budget) throw ABORT;
  if (ctx.filled === ctx.geo.cells) return 0;
  if (depth === 0) return evaluate(ctx.board, ctx.geo, side);

  let best = -INF;
  for (const cell of candidates(ctx.board, ctx.geo, side, ctx.filled)) {
    ctx.board[cell] = side;
    ctx.filled++;
    let score;
    try {
      score = winningLine(ctx.board, ctx.geo, cell, side)
        ? WIN - ply - 1
        : -search(ctx, side ^ 1, depth - 1, -beta, -alpha, ply + 1);
    } finally {
      ctx.board[cell] = EMPTY;
      ctx.filled--;
    }
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Every root move's score, exactly where it is within `spread` of the best
// and as an upper bound where it is not, so the moves close to the best can
// be told apart without searching the rest in full.
function searchRoot(ctx, side, depth, spread) {
  const scored = [];
  let best = -INF;
  let floor = -INF;
  for (const cell of candidates(ctx.board, ctx.geo, side, ctx.filled)) {
    ctx.board[cell] = side;
    ctx.filled++;
    let score;
    try {
      score = winningLine(ctx.board, ctx.geo, cell, side)
        ? WIN - 1
        : -search(ctx, side ^ 1, depth - 1, -INF, -floor, 1);
    } finally {
      ctx.board[cell] = EMPTY;
      ctx.filled--;
    }
    scored.push({ cell, score });
    if (score > best) {
      best = score;
      floor = best - spread - 1;
    }
  }
  return { best, picks: scored.filter((m) => m.score >= best - spread).map((m) => m.cell) };
}

// The computer's move for `side` on `board` (cells: -1 empty, 0 X, 1 O),
// or null on a full board. `random` is moveRandom() for this move.
export function chooseMove(board, size, side, level, random) {
  const geo = geometry(size);
  const spec = LEVELS[level];
  const empty = [];
  for (let c = 0; c < geo.cells; c++) if (board[c] === EMPTY) empty.push(c);
  if (!empty.length || !spec) return null;

  if (spec.blunder && random() % 100 < spec.blunder) return empty[random() % empty.length];

  const ctx = { board: board.slice(), geo, filled: geo.cells - empty.length, nodes: 0, budget: spec.budget };
  let result = null;
  // Deeper one move at a time, keeping the last search that finished within
  // the budget. The first always does: it looks at no more than 25 positions.
  for (let depth = 1; depth <= Math.min(spec.depth, empty.length); depth++) {
    try {
      result = searchRoot(ctx, side, depth, spec.spread);
    } catch (err) {
      if (err !== ABORT) throw err;
      break;
    }
    // A forced win or loss found: looking further changes nothing.
    if (Math.abs(result.best) > WIN - 100) break;
  }
  return result.picks[random() % result.picks.length];
}
