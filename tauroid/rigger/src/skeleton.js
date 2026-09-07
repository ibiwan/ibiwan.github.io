// bones. that is the only entity type.
//
// a bone is:
//   ref         what it hangs off
//   offset      x/y in the ref's coordinates
//   restAngle   rest direction, relative to the ref's direction
//   poseAngle   delta from rest
//   length      extent along its own direction; may be 0
//
// a bone always has a direction. it may have zero length -- that is how a grip
// point, socket, mount or ik target is expressed. it is NOT a separate type:
// there is one entity, so there is no second way to say the same thing and
// nothing for it to be confused with.
//
// direction and length are stored separately rather than as a tip, because
// they are not equivalent at length 0: a zero-length bone is still a valid
// oriented frame that children inherit, whereas a tip equal to its own origin
// has no derivable direction. a unit vector is how you DERIVE a direction
// (subtract two points, normalise, discard the magnitude); an angle is what
// survives storage, since it tweens correctly and cannot drift off-normal.

import { v2, add, rotate, sub, angleOf, dist, len, wrapDeg, DEG } from './math.js';
import { artById, anchorWorld } from './art.js';

export const IDENTITY = { pos: v2(0, 0), angle: 0 };

// what a bone can hang off:
//
//   null                      world origin
//   { bone: id, end:'root' }  another bone's root -- an explicit frame
//   { bone: id, end:'tip' }   an implicit anchor, derived from that bone's
//                             length, so children track it instead of
//                             snapshotting a position
//   { art: id, anchor: name } an anchor on a piece of art in the scene. the
//                             bone inherits the art's rotation, so a bone on a
//                             weapon's grip turns with the weapon.
export const makeBone = (id, name, ref = null, length = 40) => ({
  id,
  name,
  ref,
  offset: v2(0, 0),
  restAngle: 0,
  poseAngle: 0,
  length,
  constraint: null,   // see solveConstraints
  // Axis-snapping for the drag, not write protection. A hand cannot move in a
  // perfect orthogonal line or a perfect arc, so holding x turns a sloppy drag
  // into an exact vertical one. They gate the INSPECTOR and DRAGGING only:
  // constraints are evaluated rather than stored, and posing writes poseAngle,
  // so neither is blocked by a lock.
  locked: { offsetX: false, offsetY: false, restAngle: false, length: false },
});

export const LOCKS = ['offsetX', 'offsetY', 'restAngle', 'length'];
export const isLocked = (bone, field) => bone?.locked?.[field] === true;

export const boneById = (doc, id) => doc.bones.find((b) => b.id === id) ?? null;
// Direct children in the tree sense.
//
// Includes bones rooted on an ART anchor whose art is placed on this bone --
// otherwise a hand sitting on a weapon's grip appears detached at the top of
// the hierarchy, when it is really a descendant by way of the art.
export function childrenOf(doc, id) {
  const viaArt = new Set(
    (doc.art ?? []).filter((a) => a.ref?.bone === id).map((a) => a.id),
  );
  return doc.bones.filter((b) => b.ref?.bone === id
    || (b.ref?.art != null && viaArt.has(b.ref.art)));
}
export const boneKey = (id, end) => `${id}:${end}`;
export const artAnchorKey = (id, name) => `art:${id}:${name}`;

// The frame key a ref resolves to. Bone root, bone tip and art anchor are one
// union, so anything that points somewhere -- a parent, an ik target -- can use
// the same shape and the same picker.
export const refKey = (ref) => {
  if (ref?.art != null) return artAnchorKey(ref.art, ref.anchor);
  if (ref?.bone != null) return boneKey(ref.bone, ref.end ?? 'root');
  return null;
};

// Everything a ref resolves through, bones and art alike, nearest first.
//
// Art is attached by a ref of its own now, so the walk alternates freely
// between the two node kinds. Self-terminating on repeats, so a malformed
// document doesn't spin.
export function* refChain(doc, ref) {
  const seen = new Set();
  let cur = ref;

  while (cur) {
    if (cur.art != null) {
      const key = `a:${cur.art}`;
      if (seen.has(key)) return;
      seen.add(key);
      yield { kind: 'art', id: cur.art };
      cur = artById(doc, cur.art)?.ref ?? null;
      continue;
    }
    if (cur.bone == null) return;
    const key = `b:${cur.bone}`;
    if (seen.has(key)) return;
    seen.add(key);
    yield { kind: 'bone', id: cur.bone };
    cur = boneById(doc, cur.bone)?.ref ?? null;
  }
}

