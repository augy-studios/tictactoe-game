// The game screen: choosing a game, playing it, and what happens after.
//
// A game is a seed and a list of moves, and everything on screen is derived
// from those two by replaying them, plus a resignation if there was one.
// That is also all that is saved, sent to the other device in a network
// game, put in a replay link, and submitted to the leaderboard, where the
// API replays it the same way.

import { SIDE_NAME, SIZES, cellName, finishingCells } from "./rules.js";
import { BoardView, markSvg } from "./board.js";
import { replay as replayGame, packMoves, unpackMoves, outcomeWith, validEnd, MAX_PLIES } from "./record.js";
import { newSeed, parseSeed } from "./seed.js";
import { LEVELS, thinkPause } from "./ai.js";
import { requestMove, cancelMove } from "./computer.js";
import { finalScore, liveScore, percentFor, resultFor, timeBonus, turnBonus, UNDO_COST, TIME_BONUS_MAX, TIME_WINDOW_MS } from "./score.js";
import { api } from "./api.js";
import { getSettings, onSettingsChange, saveSettings } from "./settings.js";
import { openLeaderboard } from "./leaderboard.js";
import { Replay } from "./replay.js";
import { copyText, hydrateIcons, store } from "./ui.js";
import { confetti } from "./confetti.js";

const GAME_STORAGE = "oxogame.game";
const SETUP_STORAGE = "oxogame.setup";
const SIDE_LETTER = ["x", "o"];
const IN_A_ROW = { 3: "three", 4: "four", 5: "five" };
// How long to wait for the server to pick a seed before starting offline.
const START_WAIT_MS = 5000;

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;
let g = null; // the game on screen, or null
let rec = null; // replayGame(g.seed, g.moves), refreshed on every change
let thinking = false;
let launching = false;
let gameCounter = 0;
let resignTimer = null;
let leaveTimer = null;
let net = null; // set by multiplayer.js for network games
let watching = null; // a shared replay being watched: { seed, moves, end, meta }

/* ---- setup ---- */

// side: "x", "o", or "seed" to let the seed decide.
const setup = { mode: "computer", level: 3, size: 3, side: "seed" };

function loadSetup() {
  const saved = store.getJSON(SETUP_STORAGE) ?? {};
  if (["computer", "local", "network"].includes(saved.mode)) setup.mode = saved.mode;
  if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= 5) setup.level = saved.level;
  if (SIZES.includes(saved.size)) setup.size = saved.size;
  if (["x", "o", "seed"].includes(saved.side)) setup.side = saved.side;
}

function saveSetup() {
  store.set(SETUP_STORAGE, setup);
}

const PLAY_NOTES = {
  computer: "Scored on the leaderboard when the game starts while you are online.",
  local: "Two players taking turns on this device. Not scored.",
  network: "Play someone on the same wifi, or sharing a hotspot. Scored when started online.",
};

function sizeNote(size) {
  if (size === 3) return "The classic game: three in a row wins.";
  return `${size === 4 ? "Four" : "Five"} in a row wins, on ${size * size} cells. Scores ${size === 4 ? "a quarter" : "half"} as much again.`;
}

function renderSetup() {
  const check = (sel, attr, value) =>
    document.querySelectorAll(sel).forEach((el) => el.setAttribute("aria-checked", String(el.dataset[attr] === String(value))));
  check("#modePick [data-pick]", "pick", setup.mode);
  check("#levelPick [data-level]", "level", setup.level);
  check("#sizePick [data-size]", "size", setup.size);
  check("#sidePick [data-side]", "side", setup.side);
  $("levelGroup").classList.toggle("hidden", setup.mode !== "computer");
  $("sideGroup").classList.toggle("hidden", setup.mode === "local");
  $("sideLabel").textContent = setup.mode === "network" ? "Host plays as" : "Play as";
  $("joinForm").classList.toggle("hidden", setup.mode !== "network");
  $("startLabel").textContent = launching ? "Starting" : setup.mode === "network" ? "Host a game" : "Start game";
  $("startBtn").disabled = launching;
  $("playNote").textContent = PLAY_NOTES[setup.mode];
  $("sizeNote").textContent = sizeNote(setup.size);
}

function shake(input) {
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus();
}

function onStart() {
  const typed = $("seedInput").value.trim() !== "";
  const seed = typed ? parseSeed($("seedInput").value, setup.size) : null;
  if (typed && !seed) {
    $("seedNote").textContent = "That is not a seed. Seeds look like 3X3-BXK4-M9TR.";
    return shake($("seedInput"));
  }
  const sideChoice = setup.side === "seed" ? null : setup.side;
  if (setup.mode === "network") {
    net?.host({ seed, size: seed?.size ?? setup.size, side: sideChoice });
    return;
  }
  launch({
    mode: setup.mode,
    seed,
    size: seed?.size ?? setup.size,
    level: setup.level,
    sideChoice: setup.mode === "local" ? null : sideChoice,
  });
}

