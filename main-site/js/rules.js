// The rules. A square board of 3, 4 or 5, X and O taking turns with X first,
// and a straight line of marks wins: three on 3x3, four on 4x4 and 5x5.
// Pure, with no DOM, so the API checks games with this same file.

export const X = 0;
export const O = 1;
export const EMPTY = -1;
export const SIDE_NAME = ["X", "O"];

export const SIZES = [3, 4, 5];

// Marks in a row to win, by board size.
export const WIN_LENGTH = { 3: 3, 4: 4, 5: 4 };

// X moves on even plies, O on odd ones, whoever is playing which.
export const sideOf = (ply) => ply % 2;

const geometries = new Map();

// Every winning line on a board, and for each cell the lines through it.
// Built once per size.
export function geometry(size) {
  if (geometries.has(size)) return geometries.get(size);
  const k = WIN_LENGTH[size];
  const lines = [];
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      for (const [dr, dc] of directions) {
        const endR = r + dr * (k - 1);
        const endC = c + dc * (k - 1);
        if (endR < 0 || endR >= size || endC < 0 || endC >= size) continue;
        const line = [];
        for (let i = 0; i < k; i++) line.push((r + dr * i) * size + (c + dc * i));
        lines.push(line);
      }
    }
  }
  const cells = size * size;
  const through = Array.from({ length: cells }, () => []);
  lines.forEach((line, i) => line.forEach((cell) => through[cell].push(i)));
  // Up to eight neighbours of each cell, for the computer's move list on
  // the bigger boards.
  const near = Array.from({ length: cells }, (_, cell) => {
    const r = Math.floor(cell / size);
    const c = cell % size;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if ((dr || dc) && nr >= 0 && nr < size && nc >= 0 && nc < size) out.push(nr * size + nc);
      }
    }
    return out;
  });
  const geo = { size, k, cells, lines, through, near };
  geometries.set(size, geo);
  return geo;
}

export function emptyBoard(size) {
  return new Array(size * size).fill(EMPTY);
}

// The line `side` has just completed by playing `cell`, or null.
export function winningLine(board, geo, cell, side) {
  for (const i of geo.through[cell]) {
    const line = geo.lines[i];
    let all = true;
    for (const c of line) {
      if (board[c] !== side) {
        all = false;
        break;
      }
    }
    if (all) return line;
  }
  return null;
}

// The empty cells where `side` would complete a line: its wins if it is to
// move, and the cells the other side has to block if not.
export function finishingCells(board, geo, side) {
  const out = new Set();
  for (const line of geo.lines) {
    let mine = 0;
    let gap = -1;
    for (const c of line) {
      if (board[c] === side) mine++;
      else if (board[c] === EMPTY && gap < 0) gap = c;
    }
    if (mine === geo.k - 1 && gap >= 0) out.add(gap);
  }
  return [...out].sort((a, b) => a - b);
}

// "b2": the column as a letter, the row as a number counted from the top.
export function cellName(cell, size) {
  return `${"abcde"[cell % size]}${Math.floor(cell / size) + 1}`;
}
