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
    // The ghost key: a forward loop's seam target, per bone. See below.
    ghost: {},          // sparse { boneId: delta }; absent means "use frame 0"
  };
}

export function makeKeyframe(frame) {
  return { frame, deltas: {} };
}

// FENCEPOSTS. An animation of duration N has N intervals and therefore N+1
// posts, at frames 0..N inclusive. What post N *is* depends on the type:
//
//   forward         the same post as 0 -- arriving there IS frame 0 of the next
//                   cycle -- so it is never played, and it is the ghost
//   back-and-forth  the apex, played once per cycle, then reflected
//   one-shot        the end, played and then held
//
// Getting this wrong is why a back-and-forth of length N used to run at period
// 2N-2: its last post sat at N-1, so both legs shared the apex and the trough.
// A forward loop's last post is the ghost, so its KEYS stop one short of it.
export const lastKeyFrame = (anim) => (anim.type === 'forward' ? anim.length - 1 : anim.length);

// Implicit keys sit at posts 0 and N, so nothing has to be authored for an
// animation to be well defined. An explicit key at the same frame wins.
//
// Post N is the ghost for a forward loop and is handled by `seamTarget`; for
// the other two it is an ordinary post that defaults to rest.
const EMPTY = { deltas: {} };
function posts(anim) {
  const kfs = anim.keyframes;
  const at = (f) => kfs.find((k) => k.frame === f) ?? { frame: f, deltas: {} };
  const end = lastKeyFrame(anim);
  const inner = kfs.filter((k) => k.frame > 0 && k.frame < end)
    .sort((a, b) => a.frame - b.frame);
  return anim.type === 'forward'
    ? [at(0), ...inner, ...(kfs.some((k) => k.frame === end) && end > 0 ? [at(end)] : [])]
    : [at(0), ...inner, at(end)];
}

// one bone's contribution at a keyframe
export function makeDelta() {
  return { angle: 0, offsetX: 0, offsetY: 0 };
}

export function animById(doc, id) {
  return (doc.animations ?? []).find((a) => a.id === id) ?? null;
}

// Kept as a shape question, not a requirement: these types have a last post at
// frame N that is PLAYED, where a forward loop's post N is the ghost and is not.
export function needsEndFrame(type) {
  return type === 'oneshot' || type === 'backandforth';
}

// Nothing is mandatory any more -- posts 0 and N are implicit -- so this only
// keeps the array in order and drops anything past the last post.
export function ensureEndpoints(anim) {
  const end = lastKeyFrame(anim);
  anim.keyframes = anim.keyframes.filter((k) => k.frame <= end);
  anim.keyframes.sort((a, b) => a.frame - b.frame);
}

// Retime an animation, MOVING its end pose rather than dropping it.
//
// The end key is mandatory and cannot be dragged, so changing the length is the
// only way to move it; re-adding an empty one loses the pose (bug #12).
// Interior keys past the new end are dropped: they are unreachable.
export function setLength(anim, next) {
  const length = Math.max(2, Math.round(Number(next) || 2));
  const oldEnd = lastKeyFrame(anim);
  anim.length = length;
  const newEnd = lastKeyFrame(anim);

  // Carry an explicit last-post key out to the new last post rather than
  // stranding it inside. It is the one key changing the length is the natural
  // way to move, so dropping it and re-adding an empty one loses the pose
  // (bug #12). Interior keys past the new end are still unreachable and go.
  if (newEnd !== oldEnd) {
    const end = anim.keyframes.find((k) => k.frame === oldEnd);
    if (end) {
      anim.keyframes = anim.keyframes.filter((k) => k !== end && k.frame !== newEnd);
      end.frame = newEnd;
      anim.keyframes.push(end);
    }
  }

  ensureEndpoints(anim);
}

// Travel is LITERAL: authored angles are unwrapped, so `to - from` is the
// distance, and -160 -> 160 goes the long way round because that is what the
// numbers say. Two and a half turns is 0 -> 900.
//
// The direction therefore lives in the value, which makes it per bone. It used
// to live in a `turn` flag on the KEYFRAME, shared by every bone in it, so one
// key could not turn the head clockwise and the wrist the other way.
//
// Shortest arc is gone as a default, and that is the trade: writing -160 then
// 160 and meaning "+20 across the seam" now has to be written -160 -> 200.
// Shortest arc was a guess, and the flag existed to overrule the guess.
function lerpDelta(a, b, t) {
  return {
    angle: a.angle + (b.angle - a.angle) * t,
    offsetX: a.offsetX + (b.offsetX - a.offsetX) * t,
    offsetY: a.offsetY + (b.offsetY - a.offsetY) * t,
  };
}