function setLaunching(on) {
  launching = on;
  $("againBtn").disabled = on;
  renderSetup();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// Starts a game. With no seed, a scored game asks the server to pick one
// (only those earn the time bonuses); if it cannot be reached in a few
// seconds, the game starts anyway on a seed of its own, unscored. A pasted
// seed starts at once and fetches its ticket meanwhile. Resolves with the
// game, or null if a start was already under way.
export async function launch(opts) {
  const { mode, size = 3, level = null, sideChoice = null, role = null } = opts;
  if (mode === "local" || opts.seed) return startGame({ ...opts, seed: opts.seed ?? newSeed(size) });
  if (launching) return null;
  setLaunching(true);
  let ticket = null;
  try {
    ticket = await withTimeout(
      api.start({ mode, size, difficulty: level ?? undefined, side: sideChoice ?? undefined }),
      START_WAIT_MS
    );
  } catch {
    ticket = null;
  }
  setLaunching(false);
  const seed = ticket && parseSeed(ticket.seed);
  if (seed) {
    return startGame({
      mode,
      role,
      seed,
      level,
      sideChoice,
      firstSide: ticket.first_side,
      gameId: ticket.game_id,
      ticket: "ok",
      serverSeed: ticket.server_seed === true,
    });
  }
  return startGame({ mode, role, seed: newSeed(size), level, sideChoice, ticket: "offline" });
}

/* ---- the game ---- */

// opts: { mode, seed, level?, sideChoice ("x" | "o" | null), role?,
// firstSide?, gameId?, moves?, undos?, end?, submitted?, ticket?,
// serverSeed?, startedAt?, elapsed?, turnMs? }
export function startGame(opts) {
  cancelMove();
  thinking = false;
  replayer.stop();
  if (watching) closeWatch({ show: false });
  const sideChoice = opts.sideChoice ?? null;
  g = {
    id: ++gameCounter,
    mode: opts.mode,
    role: opts.role ?? null,
    seed: opts.seed,
    level: opts.mode === "computer" ? opts.level : null,
    sideChoice,
    firstSide: opts.firstSide ?? (sideChoice === "x" ? 0 : sideChoice === "o" ? 1 : opts.seed.firstSide),
    moves: opts.moves?.slice() ?? [],
    undos: opts.undos?.slice() ?? [0, 0],
    end: opts.end ?? null,
    gameId: opts.gameId ?? null,
    ticket: opts.ticket ?? (opts.mode === "local" || opts.role === "guest" ? "none" : "pending"),
    serverSeed: opts.serverSeed ?? false,
    submitted: opts.submitted ?? false,
    submittedText: opts.submittedText ?? null,
    startedAt: opts.startedAt ?? Date.now(),
    endedAt: opts.endedAt ?? null,
    elapsed: opts.elapsed ?? null,
    turnMs: opts.turnMs ?? null,
    finishSent: opts.elapsed != null,
    takeback: null,
    wasOver: false,
  };
  rec = replayGame(g.seed, g.moves);
  if (rec.error) {
    // A saved game that no longer replays: keep what does.
    g.moves = g.moves.slice(0, rec.error.ply);
    rec = replayGame(g.seed, g.moves);
  }
  disarmResign();
  disarmLeave();
  showPanel("play");
  resetResult();
  persist();
  update({ fresh: true });
  if (g.ticket === "pending") fetchTicket(g);
  maybeComputer();
  return g;
}

// The ticket for a game on a seed the player chose. It never earns the time
// bonuses, but it can go on the leaderboard.
async function fetchTicket(game) {
  try {
    const t = await api.start({
      mode: game.mode,
      seed: game.seed.text,
      difficulty: game.level ?? undefined,
      side: SIDE_LETTER[game.firstSide],
    });
    if (game !== g) return;
    g.gameId = t.game_id;
    g.ticket = "ok";
  } catch {
    if (game !== g) return;
    g.ticket = "offline";
  }
  persist();
  update();
  net?.changed();
}

function isOver() {
  return Boolean(g && (g.end !== null || rec.outcome));
}

function outcome() {
  return outcomeWith(rec, g.end);
}

// The side this screen plays: the person against the computer, one end of
// a network game, or, on a shared device, whoever is to move.
function mySide() {
  if (g.mode === "computer") return g.firstSide;
  if (g.mode === "network") return g.role === "host" ? g.firstSide : g.firstSide ^ 1;
  return rec.turn;
}

function interactive() {
  if (isOver() || thinking) return false;
  if (g.mode === "local") return true;
  if (g.mode === "network" && (!net?.connected() || g.takeback)) return false;
  return rec.turn === mySide();
}

function scoring() {
  return g.mode !== "local";
}

function percent() {
  return percentFor(g.mode, g.level, g.seed.size);
}

/* ---- moves ---- */

// Plays a move, from the board, the computer or the network. Returns false
// if it is not legal here and now.
export function playMove(cell, { from = "board" } = {}) {
  if (!g || isOver() || !Number.isInteger(cell) || rec.board[cell] !== -1) return false;
  const ply = g.moves.length;
  const side = rec.turn;
  g.moves.push(cell);
  rec = replayGame(g.seed, g.moves);
  if (isOver()) g.endedAt = Date.now();
  // The server's time for this move, which is what the turn bonus is
  // measured from. Only this device's own moves, and only where they count.
  if (from === "board" && scoring() && g.gameId) api.move(g.gameId, side, ply, cell).catch(() => {});
  persist();
  announce(rec.plies.at(-1), from);
  update();
  net?.changed();
  if (!isOver()) maybeComputer();
  return true;
}

function announce(ply, from) {
  const who =
    g.mode === "computer"
      ? from === "computer"
        ? "The computer played"
        : "You played"
      : g.mode === "network"
        ? from === "network"
          ? "Your opponent played"
          : "You played"
        : `${SIDE_NAME[ply.side]} played`;
  $("status").dataset.last = `${who} ${cellName(ply.cell, g.seed.size)}.`;
}

async function maybeComputer() {
  if (!g || g.mode !== "computer" || isOver() || rec.turn === g.firstSide || thinking) return;
  const game = g;
  const ply = g.moves.length;
  thinking = true;
  update();
  // A beat before even an instant reply, so the move is seen to happen.
  // The API takes the same beat off the player's next turn.
  const pause = new Promise((r) => setTimeout(r, thinkPause(g.level)));
  const cell = await requestMove(g.seed.text, g.level, g.moves);
  await pause;
  if (game !== g || g.moves.length !== ply || !thinking || isOver()) return;
  thinking = false;
  if (cell === null || !playMove(cell, { from: "computer" })) update();
}

/* ---- undo ---- */

// How many plies an undo by `side` takes back: to the last point where it
// was that side's turn, which is one ply or two.
function undoPlies(side) {
  const n = g.moves.length;
  if (!n) return 0;
  if (rec.plies[n - 1].side === side) return 1;
  return n >= 2 ? 2 : 0;
}

function canUndo() {
  if (!g || g.submitted) return false;
  if (g.mode === "local") return g.moves.length > 0;
  if (g.mode === "computer") return thinking || undoPlies(g.firstSide) > 0;
  return net?.connected() && !g.takeback && undoPlies(mySide()) > 0;
}

// Takes back `count` plies, charging the undo to `side`. Shared with network
// takebacks, which the host applies once they are accepted.
export function takeBack(count, side) {
  if (!count) return;
  g.moves.splice(g.moves.length - count, count);
  g.undos[side]++;
  g.end = null;
  g.endedAt = null;
  g.takeback = null;
  // The game is open again: its next ending is a new one to report.
  g.finishSent = false;
  g.elapsed = null;
  g.turnMs = null;
  rec = replayGame(g.seed, g.moves);
  if (g.gameId && (g.mode === "computer" || (g.mode === "network" && side === mySide()))) {
    api.undo(g.gameId, side).catch(() => {});
  }
  persist();
  replayer.stop();
  resetResult();
  $("status").dataset.last = count === 1 ? "Took back a move." : "Took back two moves.";
  update();
  net?.changed();
}

function onUndo() {
  if (!canUndo()) return;
  if (g.mode === "network") {
    net.requestTakeback();
    return;
  }
  if (g.mode === "computer" && thinking) {
    // The computer has not answered yet: take back the move it is answering.
    cancelMove();
    thinking = false;
    takeBack(1, g.firstSide);
    return;
  }
  const side = g.mode === "computer" ? g.firstSide : rec.plies.at(-1).side;
  takeBack(g.mode === "computer" ? undoPlies(side) : 1, side);
}

/* ---- resigning and leaving ---- */

function disarmResign() {
  clearTimeout(resignTimer);
  resignTimer = null;
  $("resignBtn").classList.remove("armed");
  $("resignLabel").textContent = "Resign";
}

// Two taps, so a stray one does not end the game.
function onResign() {
  if (!g || isOver()) return;
  if (!resignTimer) {
    $("resignBtn").classList.add("armed");
    $("resignLabel").textContent = "Tap again to resign";
    resignTimer = setTimeout(disarmResign, 3000);
    return;
  }
  disarmResign();
  if (g.mode === "network" && g.role === "guest") {
    net.resign();
    return;
  }
  resign(g.mode === "local" ? rec.turn : mySide());
}

export function resign(side) {
  if (!g || isOver()) return;
  cancelMove();
  thinking = false;
  g.end = { by: "resign", side };
  g.endedAt = Date.now();
  $("status").dataset.last = `${SIDE_NAME[side]} resigned.`;
  persist();
  update();
  net?.changed();
}

function disarmLeave() {
  clearTimeout(leaveTimer);
  leaveTimer = null;
  $("leaveBtn").classList.remove("armed");
}

// Back to choosing a game. A game in progress asks for a second tap.
function onLeave() {
  if (g && !isOver() && g.moves.length > 0 && !leaveTimer) {
    $("leaveBtn").classList.add("armed");
    $("leaveLabel").textContent = g.mode === "network" ? "Tap again to leave" : "Tap again to end this game";
    leaveTimer = setTimeout(() => {
      disarmLeave();
      update();
    }, 3000);
    return;
  }
  disarmLeave();
  if (g?.mode === "network") net?.leave();
  endGame();
}

// Drops the game on screen and shows the setup.
export function endGame() {
  cancelMove();
  thinking = false;
  replayer.stop();
  g = null;
  store.remove(GAME_STORAGE);
  showPanel("setup");
  renderSetup();
}

/* ---- drawing ---- */

function update({ fresh = false } = {}) {
  if (!g) return;
  const over = isOver();

  if (over && !g.wasOver) {
    g.wasOver = true;
    finish(fresh);
  } else if (over) {
    renderSubmit();
  } else {
    g.wasOver = false;
    const live = interactive();
    board.set({
      board: rec.board,
      size: g.seed.size,
      interactive: live,
      turn: rec.turn,
      last: g.moves.length ? g.moves.at(-1) : null,
      line: null,
      hints:
        live && getSettings().hints
          ? { win: finishingCells(rec.board, rec.geo, rec.turn), block: finishingCells(rec.board, rec.geo, rec.turn ^ 1) }
          : null,
    });
  }

  const size = g.seed.size;
  $("sizeChip").textContent = `${size}×${size}, ${IN_A_ROW[size]} in a row`;
  $("seedChip").textContent = g.seed.text;
  const me = mySide();
  const points = liveScore(rec.plies, me, percent(), g.undos[me]);
  $("scoreChip").textContent = scoring() && !over ? `${points} ${points === 1 ? "point" : "points"}` : "";

  renderPlayers(over);
  renderStatus(over);
  renderActions(over);
  renderTakeback();
}

function sideLabel(side) {
  if (g.mode === "computer") return side === g.firstSide ? "You" : `Computer, ${LEVELS[g.level].name}`;
  if (g.mode === "network") return side === mySide() ? "You" : "Opponent";
  return `Player ${SIDE_NAME[side]}`;
}

function setPlayers(names, turn) {
  $("xName").textContent = names[0];
  $("oName").textContent = names[1];
  if (!$("xMark").innerHTML) $("xMark").innerHTML = markSvg(0);
  if (!$("oMark").innerHTML) $("oMark").innerHTML = markSvg(1);
  $("players").dataset.turn = turn;
}

function renderPlayers(over) {
  const o = over ? outcome() : null;
  const turn = over ? (o.winner === -1 ? "none" : SIDE_LETTER[o.winner]) : SIDE_LETTER[rec.turn];
  setPlayers([sideLabel(0), sideLabel(1)], turn);
}

function renderStatus(over) {
  const el = $("status");
  const last = el.dataset.last ? `${el.dataset.last} ` : "";
  if (over) {
    el.textContent = last;
    return;
  }
  let now;
  if (g.mode === "computer") now = thinking ? "The computer is thinking." : "Your move.";
  else if (g.mode === "network") {
    if (!net?.connected()) now = "Waiting for your opponent to reconnect.";
    else now = rec.turn === mySide() ? "Your move." : "Waiting for your opponent.";
  } else now = `${SIDE_NAME[rec.turn]} to move.`;
  el.textContent = `${last}${now}`;
}

function renderActions(over) {
  // A submitted game cannot be undone. A network game keeps the row anyway,
  // for its way out of the session.
  $("liveActions").classList.toggle("hidden", over && g.submitted && g.mode !== "network");
  $("undoBtn").classList.toggle("hidden", g.submitted);
  $("undoBtn").disabled = !canUndo();
  $("undoLabel").textContent = g.mode === "network" ? "Ask to undo" : "Undo";
  $("resignBtn").classList.toggle("hidden", over);
  // Once it is over the result has its own buttons; a network game keeps
  // its way out of the session here.
  $("leaveBtn").classList.toggle("hidden", over && g.mode !== "network");
  if (!leaveTimer) {
    $("leaveLabel").textContent = g.mode === "network" ? (g.role === "host" ? "Stop hosting" : "Leave") : "New game";
  }

  let note = "";
  if (g.mode === "computer") {
    note = `Undo as often as you like. Each one takes ${Math.floor((UNDO_COST * percent()) / 100)} points off this game's score.`;
  } else if (g.mode === "network") {
    note = "Undo asks your opponent to take your last move back. Each one they accept costs you points.";
  }
  if (g.ticket === "offline" && scoring()) note += " This game started offline, so it is not scored.";
  const undone = g.undos[mySide()];
  if (scoring() && undone) note += ` Undos so far: ${undone}.`;
  $("undoNote").textContent = note.trim();
}

function renderTakeback() {
  const box = $("takeback");
  const pending = g.mode === "network" ? g.takeback : null;
  if (!pending || isOver()) {
    box.classList.add("hidden");
    return;
  }
  const mine = pending.by === mySide();
  box.classList.remove("hidden");
  $("takebackText").textContent = mine
    ? "Asked your opponent to take back your last move."
    : "Your opponent asks to take back their last move.";
  $("takebackYes").classList.toggle("hidden", mine);
  $("takebackNo").textContent = mine ? "Cancel" : "Decline";
}

function showPanel(name) {
  for (const id of ["setup", "net", "play"]) $(id).classList.toggle("hidden", id !== name);
}

/* ---- the end ---- */

function reasonText(o, end, size) {
  if (o.reason === "resign") return `${SIDE_NAME[end.side]} resigned.`;
  if (o.reason === "full") return "The board is full with no line made.";
  if (o.reason === "line") return `${SIDE_NAME[o.winner]} made ${IN_A_ROW[size]} in a row.`;
  return "The game stops here.";
}

function resetResult() {
  // A takeback reopens the game, and its next ending gets a fresh try.
  if (g) g.submitRefused = false;
  $("result").classList.add("hidden");
  $("replayBar").classList.add("hidden");
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
}

// "0:42" or "12:05".
function formatTaken(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// How long the game took: the server's figure once it has one, this
// device's until then.
function elapsed() {
  if (g.elapsed != null) return g.elapsed;
  return (g.endedAt ?? Date.now()) - g.startedAt;
}

function renderScoreLine() {
  const me = mySide();
  const result = resultFor(outcome().winner, me);
  const took = `Took ${formatTaken(elapsed())}`;
  if (!scoring()) {
    $("resultScore").textContent = `${took}.`;
    return;
  }
  const size = g.seed.size;
  const bonus = timeBonus(result, elapsed(), g.serverSeed, size);
  const turns = turnBonus(g.turnMs, me, result, g.serverSeed);
  const score = finalScore({ plies: rec.plies, side: me, result, size, percent: percent(), undos: g.undos[me], turns, bonusPercent: bonus });
  const parts = [`${score} ${score === 1 ? "point" : "points"}`];
  if (turns) parts.push(`${turns} for quick turns`);
  if (bonus) parts.push(`+${bonus}% for time`);
  if (g.undos[me]) parts.push(`${g.undos[me]} undo${g.undos[me] === 1 ? "" : "s"}`);
  let line = `${parts.join(", ")}. ${took}.`;
  const earns = result === "win" || result === "draw";
  if (earns && !g.serverSeed && g.gameId) {
    line += " No time bonus: the seed was chosen, not picked by the server.";
  } else if (earns && !bonus && g.serverSeed) {
    line += ` Up to +${TIME_BONUS_MAX}% for finishing within ${TIME_WINDOW_MS[size] / 60000} minutes.`;
  }
  $("resultScore").textContent = line;
}

function finish(fresh) {
  const o = outcome();
  const me = mySide();
  const result = resultFor(o.winner, me);
  const s = getSettings();

  let title;
  if (g.mode === "local") title = o.winner === -1 ? "Draw" : `${SIDE_NAME[o.winner]} wins`;
  else if (g.mode === "computer") title = result === "win" ? "You won" : result === "draw" ? "Draw" : "The computer won";
  else title = result === "win" ? "You won" : result === "draw" ? "Draw" : "You lost";
  $("resultTitle").textContent = title;
  $("resultReason").textContent = reasonText(o, g.end, g.seed.size);

  renderScoreLine();
  $("resultSeed").textContent = `Seed ${g.seed.text}`;
  $("copySeedLabel").textContent = "Copy seed";
  $("shareLabel").textContent = "Share replay";

  $("nameInput").value = s.name ?? "";
  $("submitBtn").disabled = false;
  g.autoTried = fresh;
  renderSubmit();

  const guest = g.mode === "network" && g.role === "guest";
  $("againBtn").classList.toggle("hidden", guest);
  $("againLabel").textContent = g.mode === "network" ? "Next game" : "Play again";
  $("newGameBtn").classList.toggle("hidden", g.mode === "network");
  $("newGameLabel").textContent = "New game";

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  replayer.load(g.seed, g.moves, { autoplay: !fresh && s.auto_replay });
  if (!fresh) $("resultTitle").focus({ preventScroll: true });

  // A win as it happens, not on a reload of one. On a shared device somebody
  // at the screen has always won unless it was a draw.
  const won = g.mode === "local" ? o.winner !== -1 : result === "win";
  if (won && !fresh) confetti();
}

// A resignation as the API takes it: sides as "x" or "o".
function wireEnd(end) {
  return end ? { by: end.by, side: SIDE_LETTER[end.side] } : null;
}

// Tells the server the game is over, the moment it is, so its clock stops
// there, and gets back its times for every turn. Tried again when the
// connection comes back.
async function reportFinish(game) {
  if (!game.gameId || game.finishSent || game !== g || !isOver() || !game.moves.length) return;
  game.finishSent = true;
  try {
    const r = await api.finish({ game_id: game.gameId, moves: game.moves, end: wireEnd(game.end) });
    game.elapsed = r.elapsed_ms;
    game.serverSeed = r.server_seed === true;
    game.turnMs = Array.isArray(r.turn_ms) ? r.turn_ms : null;
    if (game === g) {
      persist();
      if (isOver()) renderScoreLine();
    }
  } catch (err) {
    if (err.code !== "offline") return;
    game.finishSent = false;
    window.addEventListener("online", () => reportFinish(game), { once: true });
  }
}

// The leaderboard part of the result. Redrawn on every update while the game
// is over, because the start ticket can arrive after the game has ended: the
// host's check-in can be slow, and the guest only learns of it from the
// host's next snapshot. Either player then gets the form as soon as it does.
function renderSubmit() {
  reportFinish(g);
  const canSubmit = Boolean(scoring() && g.gameId && !g.submitted && g.moves.length);
  $("submitForm").classList.toggle("hidden", !canSubmit || g.submitRefused);
  let why = "";
  if (g.mode === "local") why = "Games on one device are not scored.";
  else if (!g.moves.length) why = "A game needs at least one move to go on the leaderboard.";
  else if (!g.gameId) {
    why =
      g.ticket === "pending"
        ? "Still checking in with the leaderboard."
        : g.mode === "network" && g.role === "guest"
          ? "The host's device could not reach the leaderboard, so this game is not scored."
          : "This game started without a connection, so it cannot go on the leaderboard.";
  }
  $("notScored").textContent = why;
  $("notScored").classList.toggle("hidden", !why);
  // Saved with the game, so a reload shows it again rather than an empty
  // box with a tick in it.
  $("submittedText").textContent = g.submittedText || "This game is on the leaderboard.";
  $("submitted").classList.toggle("hidden", !g.submitted);

  const s = getSettings();
  if (canSubmit && !g.autoTried && s.auto_submit && s.name) {
    g.autoTried = true;
    submitAs(s.name, true);
  }
}

// Codes that mean this game will never go on the board, so the form goes.
const FINAL = [
  "already_submitted",
  "expired",
  "too_fast",
  "overlap",
  "seed_used",
  "not_yours",
  "same_device",
  "not_computer",
  "illegal",
  "mismatch",
  "same_name",
];

async function submitAs(name, auto = false) {
  const msg = $("submitMsg");
  const game = g;
  $("submitBtn").disabled = true;
  msg.textContent = auto ? `Adding as ${name}.` : "Checking the game.";
  const me = mySide();
  try {
    const r = await api.submit({
      game_id: game.gameId,
      name,
      side: SIDE_LETTER[me],
      moves: game.moves,
      end: wireEnd(game.end),
      undos: game.undos[me],
    });
    if (game !== g) return;
    saveSettings({ name: r.name });
    g.submitted = true;
    g.elapsed = r.elapsed_ms;
    if (Array.isArray(r.turn_ms)) g.turnMs = r.turn_ms;
    renderScoreLine();
    const games = r.games === 1 ? "1 game" : `${r.games} games`;
    const extras = [];
    if (r.turn_bonus) extras.push(`${r.turn_bonus} for quick turns`);
    if (r.time_bonus) extras.push(`+${r.time_bonus}% for time`);
    const bonus = extras.length ? `, with ${extras.join(" and ")}` : "";
    g.submittedText =
      `Added as ${r.name} for ${r.score} points${bonus}. Best ${r.best_score}, ranked ${r.rank}. ` +
      `Total ${r.total} over ${games}, ranked ${r.total_rank}.`;
    persist();
    $("submittedText").textContent = g.submittedText;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
    msg.textContent = "";
    update();
  } catch (err) {
    if (game !== g) return;
    if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
    else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
    else msg.textContent = err.message || "That did not go through. Try again in a moment.";
    if (FINAL.includes(err.code)) {
      g.submitRefused = true;
      $("submitForm").classList.add("hidden");
    } else $("submitBtn").disabled = false;
  }
}

function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    $("submitMsg").textContent = "Enter a name.";
    $("nameInput").focus();
    return;
  }
  submitAs(name);
}

