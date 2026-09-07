// central state with subscribe/notify and an undo stack.
//
// every model mutation goes through update(), which snapshots first. that
// keeps undo working without a command pattern, and means new ui (panels,
// timeline, multi-select) can subscribe without any of it knowing about the
// others. view state (pan/zoom) is deliberately outside the undo history.

const LS_KEY = 'tauroid.rigger.doc';
const HISTORY_LIMIT = 200;

// bump when the document shape changes.
export const SCHEMA = 18;

// The oldest schema this build can bring forward.
//
// 3 was the first version after bones and anchors collapsed into one entity
// type. Everything since has been purely ADDITIVE -- v4 added `art`, v5 gave
// art items anchors and roles, v6 added scale -- and normalizeDoc already
// fills every one of those in when absent. So migration is just "accept it and
// let the defaulting run", and a rig built two schema bumps ago still opens.
//
// Anything older stored bones as { anchor: id } pointing into a separate
// `anchors` array. That cannot be reconstructed once the anchor entities are
// gone, so it is refused with an explanation rather than half-loaded.
export const MIN_SCHEMA = 3;

export function createStore(initial) {
  let doc = initial;
  let view = { pan: { x: 0, y: 0 }, zoom: 1, mode: 'rest', anchorDrag: null, frame: 0, playing: false };

  const undoStack = [];
  const redoStack = [];
  let lastCoalesce = null;
  // bumped on every document mutation. baking a scene is expensive, so the
  // preview caches it against this rather than re-deriving a signature.
  let version = 0;

  const subscribers = new Set();

  // isolate subscribers: a throw in one panel must not stop the others from
  // updating, or a single render bug silently freezes the whole editor.
  const notify = () => {
    for (const fn of subscribers) {
      try {
        fn(doc, view);
      } catch (err) {
        console.error('subscriber failed', err);
      }
    }
  };

  const snapshot = () => structuredClone(doc);

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ ...doc, version: SCHEMA }));
    } catch {
      // quota or private mode -- not worth interrupting the user over
    }
  }

  return {
    get doc() { return doc; },
    get view() { return view; },
    get version() { return version; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },

    subscribe(fn) {
      subscribers.add(fn);
      fn(doc, view);
      return () => subscribers.delete(fn);
    },

    // mutate the document. `coalesce` groups a continuous gesture (a drag)
    // into a single undo entry -- pass a stable key for the whole gesture.
    update(mutator, { coalesce = null } = {}) {
      const merging = coalesce != null && coalesce === lastCoalesce;
      if (!merging) {
        undoStack.push(snapshot());
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        redoStack.length = 0;
      }
      lastCoalesce = coalesce;

      const next = mutator(doc);
      if (next !== undefined) doc = next;

      version += 1;
      persist();
      notify();
    },

    // call when a gesture ends so the next one starts a fresh undo entry
    endGesture() { lastCoalesce = null; },

    setView(mutator) {
      const next = mutator(view);
      if (next !== undefined) view = next;
      notify();
    },

    undo() {
      if (!undoStack.length) return;
      redoStack.push(snapshot());
      doc = undoStack.pop();
      lastCoalesce = null;
      version += 1;
      persist();
      notify();
    },

    redo() {
      if (!redoStack.length) return;
      undoStack.push(snapshot());
      doc = redoStack.pop();
      lastCoalesce = null;
      version += 1;
      persist();
      notify();
    },

    replace(next) {
      undoStack.push(snapshot());
      redoStack.length = 0;
      lastCoalesce = null;
      doc = next;
      version += 1;
      persist();
      notify();
    },
  };
}

export function loadDoc() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const doc = normalizeDoc(JSON.parse(raw));
    if (!doc) {
      console.warn('rigger: stored document is unreadable, starting fresh');
      localStorage.removeItem(LS_KEY);
    }
    return doc;
  } catch {
    return null;   // unparseable -- fall through to a fresh document
  }
}

