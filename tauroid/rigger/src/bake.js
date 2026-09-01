// Baking: turn a solved animation into per-channel keyframes the engine can
// simply tween.
//
// The tool tweens authored deltas and THEN solves. An engine that only tweens
// has to be handed the solve already done -- and solving at the authored keys
// alone is not enough, because the solve is not linear. `match` on theta is
// affine and bakes exactly at any spacing; `reach`, `aim` and local-space
// `match` on x/y are trigonometric, so a straight line between two solved keys
// cuts the chord of an arc.
//
// So: seed with the authored keys, then subdivide only where the chord misses
// by more than the tolerance. Channels are independent, so a bone whose angle
// is pinned by a theta match keeps two keys while its position gets however
// many the geometry demands. Every key is flagged, so a reader can tell what
// was drawn from what was computed.

import { resolveFrames, boneKey } from './skeleton.js';
import { rotate, sub, v2, wrapDeg } from './math.js';
import { poseAt, loopPeriod, samplePose } from './animation.js';

export const CHANNELS = ['angle', 'offsetX', 'offsetY'];

// Angles are already scale-free; positions are not, so they are judged against
// the bone's own length -- the same 1% means the same thing on a rig built at
// any size.
//
// Chosen against the RENDERED size, which is what actually matters: the marine
// ships at 64px, where the rig's ~715 units map to 0.09 px per unit. These
// tolerances put the worst chord error around a quarter of a pixel. Loosening
// to 3 degrees / 5% costs only ~50 fewer keys and lets a visible 1.3px wobble
// back in; tightening further buys precision no 64px sprite can show.
export const DEFAULT_TOLERANCE = { angle: 1, offset: 0.01 };

// What local delta reproduces the solved pose, given the parent is already
// where the solve put it?
//
// This is the inverse of what resolveOnce does, so the engine composing
// rest + delta lands exactly where the tool's solver did.
function localDelta(bone, frames, refFrame) {
  const self = frames.get(boneKey(bone.id, 'root'));
  if (!self) return null;
  const parent = refFrame(bone.ref);

  // Measured from rest + pose, because that is what the delta will be ADDED to:
  // the composition is rest + pose + animation, and the engine gets `pose_angle`
  // on the bone. Subtracting only restAngle made a posed bone's pose count
  // twice -- once inside the solve this delta reproduces, once when the delta
  // was applied on top.
  const restAngle = Number.isFinite(bone.restAngle) ? bone.restAngle : 0;
  const poseAngle = Number.isFinite(bone.poseAngle) ? bone.poseAngle : 0;
  const base = bone.offset ?? v2(0, 0);
  const local = rotate(sub(self.pos, parent.pos), -parent.angle);

  return {
    angle: wrapDeg(self.angle - (parent.angle + restAngle + poseAngle)),
    offsetX: local.x - base.x,
    offsetY: local.y - base.y,
  };
}

// The standing solve: what the constraints do with no animation running.
//
// It is a CONSTANT per bone, so it belongs to the rig rather than to any
// animation. Baking it into each animation is what made two active lanes apply
// the constraint twice -- the engine adds them, and a constant added N times is
// N times wrong.
export function solveOffset(doc) {
  const still = { ...doc, animations: [] };
  const { frames, refFrame } = resolveFrames(still, { posed: true, constraints: true });
  const out = {};
  for (const b of still.bones) {
    const d = localDelta(b, frames, refFrame);
    if (!d) continue;
    if (Math.abs(d.angle) > 1e-6 || Math.abs(d.offsetX) > 1e-6 || Math.abs(d.offsetY) > 1e-6) {
      out[b.id] = d;
    }
  }
  return out;
}

