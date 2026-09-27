// Network games: one device hosts and the other joins with a six character
// code, over net.js. The host is authoritative, per STUN-p2p-spec.md: the
// guest sends what it wants to do, the host applies it and sends the whole
// game back, 20 times a second and on every change. The guest shows nothing as
// done until a snapshot says so.
//
// Messages, beyond the spec's hello, state, bye and full:
//
//   { type: "move", cell, ply }       guest to host, one move
//   { type: "resign", ply }           guest to host
//   { type: "takeback", ply }         guest to host, asking to undo
//   { type: "takeback-cancel" }       guest to host, withdrawing that
//   { type: "takeback-answer", yes }  guest to host, on the host's request
//   { type: "ping" }                  guest to host, the guest's heartbeat
//
// `ply` is the number of moves the guest saw when it acted. A message about
// a game that has moved on since is ignored, and the next snapshot heals it.

import { Host, Guest, generateCode, isValidCode, normaliseCode, CODE_LENGTH, PROTOCOL_VERSION } from "./net.js";
import * as game from "./game.js";
import { validEnd, MAX_PLIES } from "./record.js";
import { qrToSvg } from "./qr.js";
import { copyText, hydrateIcons, store } from "./ui.js";

const HOST_CODE_KEY = "oxogame.hostCode";
const LAST_CODE_KEY = "oxogame.lastCode";
const SNAPSHOT_MS = 50;
// Silence checks and the guest's bar need nothing like the snapshot rate.
const TICK_MS = 250;
const PING_MS = 1000;
const HOST_SILENCE_MS = 8000;
// Time, not missed snapshots: at 20 a second a few missed ones is an
// ordinary wifi stall, and a background host tab only ticks once a second.
const GUEST_STALE_MS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isCell = (n) => Number.isInteger(n) && n >= 0 && n < 25;

const $ = (id) => document.getElementById(id);

let role = null; // "host" | "guest" | null
let host = null;
let guest = null;
let code = "";
// host: the next game. seed is a pasted one, or null for the server to
// pick; size the board; side "x", "o" or null for the seed's.
let plan = null;
let netGame = 0;
let startingGame = false;
let retriedTaken = false;
let lastHeard = 0;
let lastState = 0;
let reconnects = 0;
let wakeLock = null;

/* ---- the adapter game.js calls ---- */

const adapter = {
  connected() {
    if (role === "host") return Boolean(host && host.links.size > 0);
    if (role === "guest") return guest?.status === "connected" && Date.now() - lastState < GUEST_STALE_MS * 3;
    return false;
  },
  changed() {
    if (role === "host") broadcast();
    renderBar();
  },
  host(next) {
    startHosting(next);
  },
  sendMove(cell) {
    guest?.send({ type: "move", cell, ply: game.current()?.moves.length ?? 0 });
  },
  resign() {
    guest?.send({ type: "resign", ply: game.current()?.moves.length ?? 0 });
  },
  requestTakeback() {
    const g = game.current();
    if (!g) return;
    if (role === "host") {
      game.setTakeback({ by: game.state().mySide });
      broadcast();
    } else {
      guest?.send({ type: "takeback", ply: g.moves.length });
    }
  },
  answerTakeback(yes) {
    const g = game.current();
    const pending = g?.takeback;
    if (!pending) return;
    const mine = pending.by === game.state().mySide;
    if (role === "host") {
      if (!mine && yes) game.takeBack(game.undoPlies(pending.by), pending.by);
      else game.setTakeback(null);
      broadcast();
    } else {
      guest?.send(mine ? { type: "takeback-cancel" } : { type: "takeback-answer", yes: Boolean(yes) });
    }
  },
  leave() {
    if (role === "host") stopHosting();
    else leaveGuest();
  },
  nextGame() {
    if (role !== "host" || !plan) return;
    // A fresh seed for every game after the first, picked by the server.
    plan.seed = null;
    startNetworkGame();
  },
};

/* ---- hosting ---- */

function readStored(key) {
  const value = store.get(key);
  return isValidCode(value) ? normaliseCode(value) : null;
}