/* ---- sharing a replay ----
   A replay link holds the whole game: the seed, the moves one character
   each (record.js), who played, and a resignation if there was one. Nothing
   is stored anywhere, so a link works for as long as the site does, offline
   too. It carries no score: anyone can edit a link, and only the
   leaderboard's score is checked. */

// "c3x": against the computer at level 3, the player X. "l": two people on
// one device. "n": a network game.
function metaFor(game) {
  if (game.mode === "computer") return `c${game.level}${SIDE_LETTER[game.firstSide]}`;
  return game.mode === "network" ? "n" : "l";
}

function readMeta(text) {
  const m = /^(?:c([1-5])([xo])|(l)|(n))$/.exec(text ?? "");
  if (!m) return { mode: "local" };
  if (m[1]) return { mode: "computer", level: Number(m[1]), side: m[2] === "x" ? 0 : 1 };
  return { mode: m[3] ? "local" : "network" };
}

// A resignation in a link: "rx" X resigned, "ro" O resigned.
function endToLink(end) {
  return end ? `r${SIDE_LETTER[end.side]}` : null;
}

function endFromLink(text) {
  const m = /^r([xo])$/.exec(text ?? "");
  return m ? { by: "resign", side: m[1] === "x" ? 0 : 1 } : null;
}

function replayLink(seed, moves, end, meta) {
  const params = new URLSearchParams({ watch: packMoves(moves), seed: seed.text, game: meta });
  const e = endToLink(end);
  if (e) params.set("end", e);
  return `${location.origin}/?${params}`;
}

