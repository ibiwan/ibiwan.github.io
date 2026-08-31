import { wrapDeg } from './math.js';

// animation data model and interpolation.
//
// an animation is a fixed-length sequence of keyframes. each keyframe stores
// per-bone deltas from rest (angle + offset). between keyframes the deltas
// are linearly interpolated. when multiple animations affect the same bone
// at the same instant their deltas add (commutative).

export function makeAnimation(id, name) {
  return {
    id,
    name,
    type: 'forward',    // 'forward' | 'backandforth' | 'oneshot'
    length: 12,         // total frames
    active: false,      // shown in lane view
    keyframes: [
      makeKeyframe(0),  // start pose is always present
    ],
  };
}

export function makeKeyframe(frame) {
  // `turn` governs the OUTGOING segment: how this key's angles travel to the
  // next one. For a forward loop the last key's outgoing segment is the wrap
  // back to frame 0, which is otherwise the one segment you cannot address.
  return { frame, deltas: {}, turn: 'auto' };
}

export const TURNS = ['auto', 'inc', 'dec'];

// one bone's contribution at a keyframe
export function makeDelta() {
  return { angle: 0, offsetX: 0, offsetY: 0 };
}

export function animById(doc, id) {
  return (doc.animations ?? []).find((a) => a.id === id) ?? null;
}

// does this animation type require an explicit end keyframe?
export function needsEndFrame(type) {
  return type === 'oneshot' || type === 'backandforth';
}

// ensure start/end keyframes exist for the given type and length
export function ensureEndpoints(anim) {
  const hasStart = anim.keyframes.some((k) => k.frame === 0);
  if (!hasStart) anim.keyframes.unshift(makeKeyframe(0));

  const endFrame = anim.length - 1;
  if (needsEndFrame(anim.type)) {
    const hasEnd = anim.keyframes.some((k) => k.frame === endFrame);
    if (!hasEnd) anim.keyframes.push(makeKeyframe(endFrame));
  }

  anim.keyframes.sort((a, b) => a.frame - b.frame);
}

// clamp or remove keyframes that fall outside the new length
export function trimKeyframes(anim) {
  anim.keyframes = anim.keyframes.filter((k) => k.frame < anim.length);
  ensureEndpoints(anim);
}

// How far an angle travels over one segment.
//
// Angles are directions, not magnitudes: lerping them as plain numbers makes
// 270 -> 0 count DOWN through 135, unwinding the turn instead of finishing it.
// So the segment carries a rotation, and the stored values only say where the
// ends point.
//
//   auto  the short way round, (-180, 180]. what you want almost always,
//         and what closes a loop correctly.
//   inc   forced increasing (clockwise, since +y is down here)
//   dec   forced decreasing
//
// A forced direction across equal angles is a FULL revolution rather than no
// movement at all -- that is how a continuous spin is authored, and shortest
// arc has no way to say it.
export function turnDelta(from, to, turn = 'auto') {
  const short = wrapDeg(to - from);
  if (turn === 'inc') return short > 0 ? short : short + 360;
  if (turn === 'dec') return short < 0 ? short : short - 360;
  return short;
}

// lerp between two delta objects; the angle rotates, the offsets translate
function lerpDelta(a, b, t, turn) {
  return {
    angle: a.angle + turnDelta(a.angle, b.angle, turn) * t,
    offsetX: a.offsetX + (b.offsetX - a.offsetX) * t,
    offsetY: a.offsetY + (b.offsetY - a.offsetY) * t,
  };
}

// sample a single animation at a fractional frame number.
// returns { boneId: { angle, offsetX, offsetY } } for every bone that has
// any nonzero contribution.
export function samplePose(anim, frame) {
  const kfs = anim.keyframes;
  if (!kfs.length) return {};

  // map frame into the animation's range
  const len = anim.length;
  if (anim.type === 'forward') {
    frame = ((frame % len) + len) % len;
  } else if (anim.type === 'backandforth') {
    const cycle = (len - 1) * 2;
    frame = ((frame % cycle) + cycle) % cycle;
    if (frame >= len - 1) frame = cycle - frame;
  } else {
    frame = Math.max(0, Math.min(len - 1, frame));
  }

  // find bracketing keyframes
  let lo = kfs[0], hi = kfs[0];
  for (const k of kfs) {
    if (k.frame <= frame) lo = k;
    if (k.frame >= frame) { hi = k; break; }
  }

  // for forward loops, if frame is past the last keyframe, tween to start
  if (anim.type === 'forward' && frame > kfs[kfs.length - 1].frame) {
    lo = kfs[kfs.length - 1];
    hi = kfs[0];
    const gap = len - lo.frame + hi.frame;
    const t = gap > 0 ? (frame - lo.frame) / gap : 0;
    return interpolateKeyframes(lo, hi, t);
  }

  if (lo === hi || lo.frame === hi.frame) {
    return cloneDeltas(lo.deltas);
  }

  const t = (frame - lo.frame) / (hi.frame - lo.frame);
  return interpolateKeyframes(lo, hi, t);
}

