// hierarchy tree + inspector. both are plain store subscribers, so neither
// knows the other exists.

import {
  boneById, childrenOf, makeBone, resolveFrames, boneKey, wouldCycle, hasExtent,
  makeConstraint, constraintProblem, dependsOn, dependsOnArt, editsRest, frameOpts,
  isLocked,
} from './skeleton.js';
import { artById, anchorNamed } from './art.js';
import { fmt, wrapDeg } from './math.js';
import {
  makeDelta, animById, needsEndFrame, setLength, ensureEndpoints, poseAt,
} from './animation.js';

const selBone = (doc, id) => doc.selection?.kind === 'bone' && doc.selection.id === id;
const selArt = (doc, id) => doc.selection?.kind === 'art' && doc.selection.id === id;
const selAnim = (doc, id) => doc.selection?.kind === 'anim' && doc.selection.id === id;

export function createHierarchy(root, store, { onRename } = {}) {
  function render(doc) {
    root.replaceChildren();

    const emit = (bone, depth, seen) => {
      if (seen.has(bone.id)) return;
      seen.add(bone.id);

      const row = document.createElement('button');
      row.className = 'tree-row' + (selBone(doc, bone.id) ? ' selected' : '');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.textContent = bone.name;

      // descriptive, not a type: length is a property every bone has
      if (!hasExtent(bone)) row.append(Object.assign(document.createElement('span'),
        { className: 'badge', textContent: '0 len' }));
      if (bone.ref?.art) row.append(Object.assign(document.createElement('span'),
        { className: 'badge', textContent: `▸ ${bone.ref.anchor}` }));

      const select = () => store.update((d) => { d.selection = { kind: 'bone', id: bone.id }; });
      row.onclick = select;
      row.ondblclick = () => { select(); onRename?.(); };
      root.append(row);

      for (const c of childrenOf(doc, bone.id)) emit(c, depth + 1, seen);
    };

    const seen = new Set();
    const rooted = (b) => b.ref?.bone != null
      || (b.ref?.art != null && (doc.art ?? []).some((a) => a.id === b.ref.art && a.ref?.bone != null));
    for (const b of doc.bones.filter((b) => !rooted(b))) emit(b, 0, seen);
    for (const b of doc.bones) emit(b, 0, seen);   // orphans stay visible

    if (!doc.bones.length) {
      root.append(Object.assign(document.createElement('p'), {
        className: 'empty', textContent: 'Nothing yet. Add root to begin.',
      }));
    }
  }
  store.subscribe(render);
}