async function onShare() {
  const src = watching ?? (g && { seed: g.seed, moves: g.moves, end: g.end, meta: metaFor(g) });
  if (!src) return;
  const url = replayLink(src.seed, src.moves, src.end, src.meta);
  const label = $("shareLabel");
  if (navigator.share) {
    try {
      await navigator.share({ title: "Tic Tac Toe replay", text: `Watch this game of tic tac toe, seed ${src.seed.text}.`, url });
      label.textContent = "Shared";
      return;
    } catch (err) {
      // Dismissed: nothing to say. Refused or unsupported here: copy instead.
      if (err?.name === "AbortError") return;
    }
  }
  label.textContent = (await copyText(url)) ? "Link copied" : "Copy failed";
}

// Reads a replay link's parameters. Returns what to watch, { damaged: true }
// if the link is broken, or null if this is not a replay link.
export function readReplayLink(params) {
  if (!params.has("watch")) return null;
  const seed = parseSeed(params.get("seed"));
  const moves = seed && unpackMoves(seed, params.get("watch"));
  if (!moves || moves.length > MAX_PLIES) return { damaged: true };
  return { seed, moves, end: endFromLink(params.get("end")), meta: params.get("game") ?? "l" };
}

function watch(link) {
  cancelMove();
  thinking = false;
  g = null;
  watching = link;
  const meta = readMeta(link.meta);
  const record = replayGame(link.seed, link.moves);
  // A resignation only stands if the board had not already ended the game,
  // and only from a side that exists.
  if (record.outcome || !validEnd(watching.end)) watching.end = null;
  const o = outcomeWith(record, watching.end) ?? { reason: "unfinished", winner: -1 };
  const size = link.seed.size;

  showPanel("play");
  resetResult();
  for (const id of ["liveActions", "netBar", "takeback", "submitForm", "notScored", "submitted"]) $(id).classList.add("hidden");
  $("undoNote").textContent = "";
  $("status").dataset.last = "";
  $("status").textContent = "A shared replay.";
  $("sizeChip").textContent = `${size}×${size}, ${IN_A_ROW[size]} in a row`;
  $("scoreChip").textContent = "";
  $("seedChip").textContent = link.seed.text;

  const who = (side) => {
    if (meta.mode === "computer") return side === meta.side ? "Player" : `Computer, ${LEVELS[meta.level].name}`;
    return `Player ${SIDE_NAME[side]}`;
  };
  setPlayers([who(0), who(1)], o.winner === -1 ? "none" : SIDE_LETTER[o.winner]);

  if (o.reason === "unfinished") $("resultTitle").textContent = "Unfinished game";
  else if (o.winner === -1) $("resultTitle").textContent = "Draw";
  else if (meta.mode === "computer") $("resultTitle").textContent = o.winner === meta.side ? "The player won" : "The computer won";
  else $("resultTitle").textContent = `${SIDE_NAME[o.winner]} won`;
  $("resultReason").textContent = reasonText(o, watching.end, size);
  $("resultScore").textContent =
    meta.mode === "computer"
      ? `Against the computer at ${LEVELS[meta.level].name} level.`
      : meta.mode === "network"
        ? "Played over the network."
        : "Two players on one device.";
  $("resultSeed").textContent = `Seed ${link.seed.text}`;
  $("copySeedLabel").textContent = "Copy seed";
  $("shareLabel").textContent = "Share replay";
  $("againBtn").classList.remove("hidden");
  $("againLabel").textContent = "Play this seed";
  $("newGameBtn").classList.remove("hidden");
  $("newGameLabel").textContent = "Close replay";

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  replayer.load(link.seed, link.moves, { autoplay: true });
}