function interpolateKeyframes(lo, hi, t) {
  const result = {};
  const allBones = new Set([...Object.keys(lo.deltas), ...Object.keys(hi.deltas)]);
  const zero = { angle: 0, offsetX: 0, offsetY: 0 };
  for (const boneId of allBones) {
    const a = lo.deltas[boneId] ?? zero;
    const b = hi.deltas[boneId] ?? zero;
    // the outgoing key owns the segment, so its turn mode is the one that
    // applies -- including on a forward loop's wrap back to the start
    const d = lerpDelta(a, b, t, lo.turn);
    if (d.angle !== 0 || d.offsetX !== 0 || d.offsetY !== 0) result[boneId] = d;
  }
  return result;
}

function cloneDeltas(deltas) {
  const result = {};
  for (const [id, d] of Object.entries(deltas)) {
    result[id] = { ...d };
  }
  return result;
}

// compose multiple sampled poses (additive). each is { boneId: delta }.
export function composeDeltas(poses) {
  const result = {};
  for (const pose of poses) {
    for (const [boneId, d] of Object.entries(pose)) {
      if (!result[boneId]) {
        result[boneId] = { angle: 0, offsetX: 0, offsetY: 0 };
      }
      result[boneId].angle += d.angle;
      result[boneId].offsetX += d.offsetX;
      result[boneId].offsetY += d.offsetY;
    }
  }
  return result;
}

// The whole scene's pose at a global frame: every active animation sampled at
// the same instant and added together. Each lane loops on its own period, so a
// 5-frame and a 7-frame cycle line up again only every 35 frames -- the
// metaloop is emergent, and nothing has to author it.
export function poseAt(doc, frame) {
  const active = (doc.animations ?? []).filter((a) => a.active);
  if (!active.length) return null;
  return composeDeltas(active.map((a) => samplePose(a, frame)));
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// How many frames before this animation repeats itself.
//
// A one-shot has NO period: it plays once and holds. Giving it one is what
// made a lone one-shot appear to loop, snapping from its held end pose back to
// the start every time the playhead wrapped.
export function loopPeriod(anim) {
  if (anim.type === 'forward') return anim.length;
  if (anim.type === 'backandforth') return (anim.length - 1) * 2;
  return null;
}

const activeAnims = (doc) => (doc.animations ?? []).filter((a) => a.active);

// Is anything actually cycling? If not, playback has an end to stop at.
export const hasLoop = (doc) => activeAnims(doc).some((a) => loopPeriod(a) != null);

// How long until every looping lane is back at its own frame 0 together.
//
// A READOUT, not a mechanism. Nothing depends on it: each lane wraps on its own
// period and the engine never needs to know when they realign. It is reported
// because it is interesting -- 60, 68 and 28 only line up again after 7140
// frames -- and because an earlier version wrapped the playhead here, which is
// what forced it to be exact. The playhead no longer wraps at all.
export function metaloopLength(doc, ceiling = 1e6) {
  const lens = activeAnims(doc).map(loopPeriod).filter((n) => n > 0);
  if (!lens.length) return 0;
  let out = 1;
  for (const n of lens) {
    out = (out * n) / gcd(out, n);
    if (out >= ceiling) return ceiling;
  }
  return out;
}

// How much timeline is worth looking at: the longest lane, where a loop counts
// double so you can watch it come round and check the seam. Purely a viewing
// window -- it is where scrubbing lands, not where anything repeats.
export function windowLength(doc) {
  const spans = activeAnims(doc).map((a) => {
    const p = loopPeriod(a);
    return p == null ? a.length : p * 2;
  });
  return spans.length ? Math.max(...spans) : 0;
}

// The frame playback should stop on, or null if anything loops -- a loop has no
// end to reach, and a one-shot holds its last pose.
export function endsAt(doc) {
  if (hasLoop(doc)) return null;
  const ends = activeAnims(doc).map((a) => a.length - 1);
  return ends.length ? Math.max(...ends) : null;
}

// Tick spacing for a ruler of this many frames: a round number chosen so the
// tick COUNT stays bounded however long the timeline is. Drawing every fifth
// frame across a 7140-frame metaloop would be 1400 elements for no benefit.
export function tickStep(frames, maxTicks = 60) {
  const ladder = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  return ladder.find((n) => frames / n <= maxTicks) ?? ladder[ladder.length - 1];
}

// Where the playhead lands dt seconds later.
//
// Time runs FREE: each lane wraps on its own period, so the composite is
// continuous forever and there is no shared wrap point to get wrong. Only a set
// with no loops in it has a real ending, and that is what stopAt is for.
//
// Pure so the stepping rule is testable without a clock: a backgrounded tab
// hands back one enormous delta, and jumping the playhead by an arbitrary
// amount on resume is worse than dropping the tick.
export function advanceFrame(frame, dt, fps, { stopAt = null, maxStep = 0.5 } = {}) {
  if (!(dt > 0) || dt > maxStep) return frame ?? 0;
  const next = (frame ?? 0) + dt * (fps > 0 ? fps : 12);
  return stopAt == null ? next : Math.min(next, stopAt);
}
