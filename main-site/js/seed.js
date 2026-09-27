// Game seeds. A seed decides the board size, which mark the first player
// takes, and every roll of the dice the computer makes. The same seed and the
// same moves are always the same game, which is what lets a seed be shared
// and the API check a game.
//
// Written as "3X3-BXK4-M9TR", "4X4-..." or "5X5-...". The prefix is the
// board; the eight characters after it are the seed proper.
//
// Integer arithmetic only. Math.random differs between browsers and would
// make a game replay differently on the server.

import { SIZES } from "./rules.js";

// No vowels, and no 0 O 1 I, as for pairing codes: a seed read aloud cannot
// be misheard and cannot spell a word.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
const BODY_LENGTH = 8;

// 32 bit string hash (cyrb53's mixing, one half of it).
export function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// A small, fast, well mixed generator. Returns unsigned 32 bit integers.
export function randomSource(seedNumber) {
  let a = seedNumber >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function randomBody() {
  // Bytes at or above the limit would make some characters likelier.
  const limit = 256 - (256 % ALPHABET.length);
  let body = "";
  while (body.length < BODY_LENGTH) {
    const [byte] = globalThis.crypto.getRandomValues(new Uint8Array(1));
    if (byte < limit) body += ALPHABET[byte % ALPHABET.length];
  }
  return body;
}

const isBody = (s) => s.length === BODY_LENGTH && [...s].every((c) => ALPHABET.includes(c));

function build(size, body) {
  const text = `${size}X${size}-${body.slice(0, 4)}-${body.slice(4)}`;
  return {
    size,
    body,
    text,
    // The mark the first player takes: the one playing the computer, or the
    // host of a network game. X always moves first.
    firstSide: hashString(`side|${text}`) & 1,
  };
}

export function newSeed(size = 3) {
  return build(SIZES.includes(size) ? size : 3, randomBody());
}

// Whatever was typed or pasted, forgiving about case, spaces and dashes.
// "3X3-BXK4-M9TR", "3BXK4M9TR" and, with `size` for the board, a bare
// "BXK4M9TR" all read. null if it is not a seed.
export function parseSeed(input, size = 3) {
  const raw = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([345])(?:X\1)?([A-Z0-9]{8})$/.exec(raw);
  if (m && isBody(m[2])) return build(Number(m[1]), m[2]);
  return isBody(raw) && SIZES.includes(size) ? build(size, raw) : null;
}

// The computer's dice for one move. Keyed by the move number rather than
// drawn from one running stream, so the server can check any move on its own.
export function moveRandom(seed, level, ply) {
  return randomSource(hashString(`ai|${seed.text}|${level}|${ply}`));
}