function joinLink(c) {
  return `${location.origin}/?join=${c}`;
}

async function startHosting(next) {
  closeAll();
  role = "host";
  plan = { ...next };
  netGame = 0;
  code = readStored(HOST_CODE_KEY) ?? generateCode();
  store.set(HOST_CODE_KEY, code);

  game.showPanel("net");
  $("hostView").classList.remove("hidden");
  $("hostCode").textContent = code;
  $("hostQr").innerHTML = qrToSvg(joinLink(code));
  $("copyLinkLabel").textContent = "Copy link";
  $("newCodeBtn").classList.remove("hidden");
  $("netRetryBtn").classList.add("hidden");
  setNetStatus(navigator.onLine === false ? "Network games need a connection to pair." : "Setting up the code.");

  const mine = new Host({ maxGuests: 1 });
  host = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (host !== mine) return;
    if (detail.taken && !retriedTaken) {
      // Another tab holds it, or the broker has not let go of it yet.
      retriedTaken = true;
      restartWithFreshCode();
      return;
    }
    if (detail.status === "waiting") retriedTaken = false;
    onHostStatus(detail);
  });
  mine.addEventListener("message", ({ detail }) => {
    if (host === mine) onHostMessage(detail.message, detail.from);
  });
  mine.addEventListener("leave", () => {
    if (host === mine) {
      game.refresh();
      renderBar();
    }
  });

  try {
    await mine.start(code);
  } catch {
    if (host !== mine) return;
    host = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
  }
}

function onHostStatus({ status, message }) {
  if (status === "error") {
    // With a game under way the board stays; the bar says what happened.
    if (game.current()?.mode === "network") renderBar(message);
    else setNetStatus(message, true);
    return;
  }
  if (status === "waiting" && !game.current()) setNetStatus("Waiting for the other device to join.");
  if (status === "connected") acquireWakeLock();
  renderBar();
  game.refresh();
}

function restartWithFreshCode() {
  store.remove(HOST_CODE_KEY);
  startHosting(plan);
}

function stopHosting() {
  host?.close();
  host = null;
  role = null;
  releaseWakeLock();
}

// The game starts once the guest has said hello, so the server's clock
// starts from when both are there.
async function startNetworkGame() {
  if (startingGame) return;
  startingGame = true;
  try {
    const g = await game.launch({
      mode: "network",
      role: "host",
      seed: plan.seed,
      size: plan.size,
      sideChoice: plan.side,
    });
    if (g) g.netGame = ++netGame;
  } finally {
    startingGame = false;
  }
  broadcast();
}

function broadcast() {
  const g = game.current();
  if (role !== "host" || !host || !g || g.mode !== "network" || !g.netGame) return;
  host.send(game.snapshot());
}

function onHostMessage(message, from) {
  lastHeard = Date.now();
  const g = game.current();
  const guestSide = g && g.mode === "network" ? g.firstSide ^ 1 : 1;
  const live = g && g.mode === "network" && !game.isOver();
  const ply = Number.isInteger(message.ply) ? message.ply : -1;

  switch (message.type) {
    case "hello":
      if (message.v !== PROTOCOL_VERSION) {
        host.send({ type: "old", v: PROTOCOL_VERSION }, from);
        return;
      }
      if (!g || g.mode !== "network") startNetworkGame();
      else if (g.netGame) host.send(game.snapshot(), from);
      renderBar();
      return;
    case "move":
      if (!live || !isCell(message.cell)) break;
      if (ply !== g.moves.length || game.state().rec.turn !== guestSide) break;
      if (g.takeback) game.setTakeback(null);
      game.playMove(message.cell, { from: "network" });
      return;
    case "resign":
      if (live && ply === g.moves.length) game.resign(guestSide);
      break;
    case "takeback":
      if (g && !g.takeback && ply === g.moves.length && game.undoPlies(guestSide) > 0) game.setTakeback({ by: guestSide });
      break;
    case "takeback-cancel":
      if (g?.takeback?.by === guestSide) game.setTakeback(null);
      break;
    case "takeback-answer":
      if (g?.takeback?.by === (guestSide ^ 1)) {
        if (message.yes === true) game.takeBack(game.undoPlies(guestSide ^ 1), guestSide ^ 1);
        else game.setTakeback(null);
      }
      break;
    case "bye":
      // Leaving on purpose: this code is spent, and the game with it.
      store.remove(HOST_CODE_KEY);
      game.endGame();
      startHosting({ ...plan, seed: null });
      setNetStatus("Your opponent left. Share the new code to play again.");
      return;
    default:
      // ping, and anything this build does not know: ignored, never thrown on.
      return;
  }
  broadcast();
}

