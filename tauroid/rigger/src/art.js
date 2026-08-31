// art in scene.
//
// an art item is a piece of svg placed on a bone. items are independent: each
// owns its own copy of the markup, so dropping the same file in twice gives
// two items that share nothing. there is no asset library and no "uploaded but
// unused" state -- if it is in the list, it is in the scene.
//
// the list's ORDER is the z-order, top of the list nearest the viewer, the way
// a layers panel reads. rendering walks it in reverse so index 0 paints last.
//
// ANCHORS ARE JUST NAMED POINTS. the file carries a name and a position and
// nothing else -- no roles, no reserved names, no convention the tool enforces.
// which anchor acts as the origin and which gives the direction is chosen on
// the BINDING, at the time art is attached to a bone. so the same file can bind
// one way here and the other way there, and any anchor can serve as origin,
// direction, grip or nothing at all depending on who is asking.

import { v2, angleOf, sub, rotate } from './math.js';

export const ANCHOR_GROUP = 'rig-anchors';

export const makeArt = (id, name, filename, svg, anchors = []) => ({
  id,
  name,
  filename,
  svg,                     // inline copy, for preview and re-export
  anchors,                 // [{ name, x, y }] in the art's own coordinates
  bone: null,              // bound bone id, or null to pin to world
  origin: null,            // anchor NAME that sits on the bone root
  direction: null,         // anchor NAME that the bone direction points at
  offset: { x: 0, y: 0 },  // manual nudge, in the bone's frame
  angle: 0,                // manual nudge, on top of any anchor alignment
  scale: 1,                // uniform display scale; see artTransform
  // the file's own viewBox mapping, captured at import. stored rather than
  // re-derived so placement stays computable without a DOM -- bones can now
  // hang off art anchors, and frame resolution must not depend on parsing.
  viewport: { scale: 1, minX: 0, minY: 0 },
  visible: true,
});

export const artById = (doc, id) => doc.art?.find((a) => a.id === id) ?? null;
export const anchorNamed = (item, name) =>
  item.anchors?.find((a) => a.name === name) ?? null;

// Parse markup into a detached <svg>, with anything executable removed.
//
// These are the user's own files, but a tool that ingests files should not also
// run whatever they contain -- stripping costs nothing.
export function parseArt(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return { error: 'not parseable as SVG' };

  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') return { error: 'no <svg> root element' };

  for (const el of root.querySelectorAll('script')) el.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on')
        || (n === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:'))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return { root };
}

// The region an <svg> clips itself to. Hoisting its children into a <g> drops
// that clip, so content drawn outside the viewBox -- which a browser would
// never show -- starts bleeding over neighbouring art at this item's z. We
// have to reinstate it by hand.
export function clipRect(root) {
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n)) && vb[2] > 0 && vb[3] > 0) {
    return { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
  }
  const w = parseFloat(root.getAttribute('width'));
  const h = parseFloat(root.getAttribute('height'));
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { x: 0, y: 0, width: w, height: h };
  }
  return null;   // no declared extent -- nothing to clip to
}

// Rewrite every id in a fragment so two copies of one file cannot collide.
//
// url(#grad) resolves to the FIRST matching id in the document, so without
// this the second copy of a file silently borrows the first's gradients,
// clipPaths and filters -- which reads as z-order weirdness because the
// borrowed clip is positioned for the other item.
export function namespaceIds(root, prefix) {
  const map = new Map();
  for (const el of root.querySelectorAll('[id]')) {
    const old = el.getAttribute('id');
    const next = `${prefix}__${old}`;
    map.set(old, next);
    el.setAttribute('id', next);
  }

  const rewrite = (value) => value.replace(
    /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g,
    (whole, q, id) => (map.has(id) ? `url(${q}#${map.get(id)}${q})` : whole),
  );

  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (attr.name === 'id') continue;
      if (attr.value.includes('url(')) {
        el.setAttribute(attr.name, rewrite(attr.value));
        continue;
      }
      // href/xlink:href on <use>, gradient inheritance, etc.
      if (/^(xlink:)?href$/.test(attr.name) && attr.value.startsWith('#')) {
        const id = attr.value.slice(1);
        if (map.has(id)) el.setAttribute(attr.name, `#${map.get(id)}`);
      }
    }
  }
  return { map, rewrite };
}

