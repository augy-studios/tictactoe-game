// POST /api/game/submit
//   { game_id, client_key, name, side, moves, end?, undos? }
//   -> { name, score, outcome, turn_bonus, time_bonus, turn_ms, elapsed_ms,
//        rank, best_score, total, games, total_rank }
// side is "x" or "o". moves is the whole game as cell numbers. end is a
// resignation, { by: "resign", side }. The score is computed here from the
// replayed moves and the server's own times; see verify.js for the checks
// on the game and the SQL functions for the rest.

import { endpoint, HttpError, clientKey, gameId, side as readSide, limit } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest, rpc } from "../_lib/supabase.js";
import { readEnd, readMoves, verify, movesText } from "../_lib/verify.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  expired: [410, "That game started more than 12 hours ago."],
  not_yours: [403, "That game was started in a different browser."],
  same_device: [409, "Both sides of that game were played from one browser, so it stays off the leaderboard."],
  already_submitted: [409, "That game is already on the leaderboard."],
  mismatch: [409, "Those moves do not match the ones your opponent submitted."],
  too_fast: [409, "That game was played too quickly to count."],
  same_name: [409, "Your opponent is already on the leaderboard for this game under that name. Pick another."],
  overlap: [409, "That game was played at the same time as another one already on the leaderboard under this name."],
  seed_used: [409, "That name already has this seed at this level on the leaderboard. Try a new seed."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const who = readSide(body.side);
  const moves = readMoves(body.moves);
  const end = readEnd(body.end);
  const reported = Number.isInteger(body.undos) && body.undos >= 0 ? Math.min(body.undos, 10000) : 0;

  // Replaying the Master level on a 5x5 board is real work, so this is
  // limited harder than anything else.
  await limit(req, "submit", 600, 30);

  const [game] = (await rest(`oxogame_games?id=eq.${id}&select=*`)) ?? [];
  if (!game) throw new HttpError(404, "not_found", REFUSALS.not_found[1]);
  const events = await rest(`oxogame_events?game_id=eq.${id}&select=kind,side,ply,cell,at&order=id.asc`);

  // The game's end as the server saw it: when the page reported it, if the
  // moves then are these moves, and otherwise now.
  const text = movesText(moves, end);
  const endedAt = game.finished_at && game.moves === text ? Date.parse(game.finished_at) : Date.now();
  const elapsed = endedAt - Date.parse(game.created_at);

  const recorded = who === 0 ? game.undos_x : game.undos_o;
  const result = verify(game, moves, who, end, Math.max(reported, recorded ?? 0), elapsed, events);

  const [row] =
    (await rpc("oxogame_submit", {
      p_game_id: id,
      p_side: who,
      p_name: name,
      p_client_key: key,
      p_moves: text,
      p_score: result.score,
      p_outcome: result.outcome,
      p_own_moves: result.ownMoves,
    })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not submit."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  return {
    name,
    score: result.score,
    outcome: result.outcome,
    turn_bonus: result.turnBonus,
    time_bonus: result.timeBonus,
    turn_ms: result.turnMs,
    elapsed_ms: elapsed,
    rank: Number(row.rank),
    best_score: row.best_score,
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
  };
});
