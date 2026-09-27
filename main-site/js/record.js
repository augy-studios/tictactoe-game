// A game as a seed and a list of moves, replayed into everything the page,
// the replay and the API need: the board after each move, what each move
// threatened or blocked, and how the game ended. Pure, like rules.js.
//
// A move is a cell number, counted from the top left along each row.

import { EMPTY, geometry, sideOf, winningLine } from "./rules.js";

export const MAX_PLIES = 25;

// What playing `cell` does for `side`, measured before it is played:
// lines it leaves one short of a win (threats), and lines it stops the
// other side finishing (blocks).
function measure(board, geo, cell, side) {
  let threats = 0;
  let blocks = 0;
  for (const i of geo.through[cell]) {
    let mine = 0;
    let theirs = 0;
    for (const c of geo.lines[i]) {
      const v = board[c];
      if (v === side) mine++;
      else if (v !== EMPTY) theirs++;
    }
    if (!theirs && mine === geo.k - 2) threats++;
    if (!mine && theirs === geo.k - 1) blocks++;
  }
  return { threats, blocks };
}

// Replays `moves` on the seed's board. Stops at the first move that is not
// legal and says where.
export function replay(seed, moves) {
  const geo = geometry(seed.size);
  const board = new Array(geo.cells).fill(EMPTY);
  const plies = [];
  let error = null;
  let outcome = null;

  for (let i = 0; i < moves.length; i++) {
    const cell = moves[i];
    if (i >= MAX_PLIES) {
      error = { ply: i, reason: "too_long" };
      break;
    }
    if (outcome) {
      error = { ply: i, reason: "after_end" };
      break;
    }
    if (!Number.isInteger(cell) || cell < 0 || cell >= geo.cells || board[cell] !== EMPTY) {
      error = { ply: i, reason: "illegal" };
      break;
    }
    const side = sideOf(i);
    const { threats, blocks } = measure(board, geo, cell, side);
    board[cell] = side;
    const line = winningLine(board, geo, cell, side);
    plies.push({ cell, side, threats, blocks, win: Boolean(line) });
    if (line) outcome = { winner: side, reason: "line", line };
    else if (i + 1 === geo.cells) outcome = { winner: -1, reason: "full", line: null };
  }

  return { geo, board, plies, turn: sideOf(plies.length), error, outcome: error ? null : outcome };
}

/* ---- endings off the board ----
   A game can also end by a resignation, written { by: "resign", side }. The
   page, the network snapshot, the replay link and the API all use this one
   form. */

export function validEnd(end) {
  if (end === null) return true;
  return Boolean(end) && typeof end === "object" && end.by === "resign" && (end.side === 0 || end.side === 1);
}

// The game's outcome counting a resignation, or null if it goes on. A
// resignation after the board had already ended the game does not count.
export function outcomeWith(record, end) {
  if (record.outcome || !end) return record.outcome;
  return { winner: end.side ^ 1, reason: "resign", line: null };
}

// A resignation as text, appended to the moves wherever they are stored as
// one string, so two submissions of one game compare equal only if they
// agree.
export function endText(end) {
  return end ? ` resign:${end.side}` : "";
}

// The board after each ply, for stepping through a replay. Index 0 is the
// empty board.
export function positions(seed, moves) {
  const geo = geometry(seed.size);
  const board = new Array(geo.cells).fill(EMPTY);
  const out = [board.slice()];
  moves.forEach((cell, i) => {
    board[cell] = sideOf(i);
    out.push(board.slice());
  });
  return out;
}

/* ---- packing a game into a link ----
   One character a move, the cell number in base 25 (0 to 9, then a to o),
   so a 5x5 game is at most 25 characters. A damaged link cannot unpack to
   an illegal game: it stops, and says so. */

const CELL_CHARS = "0123456789abcdefghijklmno";

export function packMoves(moves) {
  return moves.map((cell) => CELL_CHARS[cell]).join("");
}

// The move list a packed string stands for, or null if it is damaged.
export function unpackMoves(seed, packed) {
  const text = String(packed ?? "");
  if (text.length > MAX_PLIES) return null;
  const moves = [...text].map((ch) => CELL_CHARS.indexOf(ch));
  const record = replay(seed, moves);
  return record.error ? null : moves;
}
