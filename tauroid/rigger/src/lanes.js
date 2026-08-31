// swim lanes: one row per active animation, plus a shared ruler.
//
// every lane is drawn at the same pixels-per-frame, so frame N is the same
// column in every row and the playhead is a single line across all of them.
// each lane is only as wide as its OWN length -- it loops on its own period,
// and the faint repeat marks show where it comes back around. the ruler spans
// the metaloop, which is just the lcm of those periods and is never authored.

import {
  needsEndFrame, windowLength, metaloopLength, loopPeriod, makeKeyframe,
  tickStep,
} from './animation.js';

const LABEL_W = 110;
const MAX_PX = 16;    // never zoom in past this, however short the window
const MIN_PX = 4;     // below this the dots stop being clickable, so scroll

// The window is sized to the longest lane, then fitted to whatever room the
// pane has. Frames-to-pixels is one number shared by every row, which is what
// makes a column mean the same frame in all of them.
function pxPerFrame(root, frames) {
  const room = root.clientWidth - LABEL_W - 8;
  if (!(room > 0) || !(frames > 0)) return MAX_PX;
  return Math.max(MIN_PX, Math.min(MAX_PX, room / frames));
}

// Everything that decides WHICH elements exist. The playhead moving is not in
// here on purpose: rebuilding on every frame would destroy the element holding
// the drag's pointer capture -- which is exactly what made scrubbing land its
// first click and then die -- and would rebuild the whole pane 60 times a
// second during playback.
function structureOf(doc, view, anims, px) {
  const sel = doc.selection;
  const selKey = sel?.kind === 'keyframe' ? `${sel.animId}@${sel.frame}`
    : (sel?.kind === 'anim' ? `a:${sel.id}` : '-');
  const lanes = anims.map((a) => `${a.id}:${a.name}:${a.type}:${a.length}:`
    + a.keyframes.map((k) => `${k.frame}/${Object.keys(k.deltas).length}`).join(','));
  return `${view.mode}|${px.toFixed(3)}|${selKey}|${lanes.join('|')}`;
}

export function createLanes(root, store) {
  let structKey = null;
  let head = null;
  let frameLabel = null;
  let last = null;          // for re-rendering on resize

  function render(doc, view) {
    last = { doc, view };
    const anims = (doc.animations ?? []).filter((a) => a.active);
    if (view.mode !== 'anim' || !anims.length) {
      root.hidden = true;
      structKey = null;
      return;
    }
    root.hidden = false;

    const frames = windowLength(doc);
    const px = pxPerFrame(root, frames);
    const frame = view.frame ?? 0;
    const key = structureOf(doc, view, anims, px);

    const placeHead = () => {
      if (!head) return;
      // the clock runs past the window, so the line sweeps it repeatedly.
      // this wrap is COSMETIC -- the pose comes from absolute time, so nothing
      // jumps when the line returns to the left edge.
      const at = frames > 0 ? ((frame % frames) + frames) % frames : 0;
      head.style.left = `${LABEL_W + at * px}px`;
      if (frameLabel) frameLabel.textContent = `frame ${Math.round(frame)}`;
    };

    // only the playhead moved -- patch it and leave the DOM alone
    if (key === structKey) { placeHead(); return; }
    structKey = key;

    root.replaceChildren();
    const width = frames * px;

    // the window is a viewing range; the metaloop is a fact about the lanes.
    // they are different numbers and only one of them is load-bearing.
    const cycle = metaloopLength(doc);
    const r = ruler(frames, width, px, store,
      cycle ? `window ${frames} frames · lanes realign every ${cycle}`
        : `window ${frames} frames · nothing here repeats`);
    frameLabel = r.querySelector('.lane-label');
    root.append(r);
    for (const anim of anims) root.append(lane(doc, anim, frames, px, store));

    // one playhead for the whole stack, so lanes of different lengths are
    // unambiguously being read at the same instant
    head = document.createElement('div');
    head.className = 'playhead';
    root.append(head);
    placeHead();
  }

  store.subscribe(render);

  // px-per-frame is derived from the pane's own width, so geometry has to be
  // recomputed whenever that changes -- including the FIRST time it becomes
  // non-zero, which happens after the initial render. A window resize listener
  // misses that, and the lanes would sit at fallback zoom until something else
  // nudged them.
  new ResizeObserver(() => {
    if (!last || root.hidden) return;
    structKey = null;
    render(last.doc, last.view);
  }).observe(root);
}