// accept a document only if it matches the current schema, then fill in any
// field that may be absent so nothing downstream has to guard.
// selection is {kind, id} now that art items are selectable too. older docs
// stored a bare bone id.
export const normalizeSelection = (sel) => {
  if (!sel) return null;
  if (typeof sel === 'string') return { kind: 'bone', id: sel };
  if (sel.kind === 'keyframe' && sel.animId != null) return sel;
  // the ghost belongs to the animation, not to a frame -- it has no frame to
  // belong to, being one past the last one that exists
  if (sel.kind === 'ghost' && sel.animId != null) return { kind: 'ghost', animId: sel.animId };
  if (sel.kind === 'anim' && sel.id != null) return sel;
  return sel.id ? { kind: sel.kind === 'art' ? 'art' : 'bone', id: sel.id } : null;
};

export class SchemaError extends Error {}

// How a pre-v17 segment travelled: shortest arc, or a full turn either side of
// it when the key forced a direction. Retained ONLY so the v17 migration can
// read what an old document meant -- nothing else may call it.
function legacyTurn(from, to, turn) {
  const short = ((((to - from) % 360) + 540) % 360) - 180;
  if (turn === 'inc') return short > 0 ? short : short + 360;
  if (turn === 'dec') return short < 0 ? short : short - 360;
  return short;
}