export function dependsOn(doc, ref, boneIds) {
  for (const node of refChain(doc, ref)) {
    if (node.kind === 'bone' && boneIds.includes(node.id)) return true;
  }
  return false;
}

export function dependsOnArt(doc, ref, artId) {
  for (const node of refChain(doc, ref)) {
    if (node.kind === 'art' && node.id === artId) return true;
  }
  return false;
}
// A property, not a category. Every bone has a length; some are zero, and a
// bone whose length is zero is not a different kind of thing -- it is a
// frame with a direction and nothing drawn along it.
export const hasExtent = (b) => b.length > 0.001;

// How many solve passes can possibly be needed.
//
// A constraint whose target is ITSELF constrained can only be solved once its
// target has been, and each pass advances that frontier by exactly one link. So
// the bound is the number of CONSTRAINTS: only constrained bones can be links
// in such a chain, and an acyclic chain cannot revisit one. Unconstrained bones
// add no depth, which is why this counts constraints and not bones.
//
// That makes the bound exact rather than a guess -- every acyclic arrangement
// settles within it, and the early break means real rigs cost two passes
// regardless of the bound. Circular arrangements never settle, and the bound is
// what stops them; each pass is finite because the cycle guards handle the
// recursion.
const solvePasses = (doc) =>
  doc.bones.reduce((n, b) => n + (b.constraint ? 1 : 0), 0) + 1;

const sameOverrides = (a, b) => {
  if (!a || !b || a.size !== b.size) return false;
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y) return false;
    for (const k of ['x', 'y', 'angle']) {
      if ((x[k] === undefined) !== (y[k] === undefined)) return false;
      if (x[k] !== undefined && Math.abs(x[k] - y[k]) > 1e-9) return false;
    }
  }
  return true;
};

// `deltas` is a composed animation pose: { boneId: { angle, offsetX, offsetY } }.
// It layers on exactly like poseAngle does -- added to rest, offsets rotating
// into the parent frame -- so constraints still solve against the posed rig.
export function resolveFrames(doc, { posed = true, constraints = true, deltas = null } = {}) {
  // Constraints are evaluated, never stored: solve, then resolve again with the
  // results as world overrides. Repeat until the answer stops moving, so a
  // constraint pointed at another constrained bone sees its SOLVED position
  // rather than its unconstrained one.
  let overrides = null;
  if (constraints && doc.bones.some((b) => b.constraint)) {
    const passes = solvePasses(doc);
    for (let pass = 0; pass < passes; pass += 1) {
      const frames = resolveOnce(doc, posed, overrides, deltas).frames;
      const next = solveConstraints(doc, frames);
      if (sameOverrides(next, overrides)) break;
      overrides = next;
    }
  }
  return resolveOnce(doc, posed, overrides, deltas);
}

