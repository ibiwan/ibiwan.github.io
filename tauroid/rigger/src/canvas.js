// svg viewport. svg rather than <canvas> on purpose: hit-testing comes free
// from pointer events on real elements, it stays crisp at any zoom, and it is
// the substrate the artist's svg chunks will drop into later.
//
// two skeletons are drawn every frame: the rest pose as a dark ghost and the
// posed result bright on top. with no deltas they coincide exactly, so the
// ghost costs nothing until you actually pose something.
//
// filled disc  = a bone's ROOT: an explicit frame, selectable and draggable.
// hollow disc  = a bone's TIP: an implicit anchor, derived from the length.

import {
  resolveFrames, frameOpts, boneKey, artAnchorKey, refKey, isPoint, constraintProblem,
} from './skeleton.js';
import { poseAt } from './animation.js';
import {
  parseArt, artTransform, viewportTransform, clipRect, namespaceIds, scopeStyles,
} from './art.js';
import { v2 } from './math.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

export function createCanvas(svg, store) {
  const layers = {
    grid: el('g', { class: 'layer-grid' }),
    art: el('g', { class: 'layer-art' }),
    rest: el('g', { class: 'layer-rest' }),
    pose: el('g', { class: 'layer-pose' }),
    handles: el('g', { class: 'layer-handles' }),
  };
  for (const g of Object.values(layers)) svg.append(g);

  function toWorld(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const m = svg.getScreenCTM();
    if (!m) return v2(0, 0);
    const p = pt.matrixTransform(m.inverse());
    return v2(p.x, p.y);
  }

  const measure = () => {
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };

  const worldPerPixel = () => {
    const m = svg.getScreenCTM();
    return m ? 1 / m.a : 1;
  };

  const applyView = (view, r) => svg.setAttribute('viewBox',
    `${view.pan.x} ${view.pan.y} ${r.width / view.zoom} ${r.height / view.zoom}`);

  function drawGrid(view, r) {
    layers.grid.replaceChildren();
    const w = r.width / view.zoom, h = r.height / view.zoom;
    const step = 50;
    for (let x = Math.floor(view.pan.x / step) * step; x < view.pan.x + w; x += step) {
      layers.grid.append(el('line', {
        x1: x, y1: view.pan.y, x2: x, y2: view.pan.y + h,
        class: x === 0 ? 'grid-axis' : 'grid-line',
      }));
    }
    for (let y = Math.floor(view.pan.y / step) * step; y < view.pan.y + h; y += step) {
      layers.grid.append(el('line', {
        x1: view.pan.x, y1: y, x2: view.pan.x + w, y2: y,
        class: y === 0 ? 'grid-axis' : 'grid-line',
      }));
    }
  }

  const along = (f, px) => v2(
    f.pos.x + Math.cos(f.angle * Math.PI / 180) * px,
    f.pos.y + Math.sin(f.angle * Math.PI / 180) * px,
  );

  // screen-pixel width of a bone's invisible hit line
  const BONE_HIT = 14;

  function drawSkeleton(doc, layer, frames, kind, s, interactive) {
    for (const b of doc.bones) {
      const root = frames.get(boneKey(b.id, 'root'));
      const tip = frames.get(boneKey(b.id, 'tip'));
      if (!root || !tip) continue;

      const sel = doc.selection?.kind === 'bone' && doc.selection.id === b.id;
      const attrs = { class: `bone ${kind}${sel ? ' selected' : ''}` };

      const zero = isPoint(b);
      const end = zero ? along(root, 14 * s) : tip.pos;
      const line = { x1: root.pos.x, y1: root.pos.y, x2: end.x, y2: end.y };

      // A 3px stroke is a 3px target, which is a hard thing to hit and easy to
      // miss into a joint. So the visible line is decoration and an invisible
      // fatter line underneath does the hit-testing -- the same split the
      // rotate grip already uses. It goes in FIRST so the joint and tip discs,
      // drawn later in the handles layer, still win near the ends.
      if (interactive) {
        layer.append(el('line', {
          ...line, class: 'bone-hit', 'stroke-width': BONE_HIT * s,
          'data-id': b.id, 'data-handle': 'bone',
        }));
      }

      layer.append(el('line', {
        ...line, ...attrs, class: `${attrs.class}${zero ? ' zero-len' : ''}`,
      }));
    }
  }

  // parsed art is cached by item id + markup, so re-rendering every frame does
  // not re-run DOMParser on every chunk in the scene
  const artCache = new Map();

  function artNode(item) {
    const hit = artCache.get(item.id);
    if (hit && hit.svg === item.svg) return hit;

    const { root, error } = parseArt(item.svg ?? '');
    if (error) {
      const miss = { svg: item.svg, node: null, viewport: null };
      artCache.set(item.id, miss);
      return miss;
    }

    // the anchor group is editing metadata, not artwork
    root.querySelector('#rig-anchors')?.remove();
    // two copies of one file must not share gradient/clipPath ids, and one
    // file's <style> rules must not restyle another's artwork
    const { rewrite } = namespaceIds(root, item.id);
    scopeStyles(root, `artscope-${item.id}`, rewrite);

    // drop the outer <svg> so the content lives in the scene's tree, but carry
    // its viewBox mapping across -- ignoring it would place art at raw user
    // units, which is only correct at 1:1
    const g = el('g');
    for (const child of [...root.childNodes]) g.append(child.cloneNode(true));

    const parsed = viewportTransform(root);
    // rigs from before bones could sit on art have no stored viewport; capture
    // it once so placement stops depending on this parse
    const stored = item.viewport;
    if (!stored || stored.scale !== parsed.scale
      || stored.minX !== parsed.minX || stored.minY !== parsed.minY) {
      queueMicrotask(() => store.update((d) => {
        const live = (d.art ?? []).find((a) => a.id === item.id);
        if (live) live.viewport = parsed;
      }));
    }

    const entry = {
      svg: item.svg,
      node: g,
      viewport: parsed,
      clip: clipRect(root),
      scope: `artscope-${item.id}`,
    };
    artCache.set(item.id, entry);
    return entry;
  }

  // the <g> each art item was last drawn into, so anchor dragging can invert
  // the exact transform the browser used rather than recomputing it
  const artWrappers = new Map();

  function drawArt(doc, frames, s) {
    artWrappers.clear();
    let selectedArt = null;
    // index 0 is nearest the viewer, so paint the list back to front
    for (const item of [...(doc.art ?? [])].reverse()) {
      if (!item.visible) continue;
      const { node, viewport, clip, scope } = artNode(item);
      if (!node) continue;

      const frame = frames.get(refKey(item.ref)) ?? null;
      const selected = doc.selection?.kind === 'art' && doc.selection.id === item.id;
      const wrap = el('g', {
        transform: artTransform(item, frame, viewport),
        class: selected ? 'art-item selected' : 'art-item',
      });
      const content = node.cloneNode(true);
      // the anchor the scoped css hangs off
      if (scope) content.setAttribute('class', scope);
      // reinstate the clip the outer <svg> used to provide. without it, art
      // drawn beyond its own viewBox spills over other items at this item's z.
      if (clip) {
        const id = `artclip-${item.id}`;
        const cp = el('clipPath', { id, clipPathUnits: 'userSpaceOnUse' });
        cp.append(el('rect', { x: clip.x, y: clip.y, width: clip.width, height: clip.height }));
        content.prepend(cp);
        content.setAttribute('clip-path', `url(#${id})`);
      }
      wrap.append(content);
      layers.art.append(wrap);
      artWrappers.set(item.id, wrap);

      // anchors are only visible and draggable while their own art is
      // highlighted -- otherwise every chunk in the scene competes for clicks.
      //
      // they are drawn in SCENE space rather than inside the art transform:
      // handles inside it scale with zoom and their labels rotate with the
      // artwork. positions come from the wrapper’s own matrix, so they still
      // track the art exactly.
      if (selected) selectedArt = { item, wrap };
    }
    return selectedArt;
  }

  // art coords -> scene coords, via the matrix the wrapper was rendered with
  function drawAnchors(selectedArt, s) {
    if (!selectedArt) return;
    const { item, wrap } = selectedArt;

    // getCTM() maps to the VIEWPORT, which is post-viewBox pixels, not scene
    // units. composing against the handles layer -- whose user space is the
    // scene -- gives the art -> scene matrix we actually want.
    const wrapCtm = wrap.getCTM();
    const sceneCtm = layers.handles.getCTM();
    if (!wrapCtm || !sceneCtm) return;
    const ctm = sceneCtm.inverse().multiply(wrapCtm);

    const dragging = store.view.anchorDrag;
    for (const a of item.anchors ?? []) {
      // a drag in progress is held in VIEW state, so the binding -- and
      // therefore the art's placement -- does not move until it commits
      const live = dragging && dragging.art === item.id && dragging.anchor === a.name
        ? dragging : a;

      const pt = svg.createSVGPoint();
      pt.x = live.x;
      pt.y = live.y;
      const p = pt.matrixTransform(ctm);

      const roles = [
        item.origin === a.name ? 'origin' : null,
        item.direction === a.name ? 'direction' : null,
      ].filter(Boolean);

      const g = el('g', {
        class: `art-anchor${roles.length ? ' bound' : ''}`,
        'data-art': item.id, 'data-anchor': a.name, 'data-handle': 'anchor',
      });
      g.append(el('circle', { cx: p.x, cy: p.y, r: 4.5 * s, class: 'art-anchor-dot' }));
      g.append(el('circle', { cx: p.x, cy: p.y, r: 11 * s, class: 'art-anchor-hit' }));
      const label = el('text', {
        x: p.x + 8 * s, y: p.y - 8 * s,
        class: 'art-anchor-label', style: `font-size:${11 * s}px`,
      });
      label.textContent = roles.length ? `${a.name} \u00b7 ${roles.join(' + ')}` : a.name;
      g.append(label);
      layers.handles.append(g);
    }
  }

  // A mapper from client points into an art item's own coordinate space.
  //
  // Held for the duration of a gesture. The art cannot move mid-drag anyway --
  // anchor drags live in view state and only commit on release -- but pinning
  // the matrix makes that independent of render timing.
  function artSpaceMapper(artId) {
    const wrap = artWrappers.get(artId);
    const m = wrap?.getScreenCTM();
    if (!m) return null;
    const inverse = m.inverse();
    return (clientX, clientY) => {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const p = pt.matrixTransform(inverse);
      return v2(p.x, p.y);
    };
  }

  let framed = false;

  function render(doc, view) {
    const r = measure();
    if (!r) return;   // pre-layout; the ResizeObserver will call us back

    if (!framed) {
      framed = true;
      fitToContent();
      return;         // setView re-enters render with the corrected view
    }

    applyView(view, r);
    drawGrid(view, r);

    const s = worldPerPixel();
    // in anim mode the playhead drives the pose: every active lane sampled at
    // the same frame, added together, layered on top of the pose deltas
    const deltas = view.mode === 'anim' ? poseAt(doc, view.frame ?? 0) : null;
    // the dim layer is always the RAW bind pose, so every mode shows how far
    // the live skeleton has been moved from it -- including by ik alone
    const rest = resolveFrames(doc, { posed: false, constraints: false }).frames;
    const posed = resolveFrames(doc, frameOpts(view.mode, deltas)).frames;
    const editingRest = view.mode === 'rest';

    layers.art.replaceChildren();
    layers.rest.replaceChildren();
    layers.pose.replaceChildren();
    layers.handles.replaceChildren();

    // art follows whichever skeleton is being edited, same as the handles
    const active = editingRest ? rest : posed;

    const selectedArt = drawArt(doc, active, s);
    drawSkeleton(doc, layers.rest, rest, 'rest', s, editingRest);
    drawSkeleton(doc, layers.pose, posed, 'pose', s, !editingRest);

    // the selected bone's handles go last so they are topmost -- otherwise a
    // neighbouring bone's root disc sits over the tip you are trying to grab
    // and steals the drag
    const selId = doc.selection?.kind === 'bone' ? doc.selection.id : null;
    const order = [
      ...doc.bones.filter((b) => b.id !== selId),
      ...doc.bones.filter((b) => b.id === selId),
    ];

    for (const b of order) {
      const root = active.get(boneKey(b.id, 'root'));
      const tip = active.get(boneKey(b.id, 'tip'));
      if (!root) continue;
      const sel = doc.selection?.kind === 'bone' && doc.selection.id === b.id;

      // explicit frame
      layers.handles.append(el('circle', {
        cx: root.pos.x, cy: root.pos.y, r: 5 * s,
        class: `joint${sel ? ' selected' : ''}`,
        'data-id': b.id, 'data-handle': 'root',
      }));

      if (!isPoint(b)) {
        // implicit anchor, derived from the length
        layers.handles.append(el('circle', {
          cx: tip.pos.x, cy: tip.pos.y, r: 4.5 * s,
          class: 'bone-tip', 'data-id': b.id, 'data-handle': 'tip',
        }));
      } else {
        // a zero-length bone has no tip to grab, so its direction tick is the
        // rotation handle. the whole stalk is grabbable, not just the dot.
        const t = along(root, 20 * s);
        const grab = { 'data-id': b.id, 'data-handle': 'rotate' };
        layers.handles.append(el('line', {
          x1: root.pos.x, y1: root.pos.y, x2: t.x, y2: t.y, class: 'anchor-tick',
        }));
        layers.handles.append(el('line', {
          x1: root.pos.x, y1: root.pos.y, x2: t.x, y2: t.y,
          class: 'rotate-hit', 'stroke-width': 14 * s, ...grab,
        }));
        layers.handles.append(el('circle', {
          cx: t.x, cy: t.y, r: 11 * s, class: 'rotate-hit', ...grab,
        }));
        layers.handles.append(el('circle', {
          cx: t.x, cy: t.y, r: 5.5 * s, class: 'rotate-handle', ...grab,
        }));
      }

      if (sel) {
        const label = el('text', {
          x: root.pos.x + 9 * s, y: root.pos.y - 9 * s,
          class: 'bone-label', style: `font-size:${12 * s}px`,
        });
        label.textContent = b.name;
        layers.handles.append(label);
      }
    }

    // a dashed leader from each constrained bone to its target, so it is
    // visible which bone is chasing what without opening the inspector
    for (const b of doc.bones) {
      if (!b.constraint?.target) continue;
      const from = active.get(boneKey(b.id, 'tip'));
      const to = active.get(refKey(b.constraint.target));
      if (!from || !to) continue;
      const broken = !!constraintProblem(doc, b);
      layers.handles.append(el('line', {
        x1: from.pos.x, y1: from.pos.y, x2: to.pos.x, y2: to.pos.y,
        class: `ik-link${broken ? ' broken' : ''}`,
        'stroke-dasharray': `${4 * s} ${4 * s}`,
      }));
      layers.handles.append(el('circle', {
        cx: to.pos.x, cy: to.pos.y, r: 7 * s,
        class: `ik-target${broken ? ' broken' : ''}`,
      }));
    }

    // last, so anchor handles sit above every bone handle -- while an art item
    // is selected, its anchors are what you are aiming at
    drawAnchors(selectedArt, s);
  }

  // frame the skeleton, or centre on the origin when there is nothing to frame
  function fitToContent() {
    const r = measure();
    if (!r) return;

    const { frames } = resolveFrames(store.doc, { posed: true });
    const pts = [...frames.values()].map((f) => f.pos);

    if (!pts.length) {
      store.setView((v) => {
        v.zoom = 1;
        v.pan = { x: -r.width / 2, y: -r.height / 2 };
      });
      return;
    }

    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const pad = 60;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const zoom = Math.min(8, Math.max(0.05, Math.min(
      r.width / Math.max(1, maxX - minX),
      r.height / Math.max(1, maxY - minY),
    )));

    store.setView((v) => {
      v.zoom = zoom;
      v.pan = {
        x: (minX + maxX) / 2 - r.width / (2 * zoom),
        y: (minY + maxY) / 2 - r.height / (2 * zoom),
      };
    });
  }

  store.subscribe(render);
  new ResizeObserver(() => render(store.doc, store.view)).observe(svg);

  return { toWorld, artSpaceMapper, worldPerPixel, render, fitToContent };
}