/* ---- joining ---- */

export async function join(input) {
  const c = normaliseCode(input);
  if (!isValidCode(c)) {
    setNetStatus(`A code is ${CODE_LENGTH} characters.`, true);
    const field = $("joinInput");
    field.classList.remove("shake");
    void field.offsetWidth;
    field.classList.add("shake");
    field.focus();
    return;
  }
  if (role !== "guest" || code !== c) reconnects = 0;
  closeAll();
  role = "guest";
  code = c;
  lastState = 0;

  if (!game.current() || game.current().mode !== "network") {
    game.showPanel("net");
    $("hostView").classList.add("hidden");
    $("newCodeBtn").classList.add("hidden");
  }
  $("netRetryBtn").classList.add("hidden");
  setNetStatus(navigator.onLine === false ? "Network games need a connection to pair." : `Connecting to ${c}.`);

  const mine = new Guest();
  guest = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (guest === mine) onGuestStatus(detail);
  });
  mine.addEventListener("message", ({ detail }) => {
    if (guest === mine) onGuestMessage(detail.message);
  });

  try {
    await mine.connect(c);
    store.set(LAST_CODE_KEY, c);
  } catch {
    if (guest !== mine) return;
    guest = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
    $("netRetryBtn").classList.remove("hidden");
  }
}

const UNREACHABLE =
  "Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.";

function onGuestStatus({ status, message }) {
  const inGame = game.current()?.mode === "network";
  if (status === "connected") {
    reconnects = 0;
    acquireWakeLock();
    if (!inGame) setNetStatus("Connected. Waiting for the host's game.");
  } else if (status === "dropped") {
    // Probably coming back: try again quietly a few times.
    if (reconnects < 3) {
      reconnects++;
      setTimeout(() => role === "guest" && guest?.status === "dropped" && join(code), 1500);
    } else if (!inGame) {
      setNetStatus("The connection dropped.", true);
      $("netRetryBtn").classList.remove("hidden");
    }
  } else if (status === "unreachable" || status === "error") {
    const text = status === "unreachable" ? UNREACHABLE : message;
    if (inGame) {
      renderBar(text);
    } else {
      setNetStatus(text, true);
      $("netRetryBtn").classList.remove("hidden");
    }
  }
  renderBar();
  game.refresh();
}

function validSnapshot(s) {
  return (
    s.type === "state" &&
    Number.isInteger(s.game) &&
    typeof s.seed === "string" &&
    s.seed.length <= 20 &&
    (s.firstSide === 0 || s.firstSide === 1) &&
    Array.isArray(s.moves) &&
    s.moves.length <= MAX_PLIES &&
    s.moves.every(isCell) &&
    validEnd(s.end) &&
    typeof s.serverSeed === "boolean" &&
    Array.isArray(s.undos) &&
    s.undos.length === 2 &&
    s.undos.every((n) => Number.isInteger(n) && n >= 0 && n < 100000) &&
    (s.takeback === null || (typeof s.takeback === "object" && (s.takeback.by === 0 || s.takeback.by === 1))) &&
    (s.gameId === null || (typeof s.gameId === "string" && UUID.test(s.gameId)))
  );
}