export function normalizeDoc(doc) {
  if (!doc || !Array.isArray(doc.bones)) return null;

  const version = Number.isFinite(doc.version) ? doc.version : 0;

  // the pre-collapse two-entity model: bones referenced anchor entities by id
  if (Array.isArray(doc.anchors) || doc.bones.some((b) => b && b.anchor !== undefined)) {
    throw new SchemaError(
      'this rig predates bones and anchors becoming one type, and cannot be converted',
    );
  }
  if (version < MIN_SCHEMA) {
    throw new SchemaError(`schema v${version || 'unknown'} is older than v${MIN_SCHEMA}`);
  }
  if (version > SCHEMA) {
    throw new SchemaError(`schema v${version} is newer than this build (v${SCHEMA})`);
  }
  if (version < SCHEMA) {
    console.info(`rigger: migrating rig from schema v${version} to v${SCHEMA}`);
  }

  for (const b of doc.bones) {
    b.offset = b.offset && typeof b.offset.x === 'number' ? b.offset : { x: 0, y: 0 };
    b.restAngle = Number.isFinite(b.restAngle) ? b.restAngle : 0;
    b.poseAngle = Number.isFinite(b.poseAngle) ? b.poseAngle : 0;
    b.length = Number.isFinite(b.length) ? b.length : 0;
    // v15: per-field manual-edit locks
    b.locked = {
      offsetX: b.locked?.offsetX === true,
      offsetY: b.locked?.offsetY === true,
      restAngle: b.locked?.restAngle === true,
      length: b.locked?.length === true,
    };
    b.ref = b.ref?.bone
      ? { bone: b.ref.bone, end: b.ref.end === 'tip' ? 'tip' : 'root' }
      : (b.ref?.art ? { art: b.ref.art, anchor: b.ref.anchor ?? null } : null);
    // the field was called `ik` before `match` joined aim and reach
    const c = b.constraint ?? b.ik ?? null;
    delete b.ik;
    if (c && ['aim', 'reach', 'match'].includes(c.kind)) {
      // targets were a bare bone id before they became refs
      const t = typeof c.target === 'string' ? { bone: c.target, end: 'root' } : (c.target ?? null);
      const next = { kind: c.kind, target: t };
      if (c.kind === 'reach') next.bend = c.bend >= 0 ? 1 : -1;
      if (c.kind === 'match') {
        // documents written before x/y could be measured in the target's frame
        // meant world axes, so keep them there rather than silently moving
        // their legs
        next.space = c.space === 'local' ? 'local' : 'world';
        next.take = {
          x: c.take?.x !== false, y: c.take?.y !== false, theta: c.take?.theta !== false,
        };
        next.offset = {
          x: Number.isFinite(c.offset?.x) ? c.offset.x : 0,
          y: Number.isFinite(c.offset?.y) ? c.offset.y : 0,
          theta: Number.isFinite(c.offset?.theta) ? c.offset.theta : 0,
        };
      }
      b.constraint = next;
    } else {
      b.constraint = null;
    }
  }

  doc.art = Array.isArray(doc.art) ? doc.art : [];
  for (const a of doc.art) {
    a.offset = a.offset && typeof a.offset.x === 'number' ? a.offset : { x: 0, y: 0 };
    a.angle = Number.isFinite(a.angle) ? a.angle : 0;
    // display multiplier only; never derived from anything else
    a.scale = Number.isFinite(a.scale) && a.scale > 0 ? a.scale : 1;
    // captured at import; absent on rigs saved before bones could sit on art
    a.viewport = a.viewport && Number.isFinite(a.viewport.scale)
      ? a.viewport
      : { scale: 1, minX: 0, minY: 0 };
    a.visible = a.visible !== false;
    // art used to name a bone directly; now it carries a ref like everything
    // else, so it can sit on a bone TIP or another art's anchor
    if (a.ref === undefined) {
      a.ref = a.bone != null ? { bone: a.bone, end: 'root' } : null;
    }
    delete a.bone;
    a.ref = a.ref?.bone
      ? { bone: a.ref.bone, end: a.ref.end === 'tip' ? 'tip' : 'root' }
      : (a.ref?.art ? { art: a.ref.art, anchor: a.ref.anchor ?? null } : null);
    a.anchors = Array.isArray(a.anchors)
      ? a.anchors.filter((n) => n && typeof n.name === 'string'
          && Number.isFinite(n.x) && Number.isFinite(n.y))
      : [];
    // roles are chosen on the binding, so a name that no longer exists in the
    // anchor list is simply not bound any more
    const names = new Set(a.anchors.map((n) => n.name));
    a.origin = names.has(a.origin) ? a.origin : null;
    a.direction = names.has(a.direction) ? a.direction : null;
  }
  // a bound bone that no longer exists would place art at the world origin
  // silently -- unbind it so the inspector shows the truth
  const live = new Set(doc.bones.map((b) => b.id));
  const artNames = new Map(doc.art.map((a) => [a.id, new Set((a.anchors ?? []).map((n) => n.name))]));
  // anything attached to something that is gone falls back to world rather
  // than silently resolving there
  const prune = (node) => {
    const r = node.ref;
    if (!r) return;
    if (r.bone != null && !live.has(r.bone)) node.ref = null;
    if (r.art != null && !(artNames.get(r.art)?.has(r.anchor))) node.ref = null;
  };
  for (const a of doc.art) prune(a);
  // a constraint whose target is gone is dropped rather than left dangling
  for (const b of doc.bones) {
    const t = b.constraint?.target;
    if (!t) continue;
    const missing = (t.bone != null && !live.has(t.bone))
      || (t.art != null && !doc.art.some((a) => a.id === t.art));
    if (missing) b.constraint = null;
  }

  // likewise a bone rooted on art that is gone, or on an anchor that has been
  // renamed away -- fall back to world rather than silently resolving to it
  for (const b of doc.bones) prune(b);

  // --- animations (v13) -----------------------------------------------------
  doc.animations = Array.isArray(doc.animations) ? doc.animations : [];
  for (const anim of doc.animations) {
    anim.type = ['forward', 'backandforth', 'oneshot'].includes(anim.type)
      ? anim.type : 'forward';
    anim.length = Number.isFinite(anim.length) && anim.length >= 2
      ? anim.length : 12;
    anim.active = anim.active === true;
    anim.keyframes = Array.isArray(anim.keyframes) ? anim.keyframes : [];

    // v18: fenceposts. A duration of N is N intervals, so there are N+1 posts,
    // at frames 0..N. A back-and-forth's apex belongs on post N; sitting it on
    // N-1 shared the apex and the trough between the two legs and made the
    // period 2N-2, which is why a 15-frame jounce ran at 28 and drifted.
    //
    // A forward loop is the exception, and already correct: its post N IS post
    // 0, so its keys stop at N-1 and the ghost speaks for the last post.
    const lastPost = anim.type === 'forward' ? anim.length - 1 : anim.length;
    if (version < 18 && anim.type !== 'forward') {
      // carry the end key out to its proper post, keeping the authored duration
      const end = anim.keyframes.find((k) => k.frame === anim.length - 1);
      if (end && !anim.keyframes.some((k) => k.frame === anim.length)) end.frame = anim.length;
    }

    for (const kf of anim.keyframes) {
      kf.frame = Number.isFinite(kf.frame) ? Math.max(0, Math.min(kf.frame, lastPost)) : 0;
      kf.deltas = kf.deltas && typeof kf.deltas === 'object' ? kf.deltas : {};
      for (const [boneId, d] of Object.entries(kf.deltas)) {
        if (!live.has(boneId)) { delete kf.deltas[boneId]; continue; }
        d.angle = Number.isFinite(d.angle) ? d.angle : 0;
        d.offsetX = Number.isFinite(d.offsetX) ? d.offsetX : 0;
        d.offsetY = Number.isFinite(d.offsetY) ? d.offsetY : 0;
      }
    }
    // Nothing is mandatory: posts 0 and N are implicit zeros unless a key
    // says otherwise, so an animation with no keys at all is well defined and
    // simply contributes nothing.
    anim.keyframes.sort((a, b) => a.frame - b.frame);
  }

  // v16: playback rate belongs to the DOCUMENT, not the view. The engine has
  // to know how fast to play what it was handed, so a rate that only lived in
  // this session's view state could not be exported -- and reopening a rig
  // always gave you 12 regardless of what it was authored at.
  // non-positive means absent, matching advanceFrame's own `fps > 0 ? fps : 12`
  doc.fps = Number.isFinite(doc.fps) && doc.fps > 0
    ? Math.max(1, Math.min(60, Math.round(doc.fps)))
    : 12;

  // v17: `turn` becomes the values themselves, plus a ghost key on the seam.
  //
  // Both halves are exact, because `turn` is precisely the information wrapped
  // values are missing. Read every original before writing anything: the seam
  // is computed from the ORIGINAL last and first values, and unwrapping is
  // about to overwrite them.
  for (const anim of doc.animations) {
    anim.ghost = anim.ghost && typeof anim.ghost === 'object' ? anim.ghost : {};
    if (!anim.keyframes.length) continue;

    const keys = [...anim.keyframes].sort((a, b) => a.frame - b.frame);
    const last = keys[keys.length - 1];
    const first = keys[0];
    const bones = new Set(keys.flatMap((k) => Object.keys(k.deltas)));

    for (const id of bones) {
      const orig = keys.map((k) => k.deltas[id]?.angle ?? 0);
      const turns = keys.map((k) => k.turn);

      // walk the segments, accumulating what each one actually travelled
      const unwrapped = [orig[0]];
      for (let i = 1; i < keys.length; i += 1) {
        unwrapped.push(unwrapped[i - 1] + legacyTurn(orig[i - 1], orig[i], turns[i - 1]));
      }
      keys.forEach((k, i) => { if (k.deltas[id]) k.deltas[id].angle = unwrapped[i]; });

      // the seam: where the last key's outgoing segment was headed. Equal to
      // frame 0's value means the plain closing case, which needs no override.
      if (anim.type !== 'forward' || anim.ghost[id]) continue;
      const from = unwrapped[unwrapped.length - 1];
      const target = from + legacyTurn(orig[orig.length - 1], orig[0], last.turn);
      const start = first.deltas[id] ?? { angle: 0, offsetX: 0, offsetY: 0 };
      // the seam travels literally now, so whatever the old shortest-arc rule
      // did has to be written down. Most loops therefore gain a ghost, which is
      // not a cost -- it is a direction becoming visible instead of implied.
      if (Math.abs(target - start.angle) > 1e-9) {
        anim.ghost[id] = { angle: target, offsetX: start.offsetX, offsetY: start.offsetY };
      }
    }

    for (const k of anim.keyframes) delete k.turn;
  }

  doc.selection = normalizeSelection(doc.selection);
  doc.nextId ??= doc.bones.length + doc.art.length + (doc.animations?.length ?? 0) + 1;
  doc.version = SCHEMA;
  return doc;
}

export const emptyDoc = () => ({ bones: [], art: [], animations: [], selection: null, nextId: 1, fps: 12 });