export function createInspector(root, store, { onDownload } = {}) {
  function field(label, value, onCommit, opts = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(Object.assign(document.createElement('span'), { textContent: label }));
    const input = document.createElement('input');
    input.type = opts.type ?? 'number';
    input.step = opts.step ?? '1';
    // the same label appears once per bone in a keyframe, so the patch key is
    // overridable rather than being the visible text
    input.dataset.field = opts.key ?? label;
    if (opts.min != null) input.min = opts.min;
    if (opts.disabled) input.disabled = true;
    input.value = value;
    // commit on change, not input, so partially-typed numbers don't thrash
    input.onchange = () => onCommit(input.type === 'number' ? Number(input.value) : input.value);

    // An optional padlock. This is axis-snapping for the drag, not write
    // protection: a hand cannot move in a perfect orthogonal line or a perfect
    // arc, so holding x turns a sloppy drag into an exact vertical one. It does
    // NOT stop the solver or posing, which never write here anyway.
    if (opts.lock) {
      const pad = document.createElement('input');
      pad.type = 'checkbox';
      pad.className = 'lock';
      pad.checked = !!opts.lock.locked;
      pad.title = opts.lock.locked
        ? 'held — drags leave this alone, so you can move the others cleanly'
        : 'hold this value while dragging the others';
      pad.onchange = () => opts.lock.onToggle(pad.checked);
      if (opts.lock.locked) input.disabled = true;
      wrap.append(pad);
    }

    wrap.append(input);
    return wrap;
  }

  // Bone root, bone tip and art anchor are one union, so anything that points
  // somewhere -- a parent, an ik target -- offers the same list.
  function refOptions(doc, { skipBone = null, exclude = () => false } = {}) {
    const opts = [];
    for (const b of doc.bones) {
      if (b.id === skipBone || exclude({ bone: b.id })) continue;
      // tip is the implicit anchor -- it tracks that bone's length.
      // root is an explicit frame -- it doesn't, which is how you branch.
      opts.push({ label: `${b.name} · tip`, value: `${b.id}:tip`, ref: { bone: b.id, end: 'tip' } });
      opts.push({ label: `${b.name} · root`, value: `${b.id}:root`, ref: { bone: b.id, end: 'root' } });
    }
    for (const item of doc.art ?? []) {
      for (const a of item.anchors ?? []) {
        if (exclude({ art: item.id, anchor: a.name })) continue;
        opts.push({
          label: `${item.name} ▸ ${a.name}`,
          value: `art:${item.id}:${a.name}`,
          ref: { art: item.id, anchor: a.name },
        });
      }
    }
    return opts;
  }

  const refValue = (ref) => (ref?.art != null
    ? `art:${ref.art}:${ref.anchor}`
    : (ref?.bone != null ? `${ref.bone}:${ref.end ?? 'root'}` : ''));

  function refPicker(doc, bone, onPick) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(Object.assign(document.createElement('span'), { textContent: 'attached to' }));
    const sel = document.createElement('select');

    const opts = [{ label: '(world origin)', value: '', ref: null },
      ...refOptions(doc, { skipBone: bone.id })];
    const current = refValue(bone.ref);
    for (const o of opts) {
      const opt = new Option(o.label, o.value, false, o.value === current);
      opt.disabled = wouldCycle(doc, bone.id, o.ref);
      sel.append(opt);
    }
    sel.onchange = () => onPick(opts.find((o) => o.value === sel.value)?.ref ?? null);
    wrap.append(sel);
    return wrap;
  }

  // rebuilding the panel on every store change destroys whatever input has
  // focus, so holding an arrow key steps the value once and then defocuses.
  // instead: rebuild only when the panel's SHAPE changes and otherwise patch
  // values in place, skipping whichever input the user is typing into.
  let shapeKey = null;

  // The key must cover everything that changes WHICH CONTROLS EXIST, not just
  // which entity is selected -- otherwise the in-place value patch runs when a
  // rebuild was needed and the new controls never appear. Adding an ik target
  // row or an anchor row both do this.
  function shapeOf(doc, view) {
    const sel = doc.selection;
    if (!sel) return 'empty';

    if (sel.kind === 'keyframe') {
      const anim = animById(doc, sel.animId);
      const kf = anim?.keyframes.find((k) => k.frame === sel.frame);
      return `kf|${sel.animId}|${sel.frame}|${kf?.turn}|`
        + `${Object.keys(kf?.deltas ?? {}).length}|${doc.bones.length}`;
    }
    if (sel.kind === 'anim') {
      const anim = animById(doc, sel.id);
      return `anim|${sel.id}|${anim?.type}|${anim?.length}|${anim?.keyframes.length}`;
    }

    const parts = [sel.kind, sel.id, view.mode, doc.bones.length, (doc.art ?? []).length];
    if (sel.kind === 'bone') {
      const b = boneById(doc, sel.id);
      parts.push(['offsetX', 'offsetY', 'restAngle', 'length']
        .map((f) => (isLocked(b, f) ? '1' : '0')).join(''));
      const c = boneById(doc, sel.id)?.constraint;
      parts.push(c?.kind ?? '-');
      if (c?.kind === 'match') {
        parts.push(`${!!c.take?.x}${!!c.take?.y}${!!c.take?.theta}`, c.space ?? 'local');
      }
    } else {
      const item = artById(doc, sel.id);
      parts.push((item?.anchors ?? []).length);
      parts.push(refValue(item?.ref));
    }
    return parts.join('|');
  }

  function valuesOf(bone) {
    return {
      name: bone.name,
      'offset x': fmt(bone.offset.x),
      'offset y': fmt(bone.offset.y),
      'rest angle': fmt(bone.restAngle),
      'pose delta': fmt(bone.poseAngle),
      length: fmt(bone.length),
    };
  }

  function patchValues(doc, view) {
    if (doc.selection?.kind === 'art') return renderArt(doc);
    if (doc.selection?.kind === 'anim') return;
    if (doc.selection?.kind === 'keyframe') return patchKeyframe(doc);
    const bone = boneById(doc, doc.selection?.id);
    if (!bone) return;
    const values = valuesOf(bone);
    for (const input of root.querySelectorAll('input[data-field]')) {
      const next = values[input.dataset.field];
      if (next === undefined) continue;
      if (input === document.activeElement) continue;   // don't fight the user
      if (String(input.value) !== String(next)) input.value = next;
    }
    updateReadout(doc, view, bone);
  }

  function render(doc, view) {
    const key = shapeOf(doc, view);
    if (key === shapeKey && key !== 'empty') {
      patchValues(doc, view);
      return;
    }
    shapeKey = key;

    root.replaceChildren();

    if (doc.selection?.kind === 'art') return renderArt(doc);
    if (doc.selection?.kind === 'anim') return renderAnimProps(doc);
    if (doc.selection?.kind === 'keyframe') return renderKeyframe(doc);

    const bone = boneById(doc, doc.selection?.id);
    if (!bone) {
      root.append(Object.assign(document.createElement('p'), {
        className: 'empty', textContent: 'Select a bone or a graphic.',
      }));
      return;
    }

    const edit = (fn) => store.update((d) => fn(boneById(d, bone.id)));
    const restMode = editsRest(view.mode);

    root.append(field('name', bone.name, (v) => edit((b) => { b.name = v; }), { type: 'text' }));
    root.append(refPicker(doc, bone, (ref) => edit((b) => { b.ref = ref; })));

    // rest configuration: editable in the modes that edit it
    const lock = (fieldName) => ({
      locked: isLocked(bone, fieldName),
      onToggle: (on) => edit((b) => { b.locked[fieldName] = on; }),
    });

    root.append(field('offset x', fmt(bone.offset.x),
      (v) => edit((b) => { b.offset.x = v; }),
      { step: '0.5', disabled: !restMode, lock: lock('offsetX') }));
    root.append(field('offset y', fmt(bone.offset.y),
      (v) => edit((b) => { b.offset.y = v; }),
      { step: '0.5', disabled: !restMode, lock: lock('offsetY') }));
    root.append(field('rest angle', fmt(bone.restAngle),
      (v) => edit((b) => { b.restAngle = wrapDeg(v); }),
      { disabled: !restMode, lock: lock('restAngle') }));
    root.append(field('pose delta', fmt(bone.poseAngle),
      (v) => edit((b) => { b.poseAngle = wrapDeg(v); }), { disabled: restMode }));
    root.append(field('length', fmt(bone.length),
      (v) => edit((b) => { b.length = Math.max(0, v); }),
      { step: '0.5', min: 0, disabled: !restMode, lock: lock('length') }));

    // --- ik -----------------------------------------------------------------
    // aim and reach are different promises, not a link count: aim points this
    // bone at the target, reach puts its tip on the target using this bone and
    // its parent. evaluated in pose; rest is what it solves from.
    const ikHead = document.createElement('h3');
    ikHead.className = 'section';
    ikHead.textContent = 'ik';
    root.append(ikHead);

    const kindRow = document.createElement('label');
    kindRow.className = 'field';
    kindRow.append(Object.assign(document.createElement('span'), { textContent: 'solve' }));
    const kindSel = document.createElement('select');
    for (const [value, label] of [
      // not "none": an unconstrained bone is still driven by something, namely
      // the pose angle. there is one angle, and either you set it or a solver
      // does -- naming the empty case after what actually drives it says so.
      ['', 'pose'],
      ['aim', 'aim (1 angle)'],
      ['reach', 'reach (2 angles)'],
      ['match', 'match (copy from target)'],
    ]) {
      kindSel.append(new Option(label, value, false, (bone.constraint?.kind ?? '') === value));
    }
    kindSel.onchange = () => edit((b) => {
      if (!kindSel.value) { b.constraint = null; return; }
      // keep the target when switching kinds, but rebuild the kind's own
      // fields so a match never inherits a stale bend, or vice versa
      const target = b.constraint?.target ?? null;
      b.constraint = makeConstraint(kindSel.value, target);
    });
    kindRow.append(kindSel);
    root.append(kindRow);

    if (bone.constraint) {
      // aim at anything a bone can hang off: a bone root, a bone tip, or an
      // art anchor. exclude whatever resolves through this chain -- a target
      // that resolves through what it drives is circular, and filtering the list beats
      // explaining the symptom later.
      const chain = [bone.id];
      if (bone.constraint.kind === 'reach' && bone.ref?.bone) chain.push(bone.ref.bone);

      const tRow = document.createElement('label');
      tRow.className = 'field';
      tRow.append(Object.assign(document.createElement('span'), { textContent: 'target' }));
      const tSel = document.createElement('select');
      const tOpts = [{ label: '(none)', value: '', ref: null },
        ...refOptions(doc, { exclude: (ref) => dependsOn(doc, ref, chain) })];
      const tCurrent = refValue(bone.constraint.target);
      for (const o of tOpts) tSel.append(new Option(o.label, o.value, false, o.value === tCurrent));
      tSel.onchange = () => edit((b) => {
        b.constraint.target = tOpts.find((o) => o.value === tSel.value)?.ref ?? null;
      });
      tRow.append(tSel);
      root.append(tRow);

      if (bone.constraint.kind === 'match') {
        // x/y are measured either along the scene axes or in the target's own
        // frame. local is what keeps an offset meaning the same thing after the
        // rig turns; world only does what you mean while it is axis-aligned.
        const spaceRow = document.createElement('label');
        spaceRow.className = 'field';
        spaceRow.append(Object.assign(document.createElement('span'), { textContent: 'x/y measured' }));
        const spaceSel = document.createElement('select');
        for (const [v, l] of [['local', 'in target’s frame'], ['world', 'along world axes']]) {
          spaceSel.append(new Option(l, v, false, (bone.constraint.space ?? 'local') === v));
        }
        spaceSel.onchange = () => edit((b) => { b.constraint.space = spaceSel.value; });
        spaceRow.append(spaceSel);
        root.append(spaceRow);

        // one row per component: take it or leave it, plus an offset.
        // anything unchecked simply isn't overridden, so it keeps whatever the
        // bone's normal placement gives it.
        const local = (bone.constraint.space ?? 'local') === 'local';
        for (const [key, label, step] of [
          ['x', local ? 'take x (forward)' : 'take x', '1'],
          ['y', local ? 'take y (lateral)' : 'take y', '1'],
          ['theta', 'take angle', '1'],
        ]) {
          const row2 = document.createElement('label');
          row2.className = 'field match-row';
          row2.append(Object.assign(document.createElement('span'), { textContent: label }));

          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'match-take';
          box.checked = bone.constraint.take?.[key] !== false;
          box.onchange = () => edit((b) => { b.constraint.take[key] = box.checked; });

          const off = document.createElement('input');
          off.type = 'number';
          off.step = step;
          off.className = 'match-offset';
          off.title = 'offset applied after taking the target’s value';
          off.value = fmt(bone.constraint.offset?.[key] ?? 0);
          off.disabled = !box.checked;
          off.onchange = () => edit((b) => { b.constraint.offset[key] = Number(off.value) || 0; });

          row2.append(box, off);
          root.append(row2);
        }
      }

      if (bone.constraint.kind === 'reach') {
        const bRow = document.createElement('label');
        bRow.className = 'field';
        bRow.append(Object.assign(document.createElement('span'), { textContent: 'bend' }));
        const bBtn = Object.assign(document.createElement('button'),
          { textContent: bone.constraint.bend >= 0 ? 'this way' : 'that way' });
        bBtn.title = 'the two solutions mirror about the root-to-target line';
        bBtn.onclick = () => edit((b) => { b.constraint.bend = b.constraint.bend >= 0 ? -1 : 1; });
        bRow.append(bBtn);
        root.append(bRow);
      }

      const problem = constraintProblem(doc, bone);
      if (problem) {
        root.append(Object.assign(document.createElement('p'),
          { className: 'warn', textContent: problem }));
      } else if (view.mode === 'rest') {
        root.append(Object.assign(document.createElement('p'),
          { className: 'note', textContent: 'not solved in rest — switch to solve to see it' }));
      }
    }

    const actions = document.createElement('div');
    actions.className = 'row';

    // `refOf` decides what the new bone hangs off: a child of this bone, or --
    // for a sibling -- whatever THIS bone hangs off.
    const add = (label, refOf, title) => {
      const btn = Object.assign(document.createElement('button'), { textContent: label });
      btn.title = title;
      btn.onclick = () => store.update((d) => {
        const n = d.nextId++;
        const self = boneById(d, bone.id);
        d.bones.push(makeBone(`b${n}`, `bone${n}`, refOf(self), 40));
        d.selection = { kind: 'bone', id: `b${n}` };
      });
      return btn;
    };

    // A sibling shares this bone's PARENT FRAME, which is not the same as
    // hanging off this bone. Attaching to a bone's root inherits that bone's
    // own rotation; attaching where it attaches does not. So two limbs off one
    // joint are siblings -- bending one must not drag the other -- while a
    // muzzle flash belongs on the barrel's root, turning with it.
    //
    // Copying the ref verbatim also handles the cases a picker makes fiddly:
    // a sibling of a root bone is another root, and a sibling of a bone on an
    // art anchor lands on the same anchor.
    actions.append(
      add('+ sibling', (b) => (b?.ref ? { ...b.ref } : null),
        'hangs off whatever this bone hangs off — shares its parent frame, so '
        + 'rotating this bone does not move the new one'),
      add('+ at tip', () => ({ bone: bone.id, end: 'tip' }),
        'hangs off this bone’s tip, so it tracks this length instead of '
        + 'snapshotting a position'),
      add('+ at root', () => ({ bone: bone.id, end: 'root' }),
        'hangs off this bone’s root, independent of its length — and inherits '
        + 'this bone’s rotation, so rotating this bone turns it too'),
    );
    root.append(actions);

    const dl = document.createElement('dl');
    dl.className = 'readout';
    root.append(dl);
    updateReadout(doc, view, bone);
  }

  // computed readout, from whichever skeleton is being edited
  function updateReadout(doc, view, bone) {
    const dl = root.querySelector('.readout');
    if (!dl) return;
    const restMode = editsRest(view.mode);
    // anim mode reads the baked pose, matching what the canvas draws and what
    // the engine will play
    const deltas = view.mode === 'anim' ? poseAt(doc, view.frame ?? 0) : null;
    const opts = frameOpts(view.mode, deltas);
    const { frames } = resolveFrames(doc, opts);
    const f = frames.get(boneKey(bone.id, 'root'));
    const tip = frames.get(boneKey(bone.id, 'tip'));

    dl.replaceChildren();
    if (!f) return;
    const rows = [
      [{ rest: 'rest pos', solve: 'solved pos', pose: 'posed pos', anim: 'posed pos' }[view.mode]
        ?? 'pos', `${fmt(f.pos.x)}, ${fmt(f.pos.y)}`],
      ['direction', `${fmt(wrapDeg(f.angle))}°`],
    ];
    if (tip && hasExtent(bone)) rows.push(['tip', `${fmt(tip.pos.x)}, ${fmt(tip.pos.y)}`]);
    for (const [k, v] of rows) {
      dl.append(
        Object.assign(document.createElement('dt'), { textContent: k }),
        Object.assign(document.createElement('dd'), { textContent: v }),
      );
    }
  }

  // a graphic places itself on an anchor; it has no rest/pose of its own,
  // so this panel is the same in either mode
  function renderArt(doc) {
    const item = artById(doc, doc.selection.id);
    root.replaceChildren();
    if (!item) return;

    const edit = (fn) => store.update((d) => fn(artById(d, item.id)));

    root.append(field('name', item.name, (v) => edit((a) => { a.name = v; }), { type: 'text' }));

    // art attaches by a ref like everything else: a bone root, a bone TIP --
    // which carries the bone's angle, so no helper bone is needed at the far
    // end -- or another art's anchor.
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(Object.assign(document.createElement('span'), { textContent: 'attached to' }));
    const sel = document.createElement('select');
    const opts = [{ label: '(world)', value: '', ref: null },
      ...refOptions(doc, { exclude: (ref) => dependsOnArt(doc, ref, item.id) })];
    const current = refValue(item.ref);
    for (const o of opts) sel.append(new Option(o.label, o.value, false, o.value === current));
    sel.onchange = () => edit((a) => {
      a.ref = opts.find((o) => o.value === sel.value)?.ref ?? null;
    });
    wrap.append(sel);
    root.append(wrap);

    root.append(field('offset x', fmt(item.offset.x), (v) => edit((a) => { a.offset.x = v; }), { step: '0.5' }));
    root.append(field('offset y', fmt(item.offset.y), (v) => edit((a) => { a.offset.y = v; }), { step: '0.5' }));
    root.append(field('angle', fmt(item.angle), (v) => edit((a) => { a.angle = wrapDeg(v); })));

    // Uniform display scale, for art that wasn't drawn at a consistent size.
    // Deliberately isolated: it is not computed from anything and nothing is
    // computed from it. Anchors stay in the image's own coordinates.
    const scaleRow = document.createElement('label');
    scaleRow.className = 'field scale-field';
    scaleRow.append(Object.assign(document.createElement('span'), { textContent: 'scale' }));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.1';
    slider.max = '4';
    slider.step = '0.01';
    slider.value = item.scale ?? 1;

    const readout = document.createElement('input');
    readout.type = 'number';
    readout.step = '0.01';
    readout.min = '0.01';
    readout.dataset.field = 'scale';
    readout.className = 'scale-value';
    readout.value = fmt(item.scale ?? 1);

    // dragging coalesces into one undo entry; typing commits its own
    slider.oninput = () => {
      readout.value = fmt(Number(slider.value));
      store.update((d) => { artById(d, item.id).scale = Number(slider.value); },
        { coalesce: `scale:${item.id}` });
    };
    slider.onchange = () => store.endGesture();
    readout.onchange = () => {
      const v = Math.max(0.01, Number(readout.value) || 1);
      slider.value = String(Math.min(4, Math.max(0.1, v)));
      edit((a) => { a.scale = v; });
    };

    scaleRow.append(slider, readout);
    root.append(scaleRow);

    // --- anchors ------------------------------------------------------------
    // just named points. which one acts as origin or direction is a property
    // of THIS binding, not of the anchor and not of the file -- so the same
    // art bound twice can use different anchors for different roles.
    const rolePicker = (label, current, key) => {
      const wrap = document.createElement('label');
      wrap.className = 'field';
      wrap.append(Object.assign(document.createElement('span'), { textContent: label }));
      const s2 = document.createElement('select');
      s2.append(new Option('(none)', '', false, !current));
      for (const a of item.anchors ?? []) {
        s2.append(new Option(a.name, a.name, false, a.name === current));
      }
      s2.onchange = () => edit((a) => { a[key] = s2.value || null; });
      s2.disabled = !(item.anchors ?? []).length;
      wrap.append(s2);
      return wrap;
    };

    const head = document.createElement('h3');
    head.className = 'section';
    head.textContent = 'anchors';
    root.append(head);

    root.append(rolePicker('origin', item.origin, 'origin'));
    root.append(rolePicker('direction', item.direction, 'direction'));

    const list = document.createElement('div');
    list.className = 'anchor-list';
    for (const a of item.anchors ?? []) {
      const row = document.createElement('div');
      row.className = 'anchor-row';

      const nm = document.createElement('input');
      nm.type = 'text';
      nm.value = a.name;
      nm.className = 'anchor-name';
      nm.onchange = () => {
        const next = nm.value.trim();
        if (!next) { nm.value = a.name; return; }
        store.update((d) => {
          const it = artById(d, item.id);
          if (!it || (next !== a.name && anchorNamed(it, next))) return;   // no duplicates
          const target = anchorNamed(it, a.name);
          if (!target) return;
          // a rename must carry the roles with it, since roles refer by name
          if (it.origin === a.name) it.origin = next;
          if (it.direction === a.name) it.direction = next;
          target.name = next;
        });
      };

      const del = Object.assign(document.createElement('button'),
        { textContent: '\u00d7', className: 'anchor-del', title: 'delete anchor' });
      del.onclick = () => store.update((d) => {
        const it = artById(d, item.id);
        if (!it) return;
        it.anchors = it.anchors.filter((n) => n.name !== a.name);
        if (it.origin === a.name) it.origin = null;
        if (it.direction === a.name) it.direction = null;
      });

      row.append(nm, del);
      list.append(row);
    }
    if (!(item.anchors ?? []).length) {
      list.append(Object.assign(document.createElement('p'),
        { className: 'empty', textContent: 'None. Add one, then drag it onto the graphic.' }));
    }
    root.append(list);

    const anchorActions = document.createElement('div');
    anchorActions.className = 'row';
    const addAnchor = Object.assign(document.createElement('button'),
      { textContent: '+ anchor' });
    addAnchor.title = 'drops one at the graphic\u2019s origin \u2014 drag it into place';
    addAnchor.onclick = () => store.update((d) => {
      const it = artById(d, item.id);
      if (!it) return;
      let n = it.anchors.length + 1;
      while (anchorNamed(it, `anchor${n}`)) n += 1;
      it.anchors.push({ name: `anchor${n}`, x: 0, y: 0 });
    });
    const dlBtn = Object.assign(document.createElement('button'),
      { textContent: 'download .svg' });
    dlBtn.title = 'writes the anchor group back into the file, artwork untouched';
    dlBtn.onclick = () => onDownload?.(item.id);
    anchorActions.append(addAnchor, dlBtn);
    root.append(anchorActions);

    const actions = document.createElement('div');
    actions.className = 'row';

    const vis = Object.assign(document.createElement('button'),
      { textContent: item.visible ? 'hide' : 'show' });
    vis.onclick = () => edit((a) => { a.visible = !a.visible; });

    const del = Object.assign(document.createElement('button'), { textContent: 'remove' });
    del.onclick = () => store.update((d) => {
      d.art = d.art.filter((a) => a.id !== item.id);
      d.selection = null;
    });

    actions.append(vis, del);
    root.append(actions);

    const dl = document.createElement('dl');
    dl.className = 'readout';
    for (const [k, v] of [
      ['file', item.filename],
      ['z-order', `${doc.art.indexOf(item) + 1} of ${doc.art.length}`],
    ]) {
      dl.append(
        Object.assign(document.createElement('dt'), { textContent: k }),
        Object.assign(document.createElement('dd'), { textContent: v }),
      );
    }
    root.append(dl);
  }

  function renderAnimProps(doc) {
    const anim = animById(doc, doc.selection.id);
    root.replaceChildren();
    if (!anim) return;

    const edit = (fn) => store.update((d) => fn(animById(d, anim.id)));

    root.append(field('name', anim.name, (v) => edit((a) => { a.name = v; }), { type: 'text' }));

    const typeRow = document.createElement('label');
    typeRow.className = 'field';
    typeRow.append(Object.assign(document.createElement('span'), { textContent: 'type' }));
    const typeSel = document.createElement('select');
    for (const [v, l] of [['forward', 'forward loop'], ['backandforth', 'back & forth'], ['oneshot', 'one-shot']]) {
      typeSel.append(new Option(l, v, false, anim.type === v));
    }
    typeSel.onchange = () => edit((a) => {
      a.type = typeSel.value;
      ensureEndpoints(a);
    });
    typeRow.append(typeSel);
    root.append(typeRow);

    // shortening drops the keys that fall off the end, then re-supplies
    // whichever endpoints the type still requires
    root.append(field('length', anim.length, (v) => edit((a) => {
      setLength(a, v);
    }), { min: 2 }));

    const info = document.createElement('p');
    info.className = 'note';
    const endReq = needsEndFrame(anim.type);
    info.textContent = endReq
      ? `start (frame 0) and end (frame ${anim.length - 1}) are mandatory`
      : 'start (frame 0) is mandatory; wraps back to start';
    root.append(info);

    const actions = document.createElement('div');
    actions.className = 'row';
    const del = Object.assign(document.createElement('button'), { textContent: 'delete' });
    del.onclick = () => store.update((d) => {
      d.animations = d.animations.filter((a) => a.id !== anim.id);
      d.selection = null;
    });
    actions.append(del);
    root.append(actions);

    const dl = document.createElement('dl');
    dl.className = 'readout';
    dl.append(
      Object.assign(document.createElement('dt'), { textContent: 'keyframes' }),
      Object.assign(document.createElement('dd'), { textContent: String(anim.keyframes.length) }),
    );
    root.append(dl);
  }

  // same in-place patch the bone inspector uses: keep the typed-in field alone,
  // but let undo and scrubbing write through to everything else
  function patchKeyframe(doc) {
    const sel = doc.selection;
    const kf = animById(doc, sel.animId)?.keyframes.find((k) => k.frame === sel.frame);
    if (!kf) return;
    for (const input of root.querySelectorAll('input[data-field]')) {
      const [boneId, part] = input.dataset.field.split(':');
      const next = kf.deltas[boneId]?.[part];
      if (next === undefined) continue;
      if (input === document.activeElement) continue;
      if (String(input.value) !== String(fmt(next))) input.value = fmt(next);
    }
  }

  function renderKeyframe(doc) {
    const sel = doc.selection;
    const anim = animById(doc, sel.animId);
    const kf = anim?.keyframes.find((k) => k.frame === sel.frame);
    root.replaceChildren();
    if (!anim || !kf) return;

    const head = document.createElement('h3');
    head.className = 'section';
    head.textContent = `${anim.name} · frame ${kf.frame}`;
    root.append(head);

    const isStart = kf.frame === 0;
    const isEnd = needsEndFrame(anim.type) && kf.frame === anim.length - 1;
    if (isStart || isEnd) {
      root.append(Object.assign(document.createElement('p'),
        { className: 'note', textContent: isStart ? 'start pose (mandatory)' : 'end pose (mandatory)' }));
    }

    // Which segment this key owns. On a forward loop the last key's outgoing
    // segment is the wrap back to frame 0 -- the one the stored values cannot
    // describe, since both ends are fixed.
    const keys = anim.keyframes;
    const isLast = keys[keys.length - 1]?.frame === kf.frame;
    const wraps = isLast && anim.type === 'forward';
    const hasSegment = wraps || !isLast;

    const editKf = (fn) => store.update((d) => {
      const a = animById(d, sel.animId);
      const k = a?.keyframes.find((x) => x.frame === sel.frame);
      if (k) fn(k);
    });

    // angles are directions, so a segment carries a ROTATION -- the stored
    // values only say where its ends point, and which way round is a choice
    if (hasSegment) {
      const turnRow = document.createElement('label');
      turnRow.className = 'field';
      turnRow.append(Object.assign(document.createElement('span'),
        { textContent: wraps ? 'rotate to start' : 'rotate to next' }));
      const sel2 = document.createElement('select');
      sel2.title = 'how angles travel across this segment. increasing is '
        + 'clockwise on screen. a forced direction between equal angles is a '
        + 'full revolution.';
      for (const [v, l] of [
        ['auto', 'short way round'], ['inc', 'increasing (cw)'], ['dec', 'decreasing (ccw)'],
      ]) {
        sel2.append(new Option(l, v, false, (kf.turn ?? 'auto') === v));
      }
      sel2.onchange = () => editKf((k) => { k.turn = sel2.value; });
      turnRow.append(sel2);
      root.append(turnRow);
    }

    // per-bone delta editors, in three tiers:
    //
    //   0  has a delta in THIS keyframe
    //   1  touched by some other keyframe in this animation -- empty here, but
    //      near the top and ready to fill
    //   2  everything else
    //
    // Tier 1 is the point. Sorting per keyframe alone made a bone you posed at
    // frame 0 sink back into the full list at frame 9, so the rows moved under
    // you as you walked along a lane. Tiering by the whole animation holds them
    // still: the bones an animation cares about stay together in every one of
    // its keyframes.
    //
    // sort is stable, so bones keep hierarchy order within a tier.
    const touched = new Set();
    for (const k of anim.keyframes) for (const id of Object.keys(k.deltas)) touched.add(id);
    const tier = (b) => (kf.deltas[b.id] ? 0 : touched.has(b.id) ? 1 : 2);
    for (const bone of [...doc.bones].sort((x, y) => tier(x) - tier(y))) {
      const d = kf.deltas[bone.id];

      const boneHead = document.createElement('div');
      boneHead.className = 'field';
      boneHead.append(Object.assign(document.createElement('span'),
        { textContent: bone.name, style: 'font-weight: bold' }));

      if (d) {
        const rm = Object.assign(document.createElement('button'),
          { textContent: '×', className: 'anchor-del', title: 'remove from this keyframe' });
        rm.onclick = () => editKf((k) => { delete k.deltas[bone.id]; });
        boneHead.append(rm);
        root.append(boneHead);

        root.append(field('Δ angle', fmt(d.angle),
          (v) => editKf((k) => { k.deltas[bone.id].angle = v; }),
          { step: '1', key: `${bone.id}:angle` }));
        root.append(field('Δ offset x', fmt(d.offsetX),
          (v) => editKf((k) => { k.deltas[bone.id].offsetX = v; }),
          { step: '0.5', key: `${bone.id}:offsetX` }));
        root.append(field('Δ offset y', fmt(d.offsetY),
          (v) => editKf((k) => { k.deltas[bone.id].offsetY = v; }),
          { step: '0.5', key: `${bone.id}:offsetY` }));
      } else {
        const add = Object.assign(document.createElement('button'),
          { textContent: '+',
            title: touched.has(bone.id)
              ? 'add delta — this bone is animated in another keyframe here'
              : 'add delta for this bone' });
        add.onclick = () => editKf((k) => { k.deltas[bone.id] = makeDelta(); });
        boneHead.append(add);
        root.append(boneHead);
      }
    }

    if (!doc.bones.length) {
      root.append(Object.assign(document.createElement('p'),
        { className: 'empty', textContent: 'No bones in the rig.' }));
    }

    // delete keyframe (unless it's a mandatory endpoint)
    const canDelete = !isStart && !isEnd;
    if (canDelete) {
      const actions = document.createElement('div');
      actions.className = 'row';
      const del = Object.assign(document.createElement('button'), { textContent: 'delete keyframe' });
      del.onclick = () => store.update((d) => {
        const a = animById(d, sel.animId);
        if (!a) return;
        a.keyframes = a.keyframes.filter((k) => k.frame !== sel.frame);
        d.selection = { kind: 'anim', id: anim.id };
      });
      actions.append(del);
      root.append(actions);
    }
  }

  store.subscribe(render);

  return {
    focusName() {
      const input = root.querySelector('input[data-field="name"]');
      if (!input) return;
      input.focus();
      input.select();
    },
  };
}