function resolveOnce(doc, posed, overrides, deltas) {
  const frames = new Map();
  const active = new Set();

  const boneFrame = (id, end) => {
    const key = boneKey(id, end);
    if (frames.has(key)) return frames.get(key);
    if (active.has(key)) return IDENTITY;   // cycle: bail rather than recurse
    active.add(key);

    const b = boneById(doc, id);
    let out = IDENTITY;
    if (b) {
      // defensive: a document that lost a field should render wrong, not throw
      const base = b.offset ?? v2(0, 0);
      const len = Number.isFinite(b.length) ? b.length : 0;
      const rest = Number.isFinite(b.restAngle) ? b.restAngle : 0;
      let pose = posed && Number.isFinite(b.poseAngle) ? b.poseAngle : 0;

      // Animation deltas add rather than replace, so several animations
      // touching one bone compose without fighting.
      //
      // Independent of `posed`: a delta is measured from REST, because that is
      // what the export's rest configuration contains and what the engine composes
      // against. Gating it on poseAngle would make a baked pose land wherever
      // the last manual drag happened to leave the bone.
      const d = deltas?.[b.id] ?? null;
      const offset = d ? v2(base.x + d.offsetX, base.y + d.offsetY) : base;
      if (d) pose += d.angle;

      const parent = refFrame(b.ref);
      const root = {
        pos: add(parent.pos, rotate(offset, parent.angle)),
        angle: parent.angle + rest + pose,
      };

      // partial world override: only the components a constraint actually
      // drives are replaced, so `match` can take x without touching theta
      const ov = overrides?.get(b.id);
      if (ov) {
        if (ov.x !== undefined) root.pos = v2(ov.x, root.pos.y);
        if (ov.y !== undefined) root.pos = v2(root.pos.x, ov.y);
        if (ov.angle !== undefined) root.angle = ov.angle;
      }
      out = end === 'tip'
        ? { pos: add(root.pos, rotate(v2(len, 0), root.angle)), angle: root.angle }
        : root;
    }

    active.delete(key);
    frames.set(key, out);
    return out;
  };

  // art placed on a bone, so a bone can hang off one of its anchors. the same
  // memo and cycle guard cover it: art -> bone -> art recursion bottoms out at
  // IDENTITY rather than looping.
  const artFrame = (id, anchorName) => {
    const key = artAnchorKey(id, anchorName);
    if (frames.has(key)) return frames.get(key);
    if (active.has(key)) return IDENTITY;
    active.add(key);

    const item = artById(doc, id);
    let out = IDENTITY;
    if (item) {
      // a bone TIP carries the bone's angle, so binding art there keeps its
      // direction and only moves the origin -- which is what removes the need
      // for a helper bone at the far end
      out = anchorWorld(item, refFrame(item.ref), anchorName) ?? IDENTITY;
    }

    active.delete(key);
    frames.set(key, out);
    return out;
  };

  const refFrame = (ref) => {
    if (!ref) return IDENTITY;              // world
    if (ref.art != null) return artFrame(ref.art, ref.anchor);
    if (ref.bone != null) return boneFrame(ref.bone, ref.end ?? 'root');
    return IDENTITY;
  };

  for (const b of doc.bones) {
    boneFrame(b.id, 'root');
    boneFrame(b.id, 'tip');
  }
  for (const item of doc.art ?? []) {
    for (const a of item.anchors ?? []) artFrame(item.id, a.name);
  }

  return { frames, refFrame, boneFrame, artFrame };
}

// would pointing bone `id` at `ref` create a cycle? the walk crosses into art,
// since a bone can hang off an art anchor and that art hangs off something too
export const wouldCycle = (doc, id, ref) => dependsOn(doc, ref, [id]);

// everything that transitively hangs off a bone, so deleting cascades instead
// of leaving dangling refs behind
export function subtree(doc, id) {
  const dead = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of doc.bones) {
      if (dead.has(b.id)) continue;
      if (b.ref?.bone != null && dead.has(b.ref.bone)) { dead.add(b.id); changed = true; }
    }
  }
  return dead;
}

// The edit modes, as a ladder -- each rung adds exactly one thing:
//
//   rest    the rest configuration, raw
//   solve   + constraints, so ik is visible while the configuration is built
//   pose    + pose deltas
//   anim    + animation deltas
//
// `rest` and `solve` both EDIT the rest configuration; the difference is only
// whether the solve runs. That is why constraints are an independent flag on
// resolveFrames rather than something posing switches on.
export const editsRest = (mode) => mode === 'rest' || mode === 'solve';
export const solvesIk = (mode) => mode !== 'rest';
// rest -> pose -> [standing solve] -> animation, all added.
//
// `anim` runs no solver PER FRAME -- the standing solve is recomputed whenever
// the rig changes, but never per frame: it arrives as a per-bone constant and
// each animation contributes only what it CHANGES, so both are just deltas by
// the time they get here. That is what the engine does too, which is what makes
// the preview honest -- including the small error where two animations move the
// same constrained chain and their separately-solved contributions are summed.
export const frameOpts = (mode, deltas = null) => ({
  posed: !editsRest(mode),
  constraints: mode === 'anim' ? false : solvesIk(mode),
  deltas: mode === 'anim' ? deltas : null,
});

// --- drag decomposition -----------------------------------------------------

// where must this bone's offset be, for its root to sit at `worldPos`?
//
// Resolved in the MODE's terms, like aimAt: a rest-mode drag measures against
// the raw parent frame, a solve-mode drag against the solved one (bug #7).
export function worldToOffset(doc, bone, worldPos, mode) {
  const { refFrame } = resolveFrames(doc, frameOpts(mode));
  const p = refFrame(bone.ref);
  return rotate(sub(worldPos, p.pos), -p.angle);
}

