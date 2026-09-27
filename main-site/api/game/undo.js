// POST /api/game/undo  { game_id, client_key, side } -> { undos }
// Counts an undo on the server as it happens, and stamps it, since a turn
// after an undo is timed from the undo. Undo is unlimited and costs points;
// the submit charges the higher of this count and the browser's own. A
// refused or unknown game answers { undos: null } rather than an error: the
// browser sends this and carries on regardless.

import { endpoint, clientKey, gameId, side } from "../_lib/http.js";
import { rpc } from "../_lib/supabase.js";

export default endpoint("POST", async ({ body }) => {
  const undos = await rpc("oxogame_undo", {
    p_game_id: gameId(body.game_id),
    p_client_key: clientKey(body.client_key),
    p_side: side(body.side),
  });
  return { undos: typeof undos === "number" ? undos : null };
});
