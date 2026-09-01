// pointer + keyboard interaction. handles are identified by data-* attributes
// on the rendered svg, so adding a new draggable thing means emitting new
// attributes rather than extending a hit-test switch.
//
// the rest/pose mode decides what a drag edits. rest is full editing; pose
// rotates only, because a pose is a rotation delta and stretching a bone at
// pose time would bake a length change into an animation.

import { boneById, subtree, worldToOffset, aimAt, editsRest, isLocked,
} from './skeleton.js';
import { needsEndFrame } from './animation.js';
import { artById, anchorNamed } from './art.js';
import { wrapDeg } from './math.js';

const SNAP_DEGREES = 45;

export function attachTools(svg, store, canvas) {
  let drag = null;
  let pan = null;

  // anchors live on a <g>, so walk up from whatever child got the event
  const pick = (t) => {
    const anchorEl = t?.closest?.('[data-anchor]');
    if (anchorEl) {
      return {
        handle: 'anchor',
        art: anchorEl.getAttribute('data-art'),
        anchor: anchorEl.getAttribute('data-anchor'),
      };
    }
    const id = t?.getAttribute?.('data-id');
    return id ? { id, handle: t.getAttribute('data-handle') } : null;
  };

  svg.addEventListener('pointerdown', (e) => {
    const hit = pick(e.target);
    // shift over a handle constrains the drag, so it can't also mean pan.
    // empty-drag already pans, and middle-drag pans from anywhere.
    if (e.button === 1 || !hit) {
      pan = { start: { x: e.clientX, y: e.clientY }, from: { ...store.view.pan } };
      if (!hit) store.update((d) => { d.selection = null; });
      svg.setPointerCapture(e.pointerId);
      return;
    }

    if (hit.handle === 'anchor') {
      // already selected (anchors only render on the highlighted item), so
      // just start dragging
      const toArt = canvas.artSpaceMapper(hit.art);
      const start = anchorNamed(artById(store.doc, hit.art) ?? {}, hit.anchor);
      drag = toArt && start && { handle: 'anchor', art: hit.art, anchor: hit.anchor, toArt };
      if (drag) {
        store.setView((v) => {
          v.anchorDrag = { art: hit.art, anchor: hit.anchor, x: start.x, y: start.y };
        });
      }
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    store.update((d) => { d.selection = { kind: 'bone', id: hit.id }; });

    // where a bone SITS is rest configuration, so it is draggable only in the
    // modes that edit that configuration; posing rotates and never relocates
    const movable = hit.handle === 'tip' || hit.handle === 'rotate'
      || (hit.handle === 'root' && editsRest(store.view.mode));

    drag = movable
      ? { handle: hit.handle, id: hit.id, gesture: `${hit.handle}:${hit.id}:${Date.now()}` }
      : null;

    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  svg.addEventListener('pointermove', (e) => {
    if (pan) {
      const z = store.view.zoom;
      store.setView((v) => {
        v.pan.x = pan.from.x - (e.clientX - pan.start.x) / z;
        v.pan.y = pan.from.y - (e.clientY - pan.start.y) / z;
      });
      return;
    }
    if (!drag) return;

    if (drag.handle === 'anchor') {
      // view state only -- the document, and therefore the art's placement,
      // is untouched until the gesture ends
      const local = drag.toArt(e.clientX, e.clientY);
      store.setView((v) => {
        if (v.anchorDrag) { v.anchorDrag.x = local.x; v.anchorDrag.y = local.y; }
      });
      return;
    }

    const world = canvas.toWorld(e.clientX, e.clientY);
    const mode = store.view.mode;
    const opts = { snap: e.shiftKey ? SNAP_DEGREES : 0 };

    store.update((d) => {
      const bone = boneById(d, drag.id);
      if (!bone) return;

      if (drag.handle === 'root') {
        // per-axis: a locked x with a free y still slides up and down
        const to = worldToOffset(d, bone, world, mode);
        bone.offset = {
          x: isLocked(bone, 'offsetX') ? bone.offset.x : to.x,
          y: isLocked(bone, 'offsetY') ? bone.offset.y : to.y,
        };
        return;
      }

      const next = aimAt(d, bone, world, mode, opts);
      if (!editsRest(mode)) {
        bone.poseAngle = next.poseAngle;   // posing is never locked
        return;
      }
      if (!isLocked(bone, 'restAngle')) bone.restAngle = next.restAngle;
      // a zero-length bone is rotated, never stretched -- dragging its tick
      // must not silently give it an extent
      if (drag.handle === 'tip' && !isLocked(bone, 'length')) bone.length = next.length;
    }, { coalesce: drag.gesture });
  });

  const end = (e) => {
    if (svg.hasPointerCapture?.(e.pointerId)) svg.releasePointerCapture(e.pointerId);

    // commit an anchor drag as ONE document change: the art re-places once, and
    // the whole gesture becomes a single undo entry
    const pending = store.view.anchorDrag;
    if (drag?.handle === 'anchor' && pending) {
      store.update((d) => {
        const a = anchorNamed(artById(d, pending.art) ?? {}, pending.anchor);
        if (!a) return;
        a.x = pending.x;
        a.y = pending.y;
      });
    }
    if (pending) store.setView((v) => { v.anchorDrag = null; });

    drag = null;
    pan = null;
    store.endGesture();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = canvas.toWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    store.setView((v) => { v.zoom = Math.min(20, Math.max(0.05, v.zoom * factor)); });
    const after = canvas.toWorld(e.clientX, e.clientY);
    store.setView((v) => {
      v.pan.x += before.x - after.x;
      v.pan.y += before.y - after.y;
    });
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '')) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }

    // backtick, not tab -- tab has to keep cycling form fields
    if (e.key === '`') {
      e.preventDefault();
      const order = ['rest', 'solve', 'pose', 'anim'];
      store.setView((v) => {
        v.mode = order[(order.indexOf(v.mode) + 1) % order.length];
      });
      return;
    }

    if (e.key === ' ' && store.view.mode === 'anim') {
      e.preventDefault();   // otherwise space scrolls the page
      store.setView((v) => { v.playing = !v.playing; });
      return;
    }

    // step the playhead. shift jumps by 5, which lands on the ruler's ticks.
    if (store.view.mode === 'anim' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1);
      store.setView((v) => {
        v.playing = false;
        v.frame = Math.max(0, Math.round(v.frame ?? 0) + step);
      });
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      store.update((d) => {
        if (d.selection?.kind === 'art') {
          d.art = d.art.filter((a) => a.id !== d.selection.id);
          d.selection = null;
          return;
        }
        if (d.selection?.kind === 'anim') {
          d.animations = (d.animations ?? []).filter((a) => a.id !== d.selection.id);
          d.selection = null;
          return;
        }
        // start and end poses are what the type promises, so they are not
        // removable -- change the type or the length instead
        if (d.selection?.kind === 'keyframe') {
          const a = (d.animations ?? []).find((x) => x.id === d.selection.animId);
          const f = d.selection.frame;
          if (!a || f === 0 || (needsEndFrame(a.type) && f === a.length - 1)) return;
          a.keyframes = a.keyframes.filter((k) => k.frame !== f);
          d.selection = { kind: 'anim', id: a.id };
          return;
        }
        if (!d.selection) return;
        const dead = subtree(d, d.selection.id);
        d.bones = d.bones.filter((b) => !dead.has(b.id));
        // art bound to a deleted bone falls back to world rather than vanishing
        for (const a of d.art ?? []) if (dead.has(a.ref?.bone)) a.ref = null;
        d.selection = null;
      });
      return;
    }

    if (e.key === '[' || e.key === ']') {
      const step = (e.key === '[' ? -1 : 1) * (e.shiftKey ? 10 : 1);
      const rest = editsRest(store.view.mode);
      store.update((d) => {
        if (d.selection?.kind !== 'bone') return;
        const b = boneById(d, d.selection.id);
        if (!b) return;
        if (!rest) { b.poseAngle = wrapDeg(b.poseAngle + step); return; }
        if (!isLocked(b, 'restAngle')) b.restAngle = wrapDeg(b.restAngle + step);
      });
    }
  });
}