// Leaves a shared replay: the address loses the link, and the page goes
// back to the game this browser had going, or to choosing one.
function closeWatch({ show = true } = {}) {
  watching = null;
  replayer.stop();
  const params = new URLSearchParams(location.search);
  for (const key of ["watch", "seed", "game", "end"]) params.delete(key);
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  if (show && !resume()) {
    showPanel("setup");
    renderSetup();
  }
}

// "Play this seed": the new-game screen with the seed filled in, and the
// replay's kind of game chosen where it can be.
function playWatchedSeed() {
  const { seed, meta: text } = watching;
  const meta = readMeta(text);
  closeWatch({ show: false });
  if (meta.mode === "computer") {
    setup.mode = "computer";
    setup.level = meta.level;
    setup.side = SIDE_LETTER[meta.side];
  } else if (meta.mode === "local") {
    setup.mode = "local";
  }
  setup.size = seed.size;
  saveSetup();
  $("seedInput").value = seed.text;
  showPanel("setup");
  renderSetup();
  $("startBtn").focus();
}

function onAgain() {
  if (watching) return playWatchedSeed();
  if (!g || launching) return;
  if (g.mode === "network") {
    net?.nextGame();
    return;
  }
  // A fresh seed, picked by the server where it can be.
  launch({ mode: g.mode, seed: null, size: g.seed.size, level: g.level, sideChoice: g.sideChoice });
}