// Confine a fragment's <style> rules to that fragment.
//
// CSS inside an inlined <svg> is DOCUMENT-scoped, not element-scoped. Editors
// export generic class names -- Illustrator emits .st0, .st1, ... for every
// file -- so several pieces of art in one document all define the same
// selectors and the LAST one in document order wins for all of them. Since z
// order is document order, reordering art silently recolours other pieces.
//
// Prefixing every selector with a per-item scope class makes each file's rules
// apply only to its own content.
export function scopeStyles(root, scopeClass, rewriteUrls) {
  for (const style of root.querySelectorAll('style')) {
    const scoped = style.textContent.replace(
      /([^{}]+)\{([^{}]*)\}/g,
      (whole, selectors, body) => {
        const sel = selectors.trim();
        if (!sel || sel.startsWith('@')) return whole;   // at-rules left alone
        const prefixed = sel.split(',')
          .map((one) => `.${scopeClass} ${one.trim()}`)
          .join(', ');
        return `${prefixed}{${rewriteUrls ? rewriteUrls(body) : body}}`;
      },
    );
    style.textContent = scoped;
  }
}

// An svg's own coordinate system: viewBox maps onto width/height. Ignoring it
// would place art at raw user units, which is only correct at 1:1.
export function viewportTransform(root) {
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) {
    return { scale: 1, minX: 0, minY: 0 };
  }

  const [minX, minY, vbW, vbH] = vb;
  const w = parseFloat(root.getAttribute('width'));
  const h = parseFloat(root.getAttribute('height'));
  // uniform scale only -- preserveAspectRatio's default is 'meet'
  const scale = Number.isFinite(w) && Number.isFinite(h) && vbW > 0 && vbH > 0
    ? Math.min(w / vbW, h / vbH)
    : 1;
  return { scale, minX, minY };
}

// Read anchors out of the file. Position is the element's centre in the art's
// own coordinates; the name is whatever the artist called it, minus nothing.
export function readAnchors(root) {
  const group = root.querySelector(`#${ANCHOR_GROUP}`);
  if (!group) return [];

  const out = [];
  for (const el of group.children) {
    const name = el.getAttribute('id');
    if (!name) continue;
    const cx = parseFloat(el.getAttribute('cx'));
    const cy = parseFloat(el.getAttribute('cy'));
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      out.push({ name, x: cx, y: cy });
      continue;
    }
    const x = parseFloat(el.getAttribute('x'));
    const y = parseFloat(el.getAttribute('y'));
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ name, x, y });
  }
  return out;
}

// Rewrite the anchor group and hand back the markup.
//
// We own `#rig-anchors` wholesale and touch nothing else, so a file that has
// been through the tool can go through it again unchanged.
export function writeAnchors(svgText, anchors) {
  const { root, error } = parseArt(svgText);
  if (error) return { error };

  const doc = root.ownerDocument;
  const NS = 'http://www.w3.org/2000/svg';
  root.querySelector(`#${ANCHOR_GROUP}`)?.remove();

  if (anchors.length) {
    const g = doc.createElementNS(NS, 'g');
    g.setAttribute('id', ANCHOR_GROUP);
    for (const a of anchors) {
      const c = doc.createElementNS(NS, 'circle');
      c.setAttribute('id', a.name);
      c.setAttribute('cx', String(a.x));
      c.setAttribute('cy', String(a.y));
      c.setAttribute('r', '1.5');
      c.setAttribute('fill', 'none');
      g.append(c);
    }
    root.append(g);
  }

  return { svg: new XMLSerializer().serializeToString(root) };
}

