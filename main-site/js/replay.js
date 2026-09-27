// The instant replay: a finished game played back on the same board, one
// move at a time, with play, pause, a step either way, and a jump to any
// move from the list or the slider. Each mark draws itself in again as it
// is replayed, and the winning line is struck through at the end.

import { cellName, SIDE_NAME } from "./rules.js";
import { positions, replay as replayGame } from "./record.js";
import { hydrateIcons, store } from "./ui.js";

// A move every 800 ms at 1x. A mark takes 220 ms to draw, so even 4x
// (200 ms a move) still shows each one appear.
const STEP_MS = 800;
const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "oxogame.replaySpeed";

const $ = (id) => document.getElementById(id);

export class Replay {
  constructor(board) {
    this.board = board;
    this.timer = null;
    this.index = 0;
    this.frames = [];
    this.moves = [];
    this.size = 3;
    this.line = null;
    this.onShow = null;
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpStart").addEventListener("click", () => this.jump(0));
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpEnd").addEventListener("click", () => this.jump(this.frames.length - 1));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpScrub").addEventListener("input", (e) => this.jump(Number(e.target.value)));
    $("moveList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ply]");
      if (btn) this.jump(Number(btn.dataset.ply) + 1);
    });
    document.addEventListener("keydown", (e) => {
      if (!this.active || e.target.closest("input, textarea, .board")) return;
      if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else return;
      e.preventDefault();
    });
  }

  // Starts at the end, or from the empty board and playing when `autoplay`
  // is set. onShow(index, total) hears about every frame shown.
  load(seed, moves, { autoplay = false, onShow = null } = {}) {
    this.pause();
    this.active = true;
    this.size = seed.size;
    this.moves = moves.slice();
    this.frames = positions(seed, moves);
    this.line = replayGame(seed, moves).outcome?.line ?? null;
    this.onShow = onShow;

    $("rpScrub").max = String(this.frames.length - 1);
    $("moveList").innerHTML = moves
      .map((cell, i) => {
        const side = i % 2;
        return `<li><button type="button" class="ply-btn" data-ply="${i}"><span class="ply-num">${i + 1}.</span> ${SIDE_NAME[side]} ${cellName(cell, seed.size)}</button></li>`;
      })
      .join("");

    if (autoplay && this.frames.length > 1) {
      this.show(0);
      this.timer = setTimeout(() => this.play(), 500);
      this.syncPlayButton(true);
    } else {
      this.show(this.frames.length - 1);
    }
  }

  stop() {
    this.pause();
    this.active = false;
  }

  show(i) {
    if (!this.frames[i]) return;
    this.index = i;
    const total = this.frames.length - 1;
    this.board.set({
      board: this.frames[i],
      size: this.size,
      interactive: false,
      turn: i % 2,
      last: i > 0 ? this.moves[i - 1] : null,
      line: i === total ? this.line : null,
      hints: null,
    });
    $("rpScrub").value = String(i);
    $("rpLabel").textContent = i === 0 ? `Empty board, ${total} ${total === 1 ? "move" : "moves"}` : `Move ${i} of ${total}`;
    const list = $("moveList");
    list.querySelectorAll(".ply-btn").forEach((b) => {
      const on = Number(b.dataset.ply) === i - 1;
      b.classList.toggle("current", on);
      if (on) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    // Keep the current move in view within the list, not the page.
    const current = list.querySelector(".ply-btn.current");
    if (current) {
      const top = current.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 24) list.scrollTop = top - 40;
    } else if (i === 0) {
      list.scrollTop = 0;
    }
    $("rpBack").disabled = $("rpStart").disabled = i === 0;
    $("rpForward").disabled = $("rpEnd").disabled = i === total;
    this.onShow?.(i, total);
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.index + delta;
    if (next < 0 || next >= this.frames.length) return false;
    this.show(next);
    return true;
  }

  jump(i) {
    this.pause();
    this.show(Math.max(0, Math.min(this.frames.length - 1, i)));
  }

  get stepMs() {
    return STEP_MS / this.speed;
  }

  // Remembered in this browser. A replay that is playing picks the new pace
  // up from its next move, without restarting.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer && this.ticking) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.stepMs);
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      el.setAttribute("aria-checked", String(Number(el.dataset.speed) === this.speed));
    });
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.index >= this.frames.length - 1) this.show(0);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.index >= this.frames.length - 1) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.stepMs);
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.index === 0 ? Math.min(400, this.stepMs) : this.stepMs / 2);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.querySelector("[data-icon]").setAttribute("data-icon", playing ? "pause" : "play");
    hydrateIcons(btn);
  }
}