/* ---- saving ---- */

function persist() {
  if (!g || g.mode === "network") return;
  store.set(GAME_STORAGE, {
    mode: g.mode,
    seed: g.seed.text,
    level: g.level,
    sideChoice: g.sideChoice,
    firstSide: g.firstSide,
    moves: g.moves,
    undos: g.undos,
    end: g.end,
    gameId: g.gameId,
    ticket: g.ticket === "pending" ? "offline" : g.ticket,
    serverSeed: g.serverSeed,
    submitted: g.submitted,
    submittedText: g.submittedText ?? null,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
    elapsed: g.elapsed,
    turnMs: g.turnMs,
  });
}

const finite = (n) => (Number.isFinite(n) ? n : null);

function resume() {
  const saved = store.getJSON(GAME_STORAGE);
  const seed = parseSeed(saved?.seed);
  if (!saved || !seed || !["computer", "local"].includes(saved.mode) || !Array.isArray(saved.moves)) return false;
  const level = Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= 5 ? saved.level : 3;
  startGame({
    mode: saved.mode,
    seed,
    level,
    sideChoice: ["x", "o"].includes(saved.sideChoice) ? saved.sideChoice : null,
    firstSide: saved.firstSide === 1 ? 1 : 0,
    moves: saved.moves.filter((m) => Number.isInteger(m)),
    undos: Array.isArray(saved.undos) ? saved.undos.slice(0, 2).map((n) => Number(n) || 0) : [0, 0],
    end: validEnd(saved.end ?? null) ? saved.end ?? null : null,
    gameId: typeof saved.gameId === "string" ? saved.gameId : null,
    ticket: saved.gameId ? "ok" : saved.mode === "local" ? "none" : "offline",
    serverSeed: saved.serverSeed === true,
    submitted: saved.submitted === true,
    submittedText: typeof saved.submittedText === "string" ? saved.submittedText : null,
    startedAt: finite(saved.startedAt) ?? Date.now(),
    endedAt: finite(saved.endedAt),
    elapsed: finite(saved.elapsed),
    turnMs: Array.isArray(saved.turnMs) ? saved.turnMs.map(finite) : null,
  });
  return true;
}

