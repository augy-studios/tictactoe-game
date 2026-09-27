// GET /api/leaderboard?board=best|total
//   best  (default) -> { board, entries: [{ rank, name, score, mode, difficulty, size, outcome }] }
//   total           -> { board, entries: [{ rank, name, total, games }] }
// Public, no login, one row per name, cached briefly at the edge.

import { endpoint, HttpError } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

const LIMIT = 100;

const BOARDS = {
  best: {
    query: `oxogame_leaderboard_best?select=name,score,mode,difficulty,size,outcome&order=score.desc,created_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, score: r.score, mode: r.mode, difficulty: r.difficulty, size: r.size, outcome: r.outcome }),
  },
  total: {
    query: `oxogame_leaderboard_total?select=name,total,games&order=total.desc,games.asc,last_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, total: Number(r.total), games: r.games }),
  },
};

export default endpoint("GET", async ({ req, res }) => {
  const board = req.query?.board ?? "best";
  const spec = BOARDS[board];
  if (!spec) throw new HttpError(400, "bad_board", "board is best or total.");

  const rows = await rest(spec.query);
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  return { board, entries: (rows ?? []).map((r, i) => ({ rank: i + 1, ...spec.row(r) })) };
});