function ruler(frames, width, px, store, title) {
  const row = document.createElement('div');
  row.className = 'lane-ruler';

  const label = document.createElement('div');
  label.className = 'lane-label';
  label.title = title;
  row.append(label);

  const track = document.createElement('div');
  track.className = 'ruler-track';
  track.style.width = `${width}px`;

  // keep ticks about 60px apart whatever the zoom, so they stay readable
  for (let f = 0, step = tickStep(frames, Math.max(2, width / 60)); f <= frames; f += step) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = `${f * px}px`;
    tick.textContent = String(f);
    track.append(tick);
  }

  // Scrub: press and drag anywhere on the ruler.
  //
  // The move/up listeners go on WINDOW, not on the track, and the track's
  // geometry is snapshotted at pointerdown -- the same trick the art-anchor
  // drag uses. Element-bound capture would be lost the moment anything
  // rebuilt this row, and the drag would silently stop after its first frame.
  track.onpointerdown = (e) => {
    e.preventDefault();
    const left = track.getBoundingClientRect().left;
    const scrub = (ev) => {
      const f = (ev.clientX - left) / px;
      store.setView((v) => {
        v.playing = false;   // grabbing the playhead takes it off autopilot
        // scrubbing lands INSIDE the window: the clock is free-running, so
        // this sets the time rather than seeking within a loop
        v.frame = Math.max(0, Math.min(frames, Math.round(f)));
      });
    };
    const stop = () => {
      window.removeEventListener('pointermove', scrub);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', scrub);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    scrub(e);
  };

  row.append(track);
  return row;
}

function lane(doc, anim, frames, px, store) {
  const row = document.createElement('div');
  row.className = 'swim-lane';

  const label = document.createElement('div');
  label.className = 'lane-label';
  label.textContent = anim.name;
  label.title = `${anim.type} · ${anim.length} frames`;
  label.onclick = () => store.update((d) => { d.selection = { kind: 'anim', id: anim.id }; });
  row.append(label);

  // the full metaloop width, so repeats can be marked, with the animation's
  // own extent drawn as the live part
  const track = document.createElement('div');
  track.className = 'lane-track';
  track.style.width = `${frames * px}px`;

  // a one-shot has no period: it runs to its last frame and holds there
  const period = loopPeriod(anim);
  const extent = period ?? (anim.length - 1);

  const live = document.createElement('div');
  live.className = 'lane-extent' + (period ? '' : ' once');
  live.style.width = `${extent * px}px`;
  live.title = period ? `repeats every ${period} frames` : 'plays once, then holds';
  track.append(live);

  // where this lane comes back around -- the reason the metaloop is longer
  // than any one animation. a one-shot never does, so it gets no marks.
  // capped: across a long metaloop these are wallpaper, not information.
  if (period) {
    for (let f = period; f < frames; f += period) {
      const mark = document.createElement('div');
      mark.className = 'lane-repeat';
      mark.style.left = `${f * px}px`;
      track.append(mark);
    }
  }

  for (const kf of anim.keyframes) {
    const dot = document.createElement('div');
    dot.className = 'keyframe-dot';
    if (kf.frame === 0 || (needsEndFrame(anim.type) && kf.frame === anim.length - 1)) {
      dot.classList.add('endpoint');
    }
    if (doc.selection?.kind === 'keyframe'
      && doc.selection.animId === anim.id
      && doc.selection.frame === kf.frame) {
      dot.classList.add('selected');
    }

    const posed = Object.keys(kf.deltas).length;
    dot.style.left = `${kf.frame * px}px`;
    dot.title = `frame ${kf.frame} · ${posed} bone${posed === 1 ? '' : 's'}`;
    dot.onclick = (e) => {
      e.stopPropagation();
      // selecting a key moves the playhead to it, so the viewport shows the
      // pose being edited rather than whatever frame was last scrubbed to
      store.setView((v) => { v.frame = kf.frame; });
      store.update((d) => {
        d.selection = { kind: 'keyframe', animId: anim.id, frame: kf.frame };
      });
    };
    track.append(dot);
  }

  // click empty track to key at that frame -- within the animation's own
  // extent only, since a key past its length would never be reached
  track.onclick = (e) => {
    if (e.target !== track && e.target !== live) return;
    const rect = track.getBoundingClientRect();
    const f = Math.round((e.clientX - rect.left) / px);
    if (f < 0 || f > anim.length - 1) return;

    store.setView((v) => { v.frame = f; });
    store.update((d) => {
      const a = d.animations.find((x) => x.id === anim.id);
      if (!a) return;
      if (!a.keyframes.some((k) => k.frame === f)) {
        a.keyframes.push(makeKeyframe(f));
        a.keyframes.sort((x, y) => x.frame - y.frame);
      }
      d.selection = { kind: 'keyframe', animId: anim.id, frame: f };
    });
  };

  row.append(track);
  return row;
}
