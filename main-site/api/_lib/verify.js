// Replays a submitted game with the same modules the browser plays with,
// and works out what it is worth. Nothing a browser says about a game is
// taken on trust: the moves are replayed from the seed, the result is read
// off the final board, the computer's every move is played again, each
// turn's time comes from the server's own stamps, and the score is computed
// here.

import { chooseMove, thinkPause } from "../../js/ai.js";
import { replay, outcomeWith, validEnd, endText, MAX_PLIES } from "../../js/record.js";
import { parseSeed, moveRandom } from "../../js/seed.js";
import { finalScore, percentFor, progress, resultFor, timeBonus, turnBonus } from "../../js/score.js";
import { HttpError } from "./http.js";

export function readMoves(value) {
  if (Array.isArray(value) && value.length === 0) {
    throw new HttpError(400, "no_moves", "A game needs at least one move to go on the leaderboard.");
  }
  if (!Array.isArray(value) || value.length > MAX_PLIES || !value.every((m) => Number.isInteger(m) && m >= 0 && m < 25)) {
    throw new HttpError(400, "bad_moves", "Those moves could not be read.");
  }
  return value;
}

// { by: "resign", side: "x" | "o" } from a request, to the shared form.
export function readEnd(value) {
  if (value == null) return null;
  const end = { by: value.by, side: value.side === "x" ? 0 : value.side === "o" ? 1 : null };
  if (!validEnd(end)) throw new HttpError(400, "bad_end");
  return end;
}

// The moves as the database stores them: one string, with any resignation.
export function movesText(moves, end) {
  return moves.join(" ") + endText(end);
}

// The replayed game and how it ended, with any resignation checked.
export function settle(game, moves, end) {
  const seed = parseSeed(game.seed);
  if (!seed || seed.size !== game.size) throw new HttpError(500, "bad_seed");

  const record = replay(seed, moves);
  if (record.error) {
    throw new HttpError(409, "illegal", `Move ${record.error.ply + 1} is not a legal move in this game.`);
  }
  if (end && record.outcome) throw new HttpError(409, "illegal", "The game had already ended on the board.");
  if (end && game.mode === "computer" && end.side !== game.first_side) {
    throw new HttpError(409, "illegal", "The computer never resigns.");
  }

  const outcome = outcomeWith(record, end);
  if (!outcome) throw new HttpError(409, "unfinished", "Only a finished game can go on the leaderboard.");
  return { seed, record, outcome };
}

// The server's time for every ply of `moves`, or null where it has none.
//
// events: the game's oxogame_events rows in the order they arrived, each a
// move stamped when it reached the server or an undo. A ply's time runs
// from the event before its stamp to the stamp:
//
//   the start ticket   for the first move, or the player's first move when
//                      the computer went first
//   an undo            the turn restarted there
//   a move             the other player's move in a network game, or the
//                      player's own previous move against the computer, less
//                      the computer's fixed pause before it replied
//
// Anything else, including a move before that was stamped for a different
// cell, means a stamp went missing, and the turn gets no time rather than a
// wrong one. Moves the server never heard of, the computer's
// included, have none.
export function turnTimes(game, moves, events) {
  const start = Date.parse(game.created_at);
  const computer = game.mode === "computer";
  const pause = computer ? thinkPause(game.difficulty) : 0;
  const log = (events ?? []).map((e) => ({ kind: e.kind, side: e.side, ply: e.ply, cell: e.cell, t: Date.parse(e.at) }));

  return moves.map((cell, ply) => {
    let at = -1;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].kind === "move" && log[i].ply === ply) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const stamp = log[at];
    // Stamped for a move later undone and replaced by another.
    if (stamp.cell !== cell || stamp.side !== ply % 2) return null;

    const before = at > 0 ? log[at - 1] : null;
    let from;
    let afterComputer = false;
    if (!before) {
      if (ply > (computer ? 1 : 0)) return null;
      from = start;
      afterComputer = computer && ply === 1;
    } else if (before.kind === "undo") {
      from = before.t;
    } else {
      if (before.ply !== (computer ? ply - 2 : ply - 1) || before.cell !== moves[before.ply]) return null;
      from = before.t;
      afterComputer = computer;
    }
    return Math.max(0, stamp.t - from - (afterComputer ? pause : 0));
  });
}

// game: the oxogame_games row. side: 0 or 1, the side being submitted. end:
// a resignation or null. undos: the side's undo count, already the higher of
// the browser's and the server's. elapsedMs: start ticket to the game's end.
// events: the game's stamped moves and undos, oldest first.
export function verify(game, moves, side, end, undos, elapsedMs, events) {
  if (game.mode === "computer" && side !== game.first_side) {
    throw new HttpError(400, "bad_side", "Only the player's side of a computer game can be submitted.");
  }
  const { seed, record, outcome } = settle(game, moves, end);

  // Every one of the computer's moves has to be the move it would play.
  if (game.mode === "computer") {
    const computer = game.first_side ^ 1;
    const board = new Array(seed.size * seed.size).fill(-1);
    for (let ply = 0; ply < moves.length; ply++) {
      if (ply % 2 === computer) {
        const pick = chooseMove(board, seed.size, computer, game.difficulty, moveRandom(seed, game.difficulty, ply));
        if (pick !== moves[ply]) {
          throw new HttpError(409, "not_computer", "Those moves were not played against this computer.");
        }
      }
      board[moves[ply]] = ply % 2;
    }
  }

  const result = resultFor(outcome.winner, side);
  const serverSeed = game.server_seed === true;
  const turnMs = turnTimes(game, moves, events);
  const turns = turnBonus(turnMs, side, result, serverSeed);
  const bonus = timeBonus(result, elapsedMs, serverSeed, seed.size);
  return {
    outcome: result,
    ownMoves: progress(record.plies, side).own,
    turnMs,
    turnBonus: turns,
    timeBonus: bonus,
    score: finalScore({
      plies: record.plies,
      side,
      result,
      size: seed.size,
      percent: percentFor(game.mode, game.difficulty, seed.size),
      undos,
      turns,
      bonusPercent: bonus,
    }),
  };
}