/* ---- for multiplayer.js ---- */

// The network session plugs in here; see multiplayer.js.
export function setNet(adapter) {
  net = adapter;
}

export function current() {
  return g;
}

export function state() {
  return { rec, over: g ? isOver() : false, mySide: g ? mySide() : 0 };
}

export function refresh() {
  update();
}

export function setTakeback(value) {
  if (!g) return;
  g.takeback = value;
  update();
}

// Replaces the game with a snapshot from the host.
export function loadSnapshot(snap) {
  const seed = parseSeed(snap.seed);
  if (!seed) return;
  const same = g && g.mode === "network" && g.role === "guest" && g.netGame === snap.game && g.seed.text === seed.text;
  if (!same) {
    startGame({
      mode: "network",
      role: "guest",
      seed,
      firstSide: snap.firstSide,
      moves: snap.moves,
      undos: snap.undos,
      end: snap.end,
      gameId: snap.gameId,
      ticket: snap.gameId ? "ok" : "none",
      serverSeed: snap.serverSeed,
    });
    g.netGame = snap.game;
    g.takeback = snap.takeback;
    update({ fresh: true });
    return;
  }
  const old = g.moves;
  const next = snap.moves;
  const extendsByOne = next.length === old.length + 1 && old.every((m, i) => m === next[i]);
  const myUndosBefore = g.undos[mySide()];
  const wasOver = isOver();
  const shown = () => JSON.stringify([g.gameId, g.serverSeed, g.takeback, g.end, g.undos]);
  const before = shown();
  g.gameId = snap.gameId;
  if (snap.gameId) g.ticket = "ok";
  g.serverSeed = snap.serverSeed;
  g.takeback = snap.takeback;
  g.end = snap.end;
  g.undos = snap.undos.slice();

  if (extendsByOne) {
    g.moves = next.slice();
    rec = replayGame(g.seed, g.moves);
    if (isOver()) g.endedAt = Date.now();
    const ply = rec.plies.at(-1);
    announce(ply, ply.side === mySide() ? "board" : "network");
    update();
  } else if (old.join(" ") !== next.join(" ") || (wasOver && !isOver())) {
    const tookBack = next.length < old.length && next.every((m, i) => m === old[i]);
    g.moves = next.slice();
    rec = replayGame(g.seed, g.moves);
    g.finishSent = false;
    g.elapsed = null;
    g.turnMs = null;
    g.endedAt = isOver() ? Date.now() : null;
    replayer.stop();
    resetResult();
    if (tookBack) $("status").dataset.last = "A move was taken back.";
    update();
  } else if (shown() !== before) {
    if (!wasOver && isOver() && g.end) {
      g.endedAt = Date.now();
      $("status").dataset.last = `${SIDE_NAME[g.end.side]} resigned.`;
    }
    update();
  }
  // Most snapshots, at 20 a second, change nothing and draw nothing.

  // Our own accepted undos, counted on the server from this browser.
  if (g.gameId && g.undos[mySide()] > myUndosBefore) {
    for (let i = myUndosBefore; i < g.undos[mySide()]; i++) api.undo(g.gameId, mySide()).catch(() => {});
  }
}

