// The computer thinks here, off the page's thread, so the board stays
// responsive while Master searches a 5x5 board. It rebuilds the game from the
// seed and the moves, exactly as the API does when it checks a game.

import { chooseMove } from "./ai.js";
import { replay } from "./record.js";
import { parseSeed, moveRandom } from "./seed.js";

self.addEventListener("message", (event) => {
  const { id, seed: seedText, level, moves } = event.data ?? {};
  const seed = parseSeed(seedText);
  const record = seed && Array.isArray(moves) ? replay(seed, moves) : null;
  if (!record || record.error || record.outcome) {
    self.postMessage({ id, cell: null });
    return;
  }
  const cell = chooseMove(record.board, seed.size, record.turn, level, moveRandom(seed, level, moves.length));
  self.postMessage({ id, cell });
});
