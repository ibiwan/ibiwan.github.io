// small 2d helpers. angles are DEGREES everywhere except inside fk(), which
// converts once -- keeps the yaml human-editable and avoids conversion bugs
// leaking into the ui layer.

export const DEG = Math.PI / 180;

export const v2 = (x = 0, y = 0) => ({ x, y });

export const add = (a, b) => v2(a.x + b.x, a.y + b.y);
export const sub = (a, b) => v2(a.x - b.x, a.y - b.y);
export const scale = (a, k) => v2(a.x * k, a.y * k);
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => len(sub(a, b));

// rotate a vector by an angle in degrees
export function rotate(v, deg) {
  const r = deg * DEG;
  const c = Math.cos(r), s = Math.sin(r);
  return v2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// signed angle of a vector, in degrees
export const angleOf = (v) => Math.atan2(v.y, v.x) / DEG;

// wrap to (-180, 180] so inspector values stay readable after dragging
export function wrapDeg(d) {
  let a = ((d + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// round for display without destroying precision in the model
export const fmt = (n, p = 2) => {
  const r = Number(n.toFixed(p));
  return Object.is(r, -0) ? 0 : r;
};
