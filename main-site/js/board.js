// The board on screen: a grid of buttons played by tap, click or keyboard,
// marks that draw themselves in, and a stroke through the winning line.
// It draws whatever it is given and knows nothing of the game.

import { EMPTY, SIDE_NAME, cellName } from "./rules.js";

// pathLength="1" lets the CSS draw any mark in with one dash animation.
export function markSvg(side) {
  return side === 0
    ? `<svg class="mark mark-x" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path pathLength="1" d="M26 26 74 74"/><path pathLength="1" d="M74 26 26 74"/></svg>`
    : `<svg class="mark mark-o" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle pathLength="1" cx="50" cy="50" r="27"/></svg>`;
}

export class BoardView {
  // onPlay(cell) is called for a tap on an empty cell while the board is live.
  constructor(el, { onPlay }) {
    this.el = el;
    this.onPlay = onPlay;
    this.size = 0;
    this.buttons = [];
    this.shown = [];
    this.state = null;

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cell]");
      if (!btn || !this.state?.interactive) return;
      const cell = Number(btn.dataset.cell);
      if (this.state.board[cell] === EMPTY) this.onPlay(cell);
    });

    // Arrow keys move between cells; Enter and Space play, as for any button.
    el.addEventListener("keydown", (e) => {
      const btn = e.target.closest("[data-cell]");
      if (!btn) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.size, ArrowDown: this.size }[e.key];
      if (step === undefined) return;
      const cell = Number(btn.dataset.cell);
      const next = cell + step;
      const sameRow = Math.floor(next / this.size) === Math.floor(cell / this.size);
      if (next < 0 || next >= this.buttons.length || (Math.abs(step) === 1 && !sameRow)) return;
      e.preventDefault();
      this.buttons[next].focus();
    });
  }

  build(size) {
    this.size = size;
    this.el.innerHTML = "";
    this.el.style.setProperty("--size", String(size));
    this.el.dataset.size = String(size);
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", `${size} by ${size} board`);
    this.buttons = Array.from({ length: size * size }, (_, cell) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cell";
      b.dataset.cell = String(cell);
      grid.append(b);
      return b;
    });
    this.strike = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.strike.setAttribute("class", "strike");
    this.strike.setAttribute("viewBox", "0 0 100 100");
    this.strike.setAttribute("aria-hidden", "true");
    this.el.append(grid, this.strike);
    this.shown = new Array(size * size).fill(EMPTY);
    this.strikeKey = "";
  }

  // state: { board, size, interactive, turn, last, line, hints }. Marks new
  // since the last call draw themselves in; `line` gets the stroke. hints,
  // when set, is { win, block }: cells the side to move wins on, and cells
  // it has to block.
  set(state) {
    if (state.size !== this.size) this.build(state.size);
    this.state = state;
    this.el.classList.toggle("live", Boolean(state.interactive));
    this.el.dataset.turn = state.turn === 1 ? "o" : "x";

    state.board.forEach((v, cell) => {
      const b = this.buttons[cell];
      if (this.shown[cell] !== v) {
        b.innerHTML = v === EMPTY ? "" : markSvg(v);
        this.shown[cell] = v;
      }
      const name = cellName(cell, this.size);
      const hint = state.hints?.win.includes(cell) ? ", wins" : state.hints?.block.includes(cell) ? ", block here" : "";
      b.setAttribute("aria-label", v === EMPTY ? `${name}, empty${hint}` : `${name}, ${SIDE_NAME[v]}`);
      b.setAttribute("aria-disabled", String(!state.interactive || v !== EMPTY));
      b.classList.toggle("last", cell === state.last);
      b.classList.toggle("win", Boolean(state.line?.includes(cell)));
      b.classList.toggle("hint-win", Boolean(state.hints?.win.includes(cell)));
      b.classList.toggle("hint-block", Boolean(state.hints && !state.hints.win.includes(cell) && state.hints.block.includes(cell)));
    });

    const key = state.line ? state.line.join(",") : "";
    if (key !== this.strikeKey) {
      this.strikeKey = key;
      this.strike.innerHTML = state.line ? this.strokeFor(state.line) : "";
    }
  }

  strokeFor(line) {
    const centre = (cell) => [((cell % this.size) + 0.5) * (100 / this.size), (Math.floor(cell / this.size) + 0.5) * (100 / this.size)];
    const [x1, y1] = centre(line[0]);
    const [x2, y2] = centre(line[line.length - 1]);
    // Past the end cells' centres a little, so the stroke reads as a line
    // through them rather than between them.
    const dx = (x2 - x1) / (line.length - 1) / 3;
    const dy = (y2 - y1) / (line.length - 1) / 3;
    return `<line pathLength="1" x1="${x1 - dx}" y1="${y1 - dy}" x2="${x2 + dx}" y2="${y2 + dy}"/>`;
  }

  focusFirstFree() {
    const i = this.state?.board.findIndex((v) => v === EMPTY) ?? -1;
    if (i >= 0) this.buttons[i].focus();
  }
}