function onGuestMessage(message) {
  switch (message.type) {
    case "state":
      if (!validSnapshot(message)) return;
      lastState = Date.now();
      // Rebuilt field by field, so nothing unexpected rides along.
      game.loadSnapshot({
        game: message.game,
        seed: message.seed,
        firstSide: message.firstSide,
        gameId: message.gameId,
        serverSeed: message.serverSeed,
        moves: message.moves.slice(),
        end: message.end && { by: "resign", side: message.end.side },
        undos: message.undos.slice(),
        takeback: message.takeback && { by: message.takeback.by },
      });
      renderBar();
      return;
    case "full":
      setNetStatus("That game already has two players.", true);
      return;
    case "old":
      setNetStatus("The host's device is on a different version. Reload both and try again.", true);
      return;
    default:
      return;
  }
}

function leaveGuest() {
  guest?.leave();
  guest = null;
  role = null;
  store.remove(LAST_CODE_KEY);
  releaseWakeLock();
}

/* ---- both ---- */

function closeAll() {
  host?.close();
  host = null;
  guest?.close();
  guest = null;
}

function setNetStatus(text, error = false) {
  const el = $("netStatus");
  el.textContent = text;
  el.classList.toggle("error", error);
}

// The line under the board in a network game.
function renderBar(problem) {
  const g = game.current();
  const bar = $("netBar");
  if (!g || g.mode !== "network") {
    bar.classList.add("hidden");
    return;
  }
  let tone = "busy";
  let text;
  if (role === "host") {
    if (host?.links.size) {
      tone = "ok";
      text = "Connected";
    } else {
      tone = "warn";
      text = `Opponent disconnected. They can rejoin with ${code}.`;
    }
  } else if (role === "guest") {
    const fresh = Date.now() - lastState < GUEST_STALE_MS;
    if (guest?.status === "connected" && fresh) {
      tone = "ok";
      text = "Connected to the host";
    } else if (guest?.status === "connected") {
      tone = "warn";
      text = "The connection looks stale.";
    } else if (guest?.status === "connecting" || guest?.status === "dropped") {
      text = "Reconnecting.";
    } else {
      tone = "error";
      text = "Disconnected.";
    }
  } else {
    tone = "error";
    text = "Not connected.";
  }
  if (problem) {
    tone = "error";
    text = problem;
  }
  bar.dataset.tone = tone;
  $("netBarText").textContent = text;
  bar.classList.remove("hidden");
}

async function acquireWakeLock() {
  try {
    if (!wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    // Refused or unsupported: the screen may sleep, nothing else changes.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function tick() {
  if (role === "host" && host) {
    // A guest silent this long has probably gone; its seat reopens.
    if (host.links.size && Date.now() - lastHeard > HOST_SILENCE_MS) {
      host.dropAll();
      game.refresh();
    }
  }
  if (role === "guest") renderBar();
}

export function initMultiplayer({ joinCode } = {}) {
  game.setNet(adapter);

  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinInput").value);
  });
  $("joinInput").addEventListener("input", (e) => {
    const c = normaliseCode(e.target.value);
    if (c !== e.target.value) e.target.value = c;
  });
  $("copyLinkBtn").addEventListener("click", async () => {
    $("copyLinkLabel").textContent = (await copyText(joinLink(code))) ? "Copied" : "Copy failed";
  });
  $("newCodeBtn").addEventListener("click", () => {
    if (role === "host") restartWithFreshCode();
  });
  $("netRetryBtn").addEventListener("click", () => {
    if (role === "guest" || code) join(code);
  });
  $("netCancelBtn").addEventListener("click", () => {
    if (role === "host") stopHosting();
    else leaveGuest();
    game.endGame();
  });

  // The steady beat, which doubles as the host's heartbeat.
  setInterval(() => role === "host" && broadcast(), SNAPSHOT_MS);
  setInterval(tick, TICK_MS);
  setInterval(() => role === "guest" && guest?.send({ type: "ping" }), PING_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (role && adapter.connected()) acquireWakeLock();
    // Back from the background with a channel that died meanwhile.
    if (role === "guest" && guest?.status === "dropped") join(code);
  });

  // From a join link, or from last time.
  const initial = normaliseCode(joinCode) || readStored(LAST_CODE_KEY) || "";
  if (initial) $("joinInput").value = initial;
  hydrateIcons($("net"));
}
