// Asks the computer for a move. In a Web Worker where the browser supports
// module workers, on this thread otherwise. Only the latest request is
// answered: an undo or a new game makes any pending one stale.

let worker = null;
let workerFailed = false;
let latest = 0;
const waiting = new Map();

function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e) => {
      const resolve = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      resolve?.(e.data.cell);
    });
    worker.addEventListener("error", () => {
      // A browser without module workers: fall back for this and every
      // later request.
      workerFailed = true;
      worker = null;
      for (const [id, resolve] of waiting) runHere(id, resolve);
      waiting.clear();
    });
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

let pendingHere = null;

async function runHere(id, resolve) {
  const { seed: seedText, level, moves } = pendingHere;
  const [{ chooseMove }, { replay }, { parseSeed, moveRandom }] = await Promise.all([
    import("./ai.js"),
    import("./record.js"),
    import("./seed.js"),
  ]);
  const seed = parseSeed(seedText);
  const record = replay(seed, moves);
  resolve(chooseMove(record.board, seed.size, record.turn, level, moveRandom(seed, level, moves.length)));
}

// Resolves with the cell, or null if a newer request replaced this one.
export function requestMove(seedText, level, moves) {
  const id = ++latest;
  const payload = { id, seed: seedText, level, moves: moves.slice() };
  return new Promise((resolve) => {
    const done = (cell) => resolve(id === latest ? cell : null);
    const w = getWorker();
    pendingHere = payload;
    if (w) {
      waiting.set(id, done);
      w.postMessage(payload);
    } else {
      // Let the page paint "thinking" first.
      setTimeout(() => runHere(id, done), 30);
    }
  });
}

// Makes any request in flight stale.
export function cancelMove() {
  latest++;
}