// the angle this bone needs so it points at `worldPos`, split into whichever of
// rest/pose is being edited. length only applies in rest mode -- posing
// rotates, it never stretches.
export function aimAt(doc, bone, worldPos, mode, { snap = 0 } = {}) {
  // resolve in the same terms the mode is DISPLAYING, so the bone lands under
  // the cursor rather than under some other version of itself
  const { refFrame, boneFrame } = resolveFrames(doc, frameOpts(mode));
  const parent = refFrame(bone.ref);
  const self = boneFrame(bone.id, 'root');

  // snapping is applied in WORLD space, so a constrained drag lands on the
  // compass points you can see, not on multiples of the parent's angle
  let want = angleOf(sub(worldPos, self.pos));
  if (snap > 0) want = Math.round(want / snap) * snap;
  const local = wrapDeg(want - parent.angle);

  // `local` is already relative to the parent as the mode resolved it, so the
  // component being edited is exactly `local`. Subtracting the other one
  // double-counts (bug #6).
  return editsRest(mode)
    ? { restAngle: local, length: dist(self.pos, worldPos) }
    : { poseAngle: wrapDeg(local - bone.restAngle) };
}


// --- inverse kinematics -----------------------------------------------------
//
// A constraint lives on the EFFECTOR bone and comes in two kinds, which are
// different promises rather than a count of links:
//
//   aim    one angle. rotate this bone to POINT AT the target. always
//          solvable; the tip only touches the target if the distance happens
//          to match the bone's length.
//   reach  two angles. this bone and its parent, law of cosines, tip ON the
//          target. has reach limits, and a bend side to pick between the two
//          mirror solutions.
//
// IK is evaluated, never stored: it writes nothing back to poseAngle, so the
// authored pose stays the thing it solves from and a constraint can be removed
// without leaving residue. Export bakes whatever it resolved to.

// `target` is a REF -- bone root, bone tip, or art anchor -- the same union a
// bone's parent uses.
export const makeConstraint = (kind, target = null) => {
  const c = { kind, target };
  if (kind === 'reach') c.bend = 1;
  if (kind === 'match') {
    // which components to take from the target, and by how much. anything
    // unchecked is simply not overridden, so it keeps whatever the bone's
    // normal placement gives it.
    c.take = { x: true, y: true, theta: true };
    c.offset = { x: 0, y: 0, theta: 0 };
    // `local` measures x/y in the TARGET's frame, so an offset survives the rig
    // turning; `world` measures them along the scene axes, which only does what
    // you mean while the rig is axis-aligned. new constraints default to local;
    // documents from before this existed migrate to world, preserving them.
    c.space = 'local';
  }
  return c;
};

// Why a constraint cannot run, or null if it can.
export function constraintProblem(doc, bone) {
  const ik = bone?.constraint;
  if (!ik) return null;
  if (!ik.target) return 'no target';
  if (ik.target.art != null && !artById(doc, ik.target.art)) return 'target art is gone';
  if (ik.target.bone != null && !boneById(doc, ik.target.bone)) return 'target bone is gone';

  if (ik.kind === 'match') {
    if (!ik.take?.x && !ik.take?.y && !ik.take?.theta) return 'nothing selected to match';
  }

  const chain = [bone.id];
  if (ik.kind === 'reach') {
    const parent = boneById(doc, bone.ref?.bone);
    if (!parent) return 'reach needs a parent bone to rotate';
    if (bone.ref?.end !== 'tip') return 'reach needs this bone on its parent’s tip';
    if (Math.abs(bone.offset.x) > 1e-6 || Math.abs(bone.offset.y) > 1e-6) {
      return 'reach needs a zero offset, so the joint sits at the parent’s tip';
    }
    // one link of length zero is fine -- it degenerates to an aim. two is
    // not: nothing has extent, so nothing can be moved onto the target.
    if (bone.length <= 1e-6 && parent.length <= 1e-6) {
      return 'reach needs a non-zero length on this bone or its parent';
    }
    chain.push(parent.id);
  }

  // a target that resolves through the chain is circular: the solve would
  // depend on its own result. the ref graph has no cycle, so nothing else
  // would catch it -- and it can now run through art as well as bones.
  if (dependsOn(doc, ik.target, chain)) return 'target hangs off the chain it drives';
  return null;
}

/**
 * Solve every constraint, returning { boneId: poseAngle } overrides.
 *
 * Two passes are needed and one is enough: targets and chain roots are
 * resolved from an unsolved pass, which is valid because neither depends on
 * the angles being solved for. Nested chains -- an IK bone above another IK
 * bone -- would need iteration and are not handled.
 */