export function snapshot() {
  return {
    type: "state",
    v: 1,
    game: g.netGame,
    seed: g.seed.text,
    firstSide: g.firstSide,
    gameId: g.gameId,
    serverSeed: g.serverSeed,
    moves: g.moves,
    end: g.end,
    undos: g.undos,
    takeback: g.takeback,
  };
}

export { undoPlies, isOver, showPanel, renderSetup };

/* ---- wiring ---- */

function buildLevelPick() {
  $("levelPick").innerHTML = LEVELS.slice(1)
    .map(
      (l, i) =>
        `<button class="level-btn" type="button" role="radio" aria-checked="false" data-level="${i + 1}"><b>${i + 1}</b><small>${l.name}</small></button>`
    )
    .join("");
}

// A radio group in the setup: clicking a button sets `key` from its data.
function pick(id, attr, key, parse = (v) => v) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (!b) return;
    setup[key] = parse(b.dataset[attr]);
    saveSetup();
    renderSetup();
  });
}

function onBoardPlay(cell) {
  if (!g) return;
  if (g.mode === "network" && g.role === "guest") {
    // The host decides; this device only asks. Its time still counts from
    // here, the moment the player chose.
    if (g.gameId) api.move(g.gameId, mySide(), g.moves.length, cell).catch(() => {});
    net?.sendMove(cell);
    return;
  }
  playMove(cell);
}

export function initGame({ joinCode, replayLink: shared } = {}) {
  board = new BoardView($("board"), { onPlay: onBoardPlay });
  replayer = new Replay(board);
  loadSetup();
  buildLevelPick();

  pick("modePick", "pick", "mode");
  pick("levelPick", "level", "level", Number);
  pick("sizePick", "size", "size", Number);
  pick("sidePick", "side", "side");

  $("seedInput").addEventListener("input", () => {
    $("seedNote").textContent = "Leave it empty for a new game, or paste a seed to play that game again.";
    // A pasted seed says its own board.
    const seed = parseSeed($("seedInput").value, setup.size);
    if (seed && seed.size !== setup.size) {
      setup.size = seed.size;
      renderSetup();
    }
  });
  $("seedInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onStart();
  });
  $("seedClear").addEventListener("click", () => {
    $("seedInput").value = "";
    $("seedInput").focus();
  });
  $("startBtn").addEventListener("click", onStart);

  $("undoBtn").addEventListener("click", onUndo);
  $("resignBtn").addEventListener("click", onResign);
  $("leaveBtn").addEventListener("click", onLeave);
  $("takebackYes").addEventListener("click", () => net?.answerTakeback(true));
  $("takebackNo").addEventListener("click", () => net?.answerTakeback(false));

  $("submitForm").addEventListener("submit", onSubmit);
  $("againBtn").addEventListener("click", onAgain);
  $("newGameBtn").addEventListener("click", () => (watching ? closeWatch() : endGame()));
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("shareBtn").addEventListener("click", onShare);
  const shownSeed = () => (watching ?? g)?.seed;
  $("copySeedBtn").addEventListener("click", async () => {
    const seed = shownSeed();
    if (!seed) return;
    $("copySeedLabel").textContent = (await copyText(seed.text)) ? "Copied" : "Copy failed";
  });
  $("seedChip").addEventListener("click", async () => {
    const seed = shownSeed();
    if (!seed) return;
    const chip = $("seedChip");
    const ok = await copyText(seed.text);
    chip.textContent = ok ? "Seed copied" : seed.text;
    setTimeout(() => shownSeed() && (chip.textContent = shownSeed().text), 1200);
  });

  onSettingsChange(() => {
    if (g && !isOver()) update();
  });

  renderSetup();
  if (shared && !shared.damaged) {
    watch(shared);
    return;
  }
  if (joinCode) {
    setup.mode = "network";
    renderSetup();
    showPanel("setup");
    return;
  }
  // A broken replay link is dropped from the address, and said so on the
  // new-game screen when that is where the page lands.
  if (shared?.damaged) {
    closeWatch({ show: false });
    $("seedNote").textContent = "That replay link is damaged or incomplete, so it cannot be played back.";
  }
  if (!resume()) showPanel("setup");
}
