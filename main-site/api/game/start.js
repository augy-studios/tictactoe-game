// POST /api/game/start
//   { client_key, mode, seed?, size?, difficulty?, side? }
//   -> { game_id, seed, first_side, server_seed, created_at }
// The start ticket. A game can only go on the leaderboard if it began here,
// which is what gives it a start time no browser can move. Games started
// offline play the same; they just have no ticket.
//
// With no seed, the server picks one on a `size` board (3, 4 or 5). Only
// those games earn the time bonuses: a seed the player chose could have been
// practised beforehand.

import { endpoint, HttpError, clientKey, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { newSeed, parseSeed } from "../../js/seed.js";
import { SIZES } from "../../js/rules.js";

export default endpoint("POST", async ({ req, body }) => {
  const key = clientKey(body.client_key);
  const mode = body.mode;
  if (mode !== "computer" && mode !== "network") throw new HttpError(400, "bad_mode");

  let seed;
  const serverSeed = body.seed == null;
  if (serverSeed) {
    const size = body.size ?? 3;
    if (!SIZES.includes(size)) throw new HttpError(400, "bad_size");
    seed = newSeed(size);
  } else {
    seed = parseSeed(body.seed);
    if (!seed) throw new HttpError(400, "bad_seed");
  }

  let difficulty = null;
  if (mode === "computer") {
    difficulty = Number(body.difficulty);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) throw new HttpError(400, "bad_difficulty");
  }

  // A mark the player chose, or the seed's.
  let firstSide = seed.firstSide;
  if (body.side === "x") firstSide = 0;
  else if (body.side === "o") firstSide = 1;
  else if (body.side != null) throw new HttpError(400, "bad_side");

  await limit(req, "start", 600, 60);

  const [row] = await rest("oxogame_games?select=id,created_at", {
    method: "POST",
    prefer: "return=representation",
    body: {
      mode,
      seed: seed.text,
      size: seed.size,
      first_side: firstSide,
      difficulty,
      host_key: key,
      server_seed: serverSeed,
    },
  });

  // Now and then, clear out what nobody will submit.
  if (Math.random() < 0.02) rpc("oxogame_prune", {}).catch(() => {});

  return { game_id: row.id, seed: seed.text, first_side: firstSide, server_seed: serverSeed, created_at: row.created_at };
});
