// POST /api/game/finish  { game_id, client_key, moves, end? }
//   -> { elapsed_ms, server_seed, turn_ms }
// Sent by the page the moment a game ends, so the server's clock stops then
// and not whenever somebody gets round to submitting. The moves are
// replayed and any resignation checked, as on submit, but the computer's
// moves are left for submit to check: this has to be quick. turn_ms is the
// server's time for every ply, null where it has none, so the page can show
// the same score the leaderboard will give.

import { endpoint, HttpError, clientKey, gameId, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { readEnd, readMoves, settle, movesText, turnTimes } from "../_lib/verify.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  expired: [410, "That game started more than 12 hours ago."],
  not_yours: [403, "That game was started in a different browser."],
  mismatch: [409, "That game is already on the leaderboard with other moves."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const moves = readMoves(body.moves);
  const end = readEnd(body.end);

  await limit(req, "finish", 600, 60);

  const [game] = (await rest(`oxogame_games?id=eq.${id}&select=*`)) ?? [];
  if (!game) throw new HttpError(404, "not_found", REFUSALS.not_found[1]);
  settle(game, moves, end);

  const [row] = (await rpc("oxogame_finish", { p_game_id: id, p_client_key: key, p_moves: movesText(moves, end) })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not record the end of the game."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  const events = await rest(`oxogame_events?game_id=eq.${id}&select=kind,side,ply,cell,at&order=id.asc`);
  return {
    elapsed_ms: Date.parse(row.finished_at) - Date.parse(row.created_at),
    server_seed: game.server_seed === true,
    turn_ms: turnTimes(game, moves, events),
  };
});
