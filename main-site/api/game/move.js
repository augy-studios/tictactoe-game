// POST /api/game/move  { game_id, client_key, side, ply, cell } -> { ok }
// Stamps one move with the server's clock as it is played. These stamps are
// the only times the turn bonus is measured from; see _lib/verify.js. The
// browser sends this and carries on regardless, so a refused or unknown
// game answers { ok: false } rather than an error, and that move simply
// earns no turn bonus.

import { endpoint, HttpError, clientKey, gameId, side, limit } from "../_lib/http.js";
import { rpc } from "../_lib/supabase.js";

const cellNumber = (n) => Number.isInteger(n) && n >= 0 && n < 25;

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const who = side(body.side);
  if (!cellNumber(body.ply) || !cellNumber(body.cell)) throw new HttpError(400, "bad_move");

  // A 5x5 game is at most 13 moves a side, so this is generous.
  await limit(req, "move", 600, 400);

  const ok = await rpc("oxogame_move", { p_game_id: id, p_client_key: key, p_side: who, p_ply: body.ply, p_cell: body.cell });
  return { ok: ok === true };
});