// sample a single animation at a fractional frame number.
// returns { boneId: { angle, offsetX, offsetY } } for every bone that has
// any nonzero contribution.
// `seam: true` asks a forward loop for post N *as itself* rather than wrapping
// it to post 0. Playback always wants the wrap -- arriving there IS frame 0 of
// the next cycle -- but the BAKE wants post N as the tween target of the
// closing segment, and that target is the ghost. See bug #19.
export function samplePose(anim, frame, { seam = false } = {}) {
  const kfs = posts(anim);
  if (!kfs.length) return {};

  // map frame into the animation's range. N intervals, posts 0..N.
  const len = anim.length;
  if (anim.type === 'forward') {
    frame = seam && frame >= len ? len : ((frame % len) + len) % len;
  } else if (anim.type === 'backandforth') {
    // out over N intervals and back over N: 2N, with the apex at post N
    // visited once and the trough at post 0 visited once
    const cycle = len * 2;
    frame = ((frame % cycle) + cycle) % cycle;
    if (frame > len) frame = cycle - frame;
  } else {
    frame = Math.max(0, Math.min(len, frame));
  }

  // find bracketing keyframes
  let lo = kfs[0], hi = kfs[0];
  for (const k of kfs) {
    if (k.frame <= frame) lo = k;
    if (k.frame >= frame) { hi = k; break; }
  }

  // Past the last key, a forward loop tweens to the GHOST: a key at frame
  // `length` that the playhead can never land on, holding a per-bone override
  // of where the seam should arrive. A bone with no override arrives at frame
  // 0's value, which is the plain closing case.
  //
  // The ghost exists because the seam is the one segment the values cannot
  // describe. Key 0 is both of its endpoints, and 0 and 360 are the same pose,
  // so keys at 0 and 90 mean either "swing back" (-90) or "keep spinning"
  // (+270) with identical numbers. Writing 360 on key 0 cannot disambiguate it:
  // that is the same key the next cycle starts from.
  if (anim.type === 'forward' && frame > kfs[kfs.length - 1].frame) {
    lo = kfs[kfs.length - 1];
    const gap = len - lo.frame;
    const t = gap > 0 ? (frame - lo.frame) / gap : 0;
    return interpolateKeyframes(lo, seamTarget(anim), t);
  }

  if (lo === hi || lo.frame === hi.frame) {
    return cloneDeltas(lo.deltas);
  }

  const t = (frame - lo.frame) / (hi.frame - lo.frame);
  return interpolateKeyframes(lo, hi, t);
}

// Where the seam arrives, per bone: frame 0's value, or a ghost override.
//
// Travel stays literal here as everywhere else -- 270 to 0 runs backwards,
// because that is what those two numbers say. Nothing defaults to the shortest
// arc; that guess is what this model exists to delete.
//
// The ghost is needed because frame 0's value has to serve as the loop's START
// as well as its arrival, and one number cannot be both 0 and 360. It is the
// only place in the format where a key is asked to be two things, so it is the
// only place that needs a second value.
function seamTarget(anim) {
  return { deltas: { ...anim.keyframes[0].deltas, ...(anim.ghost ?? {}) } };
}

function interpolateKeyframes(lo, hi, t) {
  const result = {};
  const allBones = new Set([...Object.keys(lo.deltas), ...Object.keys(hi.deltas)]);
  const zero = { angle: 0, offsetX: 0, offsetY: 0 };
  for (const boneId of allBones) {
    const a = lo.deltas[boneId] ?? zero;
    const b = hi.deltas[boneId] ?? zero;
    const d = lerpDelta(a, b, t);
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

// each pose is { boneId: delta }
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
export function poseAt(doc, frame, opts) {
  const active = (doc.animations ?? []).filter((a) => a.active);
  if (!active.length) return null;
  return composeDeltas(active.map((a) => samplePose(a, frame, opts)));
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// How many frames before this animation repeats itself.
//
// A one-shot has NO period: it plays once and holds. Giving it one makes it
// appear to loop (bug #13).
export function loopPeriod(anim) {
  if (anim.type === 'forward') return anim.length;
  // N intervals out and N back, with the apex on post N. It used to be
  // (N-1)*2, which shared the apex and the trough between the legs and made a
  // 15-frame jounce run at 28 rather than 30 -- close enough to look right and
  // far enough to drift against everything.
  if (anim.type === 'backandforth') return anim.length * 2;
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
  // a one-shot's last post is N, not N-1
  const ends = activeAnims(doc).map((a) => a.length);
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