// One animation's CONTRIBUTION -- what it changes, not where things end up.
//
// Isolation keeps animations independently playable, and is exact when one is
// running. It is NOT exact when several run at once: a constraint moves a bone
// in every animation's solve, so each bake carries the whole constraint result
// and the engine, adding them, applies it once per animation. See TODO --
// this is a design limit of per-animation baking, not a bug in the arithmetic.
function sampler(doc, anim) {
  const solo = { ...doc, animations: [{ ...anim, active: true }] };
  const base = solveOffset(doc);
  const cache = new Map();
  return (f) => {
    const key = f.toFixed(4);
    if (cache.has(key)) return cache.get(key);

    // posed:true, and localDelta subtracts the pose back out again. The pair
    // matters: this samples the REAL solved pose, and the delta is expressed
    // relative to rest + pose so that adding it there reconstructs exactly
    // this. A bone the animation never touches bakes to zero and keeps its
    // pose, rather than either losing it or having it counted twice.
    const { frames, refFrame } = resolveFrames(solo, {
      posed: true, constraints: true, deltas: poseAt(solo, f),
    });
    const out = new Map();
    for (const b of solo.bones) {
      const d = localDelta(b, frames, refFrame);
      if (!d) continue;
      // subtract the standing solve: a bone this animation does not move now
      // bakes to zero and drops out entirely, instead of carrying a constant
      const z = base[b.id];
      out.set(b.id, z
        ? { angle: d.angle - z.angle, offsetX: d.offsetX - z.offsetX, offsetY: d.offsetY - z.offsetY }
        : d);
    }
    cache.set(key, out);
    return out;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

// Split a span until a straight line across it is within tolerance everywhere.
// Recursion bottoms out at whole frames -- nothing finer is representable.
function subdivide(read, lo, hi, tol, out, depth = 0) {
  if (hi - lo <= 1 || depth > 12) { out.add(hi); return; }

  const a = read(lo);
  const b = read(hi);
  let worst = 0;
  for (let i = 1; i < 8; i += 1) {
    const t = i / 8;
    const f = lo + (hi - lo) * t;
    worst = Math.max(worst, Math.abs(read(f) - lerp(a, b, t)));
    if (worst > tol) break;
  }
  if (worst <= tol) { out.add(hi); return; }

  const mid = Math.round((lo + hi) / 2);
  if (mid <= lo || mid >= hi) { out.add(hi); return; }
  subdivide(read, lo, mid, tol, out, depth + 1);
  subdivide(read, mid, hi, tol, out, depth + 1);
}

// The scale positional tolerance is measured against. A bone whose length is
// zero has no extent to measure against, so it borrows the rig's median bone
// length rather than being held to an impossible standard.
function sceneScale(doc) {
  const lens = doc.bones.map((b) => b.length).filter((n) => n > 1).sort((a, b) => a - b);
  return lens.length ? lens[Math.floor(lens.length / 2)] : 1;
}

export function bakeAnimation(doc, anim, tolerance = DEFAULT_TOLERANCE) {
  const read = sampler(doc, anim);
  const period = loopPeriod(anim) ?? anim.length;
  const designed = anim.keyframes.map((k) => k.frame).filter((f) => f <= period);
  const scale = sceneScale(doc);

  // a loop closes back on frame 0, so the wrap segment is a real span to check
  const seeds = [...new Set([...designed, period])].sort((a, b) => a - b);
  const isDesigned = new Set(designed);

  const out = {};
  for (const bone of doc.bones) {
    const ref = bone.length > 1 ? bone.length : scale;
    const tol = { angle: tolerance.angle, offsetX: ref * tolerance.offset, offsetY: ref * tolerance.offset };

    // Angles must be UNWRAPPED before they can be tweened.
    //
    // localDelta wraps to (-180, 180], so a bone turning past half a circle
    // flips sign mid-rotation -- a channel reading 180 then -174 tweens
    // backwards through zero and throws the limb across the sprite. Walk the
    // whole period once accumulating shortest-arc steps, and every later
    // sample is snapped to the branch nearest that continuous baseline. A
    // full turn then reads 0 -> 360 rather than 0 -> 180 -> -180 -> 0.
    const spine = new Map();
    {
      let acc = 0;
      let prev = read(0).get(bone.id)?.angle ?? 0;
      acc = prev;
      spine.set(0, acc);
      for (let f = 1; f <= period; f += 1) {
        const raw = read(f).get(bone.id)?.angle ?? 0;
        acc += wrapDeg(raw - prev);
        prev = raw;
        spine.set(f, acc);
      }
    }
    const unwrap = (f, raw) => {
      const near = spine.get(Math.round(f)) ?? 0;
      return raw + 360 * Math.round((near - raw) / 360);
    };

    const channels = {};
    for (const ch of CHANNELS) {
      const at = (f) => {
        const raw = read(f).get(bone.id)?.[ch] ?? 0;
        return ch === 'angle' ? unwrap(f, raw) : raw;
      };

      const frames = new Set(seeds);
      for (let i = 0; i < seeds.length - 1; i += 1) {
        subdivide(at, seeds[i], seeds[i + 1], tol[ch], frames);
      }

      const keys = [...frames].sort((a, b) => a - b).map((f) => ({
        frame: f,
        value: at(f),
        designed: isDesigned.has(f),
      }));

      // a channel that never leaves zero is not worth emitting
      if (keys.some((k) => Math.abs(k.value) > 1e-6)) channels[ch] = keys;
    }
    if (Object.keys(channels).length) out[bone.id] = channels;
  }
  return out;
}

// Sample a baked channel set the way an engine would: pure linear tween, no
// solver. This is what makes the preview honest -- it plays exactly what was
// exported rather than re-solving and quietly looking better.
export function sampleBaked(baked, period, frame) {
  const f = period > 0 ? ((frame % period) + period) % period : 0;
  const pose = {};

  for (const [boneId, channels] of Object.entries(baked)) {
    const d = { angle: 0, offsetX: 0, offsetY: 0 };
    let any = false;

    for (const [ch, keys] of Object.entries(channels)) {
      if (!keys.length) continue;
      let lo = keys[0];
      let hi = keys[keys.length - 1];
      for (const k of keys) {
        if (k.frame <= f) lo = k;
        if (k.frame >= f) { hi = k; break; }
      }
      d[ch] = lo.frame === hi.frame
        ? lo.value
        : lerp(lo.value, hi.value, (f - lo.frame) / (hi.frame - lo.frame));
      any = true;
    }
    if (any) pose[boneId] = d;
  }
  return pose;
}

// Every active animation, baked and composed -- the engine's view of the scene.
export function bakedPoseAt(doc, frame, cache) {
  const active = (doc.animations ?? []).filter((a) => a.active);
  if (!active.length) return null;

  const poses = active.map((a) => {
    const baked = cache?.get(a.id) ?? bakeAnimation(doc, a);
    return sampleBaked(baked, loopPeriod(a) ?? a.length, frame);
  });

  const out = {};
  for (const pose of poses) {
    for (const [id, d] of Object.entries(pose)) {
      if (!out[id]) out[id] = { angle: 0, offsetX: 0, offsetY: 0 };
      out[id].angle += d.angle;
      out[id].offsetX += d.offsetX;
      out[id].offsetY += d.offsetY;
    }
  }
  return out;
}