export function solveConstraints(doc, baseFrames) {
  // world-space partial overrides: { x?, y?, angle? }. anything absent keeps
  // whatever the bone's normal placement produced, which is what makes
  // `match` able to take only some components.
  const overrides = new Map();
  const put = (id, patch) => overrides.set(id, { ...(overrides.get(id) ?? {}), ...patch });

  for (const bone of doc.bones) {
    const c = bone.constraint;
    if (!c || constraintProblem(doc, bone)) continue;

    const target = baseFrames.get(refKey(c.target));
    if (!target) continue;

    // Where this bone sits BEFORE its own override.
    //
    // Reading the solved frame instead would feed a component back into
    // itself: an untaken component would be re-read from the previous pass's
    // output and freeze at whatever the first pass happened to produce, so a
    // partially-matched bone would stop following its parent.
    const host = baseFrames.get(refKey(bone.ref)) ?? IDENTITY;
    // Position only. No angle: every solver here is closed-form, so none of
    // them needs a seed, and folding poseAngle in would imply the pose biases
    // a solve when it does not. `reach` picks its branch from the explicit
    // `bend` flag rather than from whichever solution is nearer the current
    // pose -- which is what stops it popping when the chain crosses straight.
    const self = {
      pos: add(host.pos, rotate(bone.offset ?? v2(0, 0), host.angle)),
    };

    if (c.kind === 'match') {
      const patch = {};
      if (c.take?.theta) patch.angle = target.angle + (c.offset?.theta ?? 0);

      if (c.space === 'world') {
        // world axes: the offset is a delta along x and y as the scene sees
        // them. only does what you mean while the rig is axis-aligned.
        if (c.take?.x) patch.x = target.pos.x + (c.offset?.x ?? 0);
        if (c.take?.y) patch.y = target.pos.y + (c.offset?.y ?? 0);
      } else if (c.take?.x || c.take?.y) {
        // the target's own frame: decompose where this bone naturally sits into
        // the target's axes, replace the components being taken, recompose.
        // bones point along local +x, so local x is FORWARD and local y is
        // LATERAL -- which is what makes an offset survive the rig turning.
        const local = rotate(sub(self.pos, target.pos), -target.angle);
        const lx = c.take?.x ? (c.offset?.x ?? 0) : local.x;
        const ly = c.take?.y ? (c.offset?.y ?? 0) : local.y;
        const world = add(target.pos, rotate(v2(lx, ly), target.angle));
        patch.x = world.x;
        patch.y = world.y;
      }

      put(bone.id, patch);
      continue;
    }

    if (c.kind === 'aim') {
      // a bone's own root position doesn't depend on its own angle, so the
      // unsolved pass gives the right pivot
      put(bone.id, { angle: angleOf(sub(target.pos, self.pos)) });
      continue;
    }

    const parent = boneById(doc, bone.ref.bone);
    const R = baseFrames.get(boneKey(parent.id, 'root'));
    if (!R) continue;

    const L1 = parent.length;
    const L2 = bone.length;
    const toTarget = sub(target.pos, R.pos);
    // clamp BEFORE the acos: an out-of-reach target should straighten the
    // chain toward it, not produce NaN
    const d = Math.min(L1 + L2, Math.max(Math.abs(L1 - L2), len(toTarget)));
    if (d <= 1e-9) continue;

    // A zero-length link is not a broken reach, it is a reach with one joint
    // instead of two -- so it degenerates to an aim rather than being refused.
    // The law of cosines below divides by L1 and by L1*L2, which is the only
    // reason these need handling separately.
    if (L1 <= 1e-6 && L2 <= 1e-6) continue;      // both lengths zero: nothing to solve
    if (L2 <= 1e-6) {
      // this bone's length is zero, so its tip IS the parent's tip: putting that
      // on the target is the whole solve, and this bone's own angle is left to
      // its rest and pose rather than being invented
      put(parent.id, { angle: angleOf(toTarget) });
      continue;
    }
    if (L1 <= 1e-6) {
      // the parent's length is zero, so this bone's root is already pinned and it
      // simply aims itself -- the parent's angle drives nothing here
      put(bone.id, { angle: angleOf(toTarget) });
      continue;
    }

    const unit = (x) => Math.min(1, Math.max(-1, x));
    const alpha = Math.acos(unit((d * d + L1 * L1 - L2 * L2) / (2 * d * L1))) / DEG;
    const beta = Math.acos(unit((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))) / DEG;

    const bend = c.bend >= 0 ? 1 : -1;
    const parentWorld = angleOf(toTarget) + bend * alpha;
    put(parent.id, { angle: parentWorld });
    put(bone.id, { angle: parentWorld - bend * (180 - beta) });
  }

  return overrides;
}
