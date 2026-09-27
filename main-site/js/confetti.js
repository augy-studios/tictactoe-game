// Confetti for a win: one burst from each bottom corner of the screen,
// drawn on a canvas that lies over the page, ignores the pointer, and is
// removed when the last piece has fallen.
//
// The colours are the theme's: the seven brand swatches and the current
// ink and status colours, so it matches whatever the reader has chosen.
// Nothing runs when the device asks for reduced motion.

import { COLOR_THEMES } from "./theme.js";

const PIECES = 150;
const GRAVITY = 1500; // px per second squared
const DRAG = 0.9; // share of speed kept per second, roughly
const LIFE_MS = 3200;

let running = null;

function palette() {
  const css = getComputedStyle(document.documentElement);
  const tokens = ["--brand-ink", "--ok", "--warn", "--error"].map((t) => css.getPropertyValue(t).trim()).filter(Boolean);
  // The white swatch would vanish on a light page.
  const swatches = COLOR_THEMES.map((t) => t.hex).filter((hex) => hex !== "#ffffff");
  return [...swatches, ...tokens];
}

export function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  running?.stop();

  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const colours = palette();
  const pieces = [];
  for (let i = 0; i < PIECES; i++) {
    const left = i % 2 === 0;
    // Up and inwards from a corner, fanned out a little.
    const angle = (left ? -60 : -120) + (Math.random() - 0.5) * 40;
    const speed = h * (0.9 + Math.random() * 0.7);
    const rad = (angle * Math.PI) / 180;
    pieces.push({
      x: left ? -10 : w + 10,
      y: h * 0.85,
      vx: Math.cos(rad) * speed,
      vy: Math.sin(rad) * speed,
      size: 6 + Math.random() * 6,
      spin: (Math.random() - 0.5) * 12,
      turn: Math.random() * Math.PI * 2,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 8,
      colour: colours[i % colours.length],
      delay: Math.random() * 180,
    });
  }

  const start = performance.now();
  let last = start;
  let frame = 0;

  const stop = () => {
    cancelAnimationFrame(frame);
    canvas.remove();
    running = null;
  };

  const draw = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = now - start;
    ctx.clearRect(0, 0, w, h);
    let alive = 0;
    for (const p of pieces) {
      if (age < p.delay) {
        alive++;
        continue;
      }
      p.vx *= DRAG ** dt;
      p.vy = p.vy * DRAG ** dt + GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.turn += p.spin * dt;
      p.flip += p.flipSpeed * dt;
      if (p.y > h + 20) continue;
      alive++;
      // Fading over the last half second of its life.
      ctx.globalAlpha = Math.max(0, Math.min(1, (LIFE_MS - age) / 500));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.turn);
      // A paper strip turning over: squash it along one axis.
      ctx.scale(1, Math.cos(p.flip));
      ctx.fillStyle = p.colour;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (alive && age < LIFE_MS) frame = requestAnimationFrame(draw);
    else stop();
  };

  frame = requestAnimationFrame(draw);
  running = { stop };
}