// art in scene. the list's ORDER is the z-order -- top of the list is nearest
// the viewer, the way a layers panel reads. there is deliberately no "assets
// not in scene" state: if it is listed, it is in the scene.
export function createArtList(root, store, { onRename } = {}) {
  function render(doc) {
    root.replaceChildren();
    const art = doc.art ?? [];

    if (!art.length) {
      root.append(Object.assign(document.createElement('p'), {
        className: 'empty', textContent: 'Drop SVG files here.',
      }));
      return;
    }

    art.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'art-row' + (selArt(doc, item.id) ? ' selected' : '')
        + (item.visible ? '' : ' hidden-item');

      const name = document.createElement('button');
      name.className = 'art-name';
      name.textContent = item.name;
      name.title = item.filename;
      const select = () => store.update((d) => { d.selection = { kind: 'art', id: item.id }; });
      name.onclick = select;
      name.ondblclick = () => { select(); onRename?.(); };
      row.append(name);

      const move = (delta) => {
        const btn = document.createElement('button');
        btn.className = 'art-move';
        btn.textContent = delta < 0 ? '▲' : '▼';
        btn.title = delta < 0 ? 'bring forward' : 'send back';
        btn.disabled = delta < 0 ? i === 0 : i === art.length - 1;
        btn.onclick = (e) => {
          e.stopPropagation();
          store.update((d) => {
            const from = d.art.findIndex((a) => a.id === item.id);
            const to = from + delta;
            if (to < 0 || to >= d.art.length) return;
            const [moved] = d.art.splice(from, 1);
            d.art.splice(to, 0, moved);
          });
        };
        return btn;
      };
      row.append(move(-1), move(1));
      root.append(row);
    });
  }
  store.subscribe(render);
}

export function createAnimList(root, store) {
  function render(doc) {
    root.replaceChildren();
    const anims = doc.animations ?? [];

    if (!anims.length) {
      root.append(Object.assign(document.createElement('p'), {
        className: 'empty', textContent: 'No animations. Click + to add one.',
      }));
      return;
    }

    for (const anim of anims) {
      const row = document.createElement('div');
      row.className = 'anim-row' + (selAnim(doc, anim.id) ? ' selected' : '');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'anim-active';
      check.checked = anim.active;
      check.title = 'show in swim lanes';
      check.onclick = (e) => e.stopPropagation();
      check.onchange = () => store.update((d) => {
        const a = animById(d, anim.id);
        if (a) a.active = check.checked;
      });

      const name = document.createElement('button');
      name.className = 'anim-name';
      name.textContent = anim.name;
      name.title = `${anim.type} · ${anim.length} frames`;
      name.onclick = () => store.update((d) => {
        d.selection = { kind: 'anim', id: anim.id };
      });

      row.append(check, name);
      root.append(row);
    }
  }
  store.subscribe(render);
}