// The art's own internal rotation, from whichever anchors this binding picked.
// Cancelling it is what makes the art point the way its bone points.
export function artDirection(item) {
  const o = item.origin ? anchorNamed(item, item.origin) : null;
  const d = item.direction ? anchorNamed(item, item.direction) : null;
  return o && d ? angleOf(sub(v2(d.x, d.y), v2(o.x, o.y))) : 0;
}

// World placement for an art item.
//
// bone frame, then the manual nudge, then cancel the art's own direction, then
// bring the chosen origin anchor to the bone's root.
//
// `item.scale` is a display multiplier and nothing more: it is not derived
// from anything and drives nothing. Anchors stay stored in the IMAGE's own
// coordinates -- dragging maps back through this whole matrix, so the scale
// cancels out and never leaks into the values written back to the file.
export function artTransform(item, frame, viewport = { scale: 1, minX: 0, minY: 0 }) {
  const f = frame ?? { pos: { x: 0, y: 0 }, angle: 0 };
  const o = item.origin ? anchorNamed(item, item.origin) : null;
  const spin = item.angle - artDirection(item);

  const minX = viewport.minX ?? 0;
  const minY = viewport.minY ?? 0;
  const s = (viewport.scale ?? 1) * (Number.isFinite(item.scale) ? item.scale : 1);

  const parts = [
    `translate(${f.pos.x} ${f.pos.y})`,
    `rotate(${f.angle})`,
    `translate(${item.offset.x} ${item.offset.y})`,
    `rotate(${spin})`,
  ];
  // the origin shift happens in SCALED space -- a native-coordinate shift
  // would be wrong for any scale but 1, and for any viewBox whose min is not 0
  if (o) parts.push(`translate(${-s * (o.x - minX)} ${-s * (o.y - minY)})`);
  parts.push(`scale(${s})`, `translate(${-minX} ${-minY})`);
  return parts.join(' ');
}


// Numeric twin of artTransform: where does one anchor actually land?
//
// artTransform builds the same chain as an SVG transform string for rendering;
// this evaluates it for a single point, so the frame resolver can place a bone
// on an art anchor without touching the DOM. Keep the two in step.
export function anchorWorld(item, boneFrame, anchorName) {
  const a = anchorNamed(item, anchorName);
  if (!a) return null;

  const f = boneFrame ?? { pos: v2(0, 0), angle: 0 };
  const vp = item.viewport ?? { scale: 1, minX: 0, minY: 0 };
  const s = (vp.scale ?? 1) * (Number.isFinite(item.scale) ? item.scale : 1);
  const minX = vp.minX ?? 0;
  const minY = vp.minY ?? 0;
  const spin = item.angle - artDirection(item);
  const o = item.origin ? anchorNamed(item, item.origin) : null;

  let q = v2((a.x - minX) * s, (a.y - minY) * s);
  if (o) q = v2(q.x - s * (o.x - minX), q.y - s * (o.y - minY));
  q = rotate(q, spin);
  q = v2(q.x + item.offset.x, q.y + item.offset.y);
  q = rotate(q, f.angle);

  return {
    // An anchor is a point, so it has no direction of its own -- it inherits
    // the art's, which is what makes a bone on a weapon's grip turn with the
    // weapon.
    //
    // That direction is the one the ORIGIN->DIRECTION anchors define, which in
    // world terms is the host frame plus `item.angle` -- the angle you asked
    // the art to point at. Returning `spin` instead reported the art's
    // correction rather than its facing, so art whose anchors ran at 30 degrees
    // in its own coordinates handed every anchor an angle 30 degrees out.
    //
    // No special case is needed for a missing or coincident direction anchor:
    // artDirection is 0 there, so spin collapses to item.angle and the two
    // agree anyway.
    pos: v2(q.x + f.pos.x, q.y + f.pos.y),
    angle: f.angle + item.angle,
  };
}
